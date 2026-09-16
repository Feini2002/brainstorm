import { expect, gotoInbox, test } from './support/fixtures';
import { authHeaders, captureViaUi, findItemIdViaApi, uniqueText } from './support/harness';
import { E2E_ORIGIN } from './support/env';
import {
  ensureLlmConfigured,
  restoreLlmSettings,
  writeScript,
} from './support/gomindmap';
import type { Page } from '@playwright/test';

/**
 * 脑图第一次生成的入口（T055 × T078-R01/R02/C03 的回归守卫）。
 *
 * 这个文件存在的理由是一个**真实走不通的用户旅程**，不是一条新功能：
 *
 *   选择条上的「生成思维导图」（`SelectionTray`）把人送到 `/mindmap`，脑图页自己的空态
 *   也写着「再从选择条进入这里生成」——但那个页面只有**读**的一半（打开已保存的脑图）和
 *   T059 的 `RegenerateAction`（「按当前来源重新生成」，只在已有视图时才出现）。结果是
 *   一个全新的库根本造不出第一张脑图：链接有承诺，页面没有动作。
 *   `docs/02_architecture/03_ui_information_design.md` §5 已经写明两页共享
 *   `GenerateAction`；Flow 有（`FlowIntentForm`），Mindmap 没有。
 *
 * 所以本文件断言的是**按钮真的存在并能真的落库**，而不是「页面上有这段文案」：
 *
 *  1. 先从真实入口走一遍（收藏→勾选→选择条→脑图页），证明入口可达；
 *  2. 点「生成脑图」走**生产**生成路由：请求、适配器、事务、入库都是真的，只有对外的
 *     那次 HTTP 用 `BRAIN_SCRIPTED_PROVIDER` 的固定答案替换（与 `gate4.spec.ts` 同一
 *     套装置，不是另造一个假路由——T011-C03 禁止测试专用端点）；
 *  3. 生成后按 id 读回服务端，证明写入的是数据库而不是 React 内存；
 *  4. 空选择时按钮不可点且给出原因，并且**不发出任何生成请求**——T078-C03「不是弹一个
 *     成功 toast」，反过来说也不能用一个灰按钮假装入口存在。
 *
 * 基线：每条用例自己新建记录与视图，按自己的文本与返回的 id 定位；用例结束后用产品自己的
 * `DELETE` 路由归还，所以共享库里累积的其它数据不会改变这里的断言，这里也不改变别人的。
 */

/** 本文件造出来的条目与视图，供 `afterEach` 归还数据库。 */
const createdItemIds: string[] = [];
const createdViewIds: string[] = [];

const SCRIPTED_TITLE = '生成入口回归';

/**
 * 用真实入口造出两张记录，并返回它们的 id。
 *
 * 走 UI 而不是直接 `POST /api/items`：本文件证明的正是「用户从收件箱开始、经资料库
 * 勾选、经选择条进入脑图页」这条链，绕开其中任何一段都会把要检查的联动换成 fixture。
 */
async function captureViaInbox(page: Page, prefix: string): Promise<{ text: string; id: string }> {
  const text = uniqueText(prefix);
  await captureViaUi(page, text);
  const id = await findItemIdViaApi(page, text);
  createdItemIds.push(id);
  return { text, id };
}

/** 从资料库勾选两条，经选择条进入脑图页——原来走不通的那一段。 */
async function selectTwoAndOpenMindmap(
  page: Page,
  first: { text: string },
  second: { text: string },
): Promise<void> {
  await page.getByRole('link', { name: '资料库' }).click();
  await expect(page.getByTestId('library-search')).toBeVisible();

  await page
    .getByTestId('knowledge-card')
    .filter({ hasText: first.text })
    .getByTestId('card-select')
    .check();
  await page
    .getByTestId('knowledge-card')
    .filter({ hasText: second.text })
    .getByTestId('card-select')
    .check();
  await expect(page.getByTestId('selection-count')).toContainText('已选 2');

  await page.getByTestId('selection-to-mindmap').click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
}

/** 读回一张视图，用于「写的是数据库而不是内存」的断言。 */
async function readView(
  page: Page,
  headers: Record<string, string>,
  viewId: string,
): Promise<{
  kind: string;
  content: { nodes: { id: string; label: string }[] };
  sourceSnapshot: { items: { id: string }[] };
  contentHash: string | null;
}> {
  const response = await page.request.get(`${E2E_ORIGIN}/api/views/${viewId}`, { headers });
  expect(response.status(), `GET /api/views/${viewId} 应返回 200`).toBe(200);
  const envelope = (await response.json()) as { data: never };
  return envelope.data;
}

test.describe('脑图第一次生成的入口', () => {
  /**
   * 把一个模型连接还原成用例组开始时的状态。
   *
   * 本文件是全套 e2e 里第二个会写入连接设置的 spec（另一个是 `gate4.spec.ts`），而
   * `mindmap-regeneration` / `offline-crud` 等用例断言的正是「没有配置模型时仍然可用」。
   * 留下一个已存的 Key 不会让它们直接变红，却会把它们悄悄挪到另一条分支上——那是真实的
   * 回归，不是外观问题。所以这里用产品自己的设置路由把它写回去，与 T061 同一套做法。
   */
  test.afterAll(async () => {
    await restoreLlmSettings();
  });

  /** 归还本文件造出来的视图与条目，用产品自己的删除路径。 */
  test.afterEach(async ({ page }) => {
    const headers = await authHeaders(page);
    for (const viewId of createdViewIds.splice(0)) {
      const current = await page.request.get(`${E2E_ORIGIN}/api/views/${viewId}`, { headers });
      if (current.status() !== 200) continue;
      const envelope = (await current.json()) as { data: { revision: number } };
      await page.request.delete(`${E2E_ORIGIN}/api/views/${viewId}`, {
        headers,
        data: { expectedRevision: envelope.data.revision },
      });
    }
    for (const itemId of createdItemIds.splice(0)) {
      const current = await page.request.get(`${E2E_ORIGIN}/api/items/${itemId}`, { headers });
      if (current.status() !== 200) continue;
      const envelope = (await current.json()) as { data: { revision: number } };
      await page.request.delete(`${E2E_ORIGIN}/api/items/${itemId}`, {
        headers,
        data: { expectedRevision: envelope.data.revision },
      });
    }
  });

  test('从选择条进入脑图页后能生成第一张脑图，并按 id 落库', async ({ page, traffic }) => {
    await gotoInbox(page);
    const first = await captureViaInbox(page, '生成入口-甲');
    const second = await captureViaInbox(page, '生成入口-乙');
    const headers = await authHeaders(page);

    await selectTwoAndOpenMindmap(page, first, second);

    // ---- 入口存在并且可用 ------------------------------------------------
    //
    // 这一段就是原来失败的地方：页面能打开，但没有可以按下「生成」的控件。
    const generateButton = page.getByTestId('mindmap-generate');
    await expect(generateButton, '脑图页必须有第一次生成的入口（T078-R01/R02）').toBeVisible();
    await expect(generateButton).toBeEnabled();
    await expect(page.getByTestId('mindmap-generate-count')).toContainText('已选 2');
    await expect(page.getByTestId('mindmap-generate-blocked')).toHaveCount(0);

    // 模型答案来自脚本文件：请求、适配器、事务、入库全是真的。
    const answer = JSON.stringify({
      title: SCRIPTED_TITLE,
      nodes: [
        { id: 'm1', parentId: null, label: SCRIPTED_TITLE, itemIds: [first.id], kind: 'group' },
        { id: 'm2', parentId: 'm1', label: '第一条材料', itemIds: [first.id], kind: 'note' },
        { id: 'm3', parentId: 'm1', label: '第二条材料', itemIds: [second.id], kind: 'note' },
      ],
    });
    await ensureLlmConfigured(headers);
    writeScript(answer);

    const generateRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/views/mindmap/generate')) generateRequests.push(request.url());
    });

    await generateButton.click();

    // 真实结果由服务端回答，不是前端自报成功。
    await expect(page.getByTestId('mindmap-generate-outcome')).toContainText('已经生成脑图', {
      timeout: 30_000,
    });
    expect(generateRequests.length, '点一次生成应只发出一次生成请求').toBe(1);

    // ---- 数据库那一端 ----------------------------------------------------
    //
    // 「保存」必须由按 id 的服务端读取证明；只看画布出现节点无法区分「写进 SQLite」与
    // 「只是这一次响应留在了 React state 里」（T078-C02 的同一要求）。
    const list = await page.request.get(`${E2E_ORIGIN}/api/views`, {
      headers,
      params: { kind: 'mindmap', limit: 50 },
    });
    expect(list.status(), 'GET /api/views 应返回 200').toBe(200);
    const envelope = (await list.json()) as { data: { views: { id: string }[] } };
    const newest = envelope.data.views[0];
    expect(newest, '生成后清单里应有一张脑图').toBeTruthy();
    const viewId = newest!.id;
    createdViewIds.push(viewId);

    const stored = await readView(page, headers, viewId);
    expect(stored.kind).toBe('mindmap');
    expect(stored.contentHash, '入库的视图应带内容哈希').not.toBeNull();
    expect(stored.content.nodes.map((node) => node.label)).toContain('第二条材料');
    // 快照是两条真实记录，不是页面拼出来的东西（T054-R01）。
    expect(stored.sourceSnapshot.items.map((entry) => entry.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );

    // 页面采用的是刚生成的这张，而不是停在空态。
    await expect(page.getByTestId('mindmap-outline')).toBeVisible();

    // 本用例没有碰过非回环主机，由 `traffic` fixture 在 teardown 兜底断言。
    expect(traffic.externalRequests()).toEqual([]);
  });

  test('没有选择时入口给出原因，且不发出生成请求', async ({ page }) => {
    await gotoInbox(page);

    // 无模型连接也不该影响这个分支：这里断言的是**本地守卫**，不是服务端拒绝。
    await restoreLlmSettings();

    const generateRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/views/mindmap/generate')) generateRequests.push(request.url());
    });

    await page.getByRole('link', { name: '脑图' }).click();
    await expect(page.getByTestId('mindmap-generate')).toBeVisible();

    // 选择条为空：按钮不可点，并且明说为什么，而不是留一个没有解释的灰按钮。
    await expect(page.getByTestId('mindmap-generate')).toBeDisabled();
    await expect(page.getByTestId('mindmap-generate-blocked')).toContainText('还没有选中材料');

    // 强点一次也不会绕过守卫（`disabled` 是给用户的提示，不是调用方的约束）。
    await page.getByTestId('mindmap-generate').click({ force: true });
    await page.waitForTimeout(300);
    expect(generateRequests, '空选择不得发出生成请求').toEqual([]);
    await expect(page.getByTestId('mindmap-generate-outcome')).toHaveCount(0);
  });
});
