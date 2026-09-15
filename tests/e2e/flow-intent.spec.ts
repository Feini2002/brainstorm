import { expect, gotoInbox, test } from './support/fixtures';
import {
  authHeaders,
  captureViaUi,
  deleteItemViaApi,
  findItemIdViaApi,
  uniqueText,
} from './support/harness';
import { E2E_ORIGIN } from './support/env';
import type { Page } from '@playwright/test';

/**
 * T062 验收｜流程视图意图输入与材料确认。
 *
 * 六条场景里有两类只能在这里证明，规格文件也点名了观察方法（DOM、请求参数、
 * 服务端读取结果）：
 *
 *  - **什么时候不产生请求**（C03）以及**空意图为什么不产生请求**（C02）。这两条
 *    是"费用与语义"的断言，用 `traffic` 记账 fixture 拿到**真实的请求列表**，不是
 *    "没有观察到错误"。（网络断言只覆盖页面自身发出的请求；测试自己的 API 调用
 *    不经过这个记账器。）
 *  - **删除一条来源之后会发生什么**（C05）。这一条必须走真实的删除路径：在收件箱
 *    勾选两条、在抽屉里删掉其中一条、再回到流程页提交。用种子数据伪造"缺失"就绕过
 *    了选择存储与抽屉的联动，而那正是这条用例要检查的东西。
 *
 * 另外，意图的**语义**不在这里判断：请求体里没有"强制因果"这类字段是这里能证明的
 * 上限，真正把 causal 降级成 hypothesis 的是服务端证据门槛（T063）。
 *
 * 基线：每条场景自己新建记录，并按唯一文本定位，所以这个共享数据库里累积的其它
 * 记录不会改变本文件自己的断言。每个场景从 `/inbox` 开始。
 *
 * 反过来也成立，而且必须由本文件负责：同一运行里所有 spec 共用这一个数据库，而
 * `gate3.spec.ts` 的 T052-C01 断言的是**整库**节点数。所以本文件造出来的条目在
 * 用例结束后经产品自己的 DELETE 路由归还（见 `afterEach` 与 `createdItemIds`），
 * 不留残留。
 */

/**
 * 去掉指定键后的浅拷贝，用于"整体比较但排除幂等键"。
 *
 * 用 `?.` 解构来丢弃字段会留下未使用变量（lint 报错），而逐个字段挑着比又会漏掉将来
 * 新增的字段——所以这里复制一份再删键，保留整对象比较的强度。
 */
function withoutKeys(body: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const copy = { ...body };
  for (const key of keys) delete copy[key];
  return copy;
}

/** 意图输入框的正文，按用例需要重复使用。 */
const INTENT = '这些笔记里哪些步骤有先后顺序，哪些是前提、哪些是结果';

/**
 * 本文件在本用例组里造出来的条目 id，供 `afterEach` 归还数据库。
 *
 * 为什么必须归还：`playwright.config.ts` 是 `workers: 1, fullyParallel: false`，
 * 且 `resetE2eDataDir()` 每次运行只在配置加载阶段跑一次——所以同一运行里所有 spec
 * 共用同一个数据库，而 `flow-intent` 按字典序排在 `gate1`/`gate3` 之前。T052-C01
 * 的 `graph-summary-nodes` 读的是「整个知识库」范围，它的 `'2 个节点'` 依赖"库里除
 * 它自己造的两条以外没有别的条目"。本文件通过 UI 捕获条目却从不清理，就会把那个
 * 计数撑大，让一个正确实现的页面看起来是坏的。
 *
 * 只登记**本文件自己造的** id：清理时按 id 逐个删除，绝不做"清空所有条目"这类会
 * 误伤其它 spec 的动作。
 */
const createdItemIds: string[] = [];

/**
 * 把刚通过 UI 捕获的条目登记进清理清单。
 *
 * id 在这里（捕获之后立刻）解析，而不是等到清理时再按文本反查：T062-C05 会在用例
 * 中途通过界面把其中一条删掉，事后反查只会查不到并让清理抛出无意义的失败。
 */
async function registerCreatedItems(page: Page, texts: string[]): Promise<void> {
  for (const text of texts) {
    createdItemIds.push(await findItemIdViaApi(page, text));
  }
}

/** 选择两条记录并从选择条进入流程页。 */
async function selectTwoAndOpenFlow(page: Page): Promise<[string, string]> {
  const first = uniqueText('流程甲');
  const second = uniqueText('流程乙');
  await captureViaUi(page, first);
  await captureViaUi(page, second);
  await registerCreatedItems(page, [first, second]);

  await page
    .getByTestId('knowledge-card')
    .filter({ hasText: first })
    .getByTestId('card-select')
    .check();
  await page
    .getByTestId('knowledge-card')
    .filter({ hasText: second })
    .getByTestId('card-select')
    .check();
  await expect(page.getByTestId('selection-count')).toContainText('已选 2');

  await page.getByTestId('selection-to-flow').click();
  await expect(page.getByTestId('flow-intent-form')).toBeVisible();
  await expect(page.getByTestId('flow-scope-count')).toContainText('已选 2');
  // 材料核对是进入页面后的第一次真实读取；等它落地再用流量记账。
  await expect(page.getByTestId('flow-material-titles')).toBeVisible();
  return [first, second];
}

/**
 * 记录本页发出的 API 请求（按发出顺序）。
 *
 * 这里用 `page.on('request')` 而不是 `traffic` fixture 的记账数组来数生成请求：
 * `traffic` 是在 `page.route` 的**处理器**里 push 的，处理器的执行相对于测试进程里
 * 的请求事件是异步的。结果是"点击后立刻数"可能读到 0，或者"编辑后立刻数"读到 0
 * 而其实刚刚发过一个请求——两条方向相反的假结论。
 *
 * `page.on('request')` 在请求发出时同步分发给监听器，而这个监听器在用例开始时就
 * 注册了，早于任何 `waitForRequest`，所以它一定先看到同一个请求。external-host
 * 的保证仍由 `traffic` fixture 负责（那是它的职责），这里只做计数。
 */
function trackApi(page: Page): {
  all: () => string[];
  generate: () => string[];
} {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (!request.url().includes('/api/')) return;
    requests.push(`${request.method()} ${request.url()}`);
  });
  return {
    all: () => [...requests],
    generate: () => requests.filter((entry) => entry.includes('/api/views/mermaid/generate')),
  };
}

test.describe('T062 流程意图与材料确认', () => {
  /**
   * 归还本文件造出来的条目。
   *
   * 用产品自己的 `DELETE /api/items/:id`（抽屉删除走的就是这条路径），不是直接写
   * 数据库——直接写行只能证明 fixture 会删，不能证明产品能删。清理失败会抛出并显示
   * 在报告里，不做静默 catch：一个悄悄失败的清理会让下一个 spec 莫名其妙地红。
   *
   * `already-missing` 是合法终态（T062-C05 自己就通过界面删掉了一条），不是错误。
   */
  test.afterEach(async ({ page }) => {
    const pending = createdItemIds.splice(0, createdItemIds.length);
    for (const id of pending) {
      await deleteItemViaApi(page, id);
    }
  });

  test('T062-C02 空意图：不产生任何请求，并要求先填写', async ({ page }) => {
    await gotoInbox(page);
    const api = trackApi(page);
    await selectTwoAndOpenFlow(page);

    // 材料已经核对完成（`flow-material-titles` 可见），所以接下来的点击若还发请求，
    // 一定是生成请求。
    const baseline = api.all().length;

    await page.getByTestId('flow-submit').click();

    // 「必须断言：按规范使用明确默认或提示填写，不产生 undefined」——这里的证据是
    // 一条**具体的中文提示**加上**零个新增 API 请求**：空意图没有变成 `undefined`
    // 被送去服务端，也就没有变成一次 400 或一次付费调用。
    await expect(page.getByTestId('flow-intent-error')).toBeVisible();
    await expect(page.getByTestId('flow-intent-error')).toContainText('观察');
    await page.waitForTimeout(300);
    expect(api.all().slice(baseline), '空意图点击生成不应产生任何 API 请求').toEqual([]);

    // 只填空白字符同样不算填写（服务端 schema 也会拒绝）。
    await page.getByTestId('flow-intent').fill('   \n  ');
    await page.getByTestId('flow-submit').click();
    await expect(page.getByTestId('flow-intent-error')).toBeVisible();
    await page.waitForTimeout(300);
    expect(api.all().slice(baseline), '纯空白意图同样不应产生请求').toEqual([]);
  });

  test('T062-C03 编辑观察问题不产生请求，直到显式点击', async ({ page }) => {
    await gotoInbox(page);
    const api = trackApi(page);
    await selectTwoAndOpenFlow(page);

    const baseline = api.all().length;

    // 逐字输入，模拟"编辑每个字"；再切换方向。两者都只是本地草稿。
    await page.getByTestId('flow-intent').click();
    await page.getByTestId('flow-intent').pressSequentially(INTENT, { delay: 10 });
    await page.getByTestId('flow-direction').selectOption('TB');

    await expect(page.getByTestId('flow-intent')).toHaveValue(INTENT);
    // 留一拍让请求事件有机会投递，否则"零请求"可能只是"还没到"。
    await page.waitForTimeout(300);
    expect(api.all().slice(baseline), '编辑意图与方向都不应产生任何请求').toEqual([]);

    // 显式点击后才出现生成请求——这条把"零请求"钉在"没有点击"上，而不是钉在
    // "页面上没有请求能力"上。
    const posted = page.waitForRequest(
      (request) =>
        request.url().includes('/api/views/mermaid/generate') && request.method() === 'POST',
    );
    await page.getByTestId('flow-submit').click();
    const request = await posted;
    expect(request.postDataJSON()).toMatchObject({ intent: INTENT, direction: 'TB' });

    // 再等一拍：一次点击只应有一次生成请求（双击、重试或多发都不允许）。
    await page.waitForTimeout(500);
    expect(api.generate(), '一次点击只应产生一次生成请求').toHaveLength(1);
  });

  test('T062-C04 同一材料切换方向：只改变排版字段，材料与意图不变', async ({ page }) => {
    await gotoInbox(page);
    const api = trackApi(page);
    await selectTwoAndOpenFlow(page);

    await page.getByTestId('flow-intent').fill(INTENT);

    const bodies: Record<string, unknown>[] = [];
    const collect = async (direction: 'LR' | 'TB') => {
      await page.getByTestId('flow-direction').selectOption(direction);
      const posted = page.waitForRequest(
        (request) =>
          request.url().includes('/api/views/mermaid/generate') && request.method() === 'POST',
      );
      await page.getByTestId('flow-submit').click();
      bodies.push((await posted).postDataJSON() as Record<string, unknown>);
    };

    await collect('LR');
    await collect('TB');
    // 一次点击一次请求：两次 collected body 之后不应再有第三次。
    await page.waitForTimeout(500);
    expect(api.generate(), '两次方向切换只应产生两次生成请求').toHaveLength(2);

    expect(bodies).toHaveLength(2);
    const [lr, tb] = bodies;
    expect(lr.direction).toBe('LR');
    expect(tb.direction).toBe('TB');

    /*
      除了 `direction`，两个请求体逐字段相同。

      `requestKey` 必须排除，而且这一点本身就是设计：它是幂等键，按**每次显式点击**
      新生成（双击是一次请求，失败后重试是新的一次）。若它两次相同，第二次点击会被
      服务端当成本地重放——那恰好是"改方向"看起来像"重新生成"的缺陷。

      因此这里断言的是"差异只有 direction 与 requestKey"：把这两个键抽掉后整体相等，
      而不是逐个挑字段比。将来若有人给请求加了一个随方向变化的字段，这种写法会失败，
      挑字段的写法不会。
    */
    expect(lr.direction).toBe('LR');
    expect(tb.direction).toBe('TB');
    expect(lr.requestKey).not.toBe(tb.requestKey);

    // 「必须断言：只改变布局方向，不改变边类型」在请求层的证据是：去掉 `direction`
    // 与幂等键 `requestKey` 之后，两个请求体逐字段相等——方向之外没有任何东西跟着变。
    //
    // `requestKey` 必须排除，而且这一点本身就是设计：它按**每次显式点击**新生成
    // （双击是一次请求，失败后重试是新的一次）。若它两次相同，第二次点击会被服务端
    // 当成本地重放——那恰好是"改了方向却像没改"的缺陷，所以上面反过来断言它两次不同。
    //
    // 断言方式是"整对象减去这几个键再整体比较"，而不是逐个挑字段比：将来若有人给请求
    // 加了一个随方向变化的字段，这种写法会失败，挑字段的写法不会。
    expect(withoutKeys(lr, ['direction', 'requestKey'])).toEqual(
      withoutKeys(tb, ['direction', 'requestKey']),
    );
    expect(lr.selection).toEqual(tb.selection);
    expect(lr.intent).toBe(INTENT);

    // 「必须排除：视觉方向不是逻辑关系」——请求体里没有承载图表语义的字段：没有
    // Mermaid 源码、没有风格或边类型指令，只有四个白名单键。
    for (const body of bodies) {
      expect(Object.keys(body).sort()).toEqual(['direction', 'intent', 'requestKey', 'selection']);
      expect(JSON.stringify(body)).not.toContain('mermaid');
      expect(body).not.toHaveProperty('edgeKinds');
      expect(body).not.toHaveProperty('style');
    }
  });

  test('T062-C05 选择后删除一个来源：先阻止，确认新集合后才发送该集合', async ({ page }) => {
    await gotoInbox(page);
    const api = trackApi(page);
    const [doomed, keeper] = await selectTwoAndOpenFlow(page);

    // 材料核对面板确认了两条，此时用户看到的将发送集合是完整的。
    await expect(page.getByTestId('flow-material-titles')).toContainText(doomed);
    await expect(page.getByTestId('flow-material-titles')).toContainText(keeper);

    // 走真实删除路径：回收件箱，在抽屉里删掉其中一条。选择存储会同步剔除它
    // （T021-R04），选择条会说明发生了什么。
    await page.getByRole('link', { name: '收件箱' }).click();
    await page
      .getByTestId('knowledge-card')
      .filter({ hasText: doomed })
      .getByRole('button')
      .first()
      .click();
    await expect(page.getByTestId('knowledge-drawer')).toBeVisible();
    await page.getByTestId('drawer-delete').click();
    await expect(page.getByTestId('delete-dialog')).toBeVisible();
    await page.getByTestId('delete-confirm').click();
    await expect(page.getByTestId('selection-tray')).toContainText('已从选择中移除');

    // 回到流程页：材料只剩一条，但"有一条被删除"这件事还没有被用户确认。
    await page.getByTestId('selection-to-flow').click();
    await expect(page.getByTestId('flow-intent-form')).toBeVisible();
    await page.getByTestId('flow-intent').fill(INTENT);
    await expect(page.getByTestId('flow-scope-count')).toContainText('已选 1');

    const baseline = api.generate().length;
    await page.getByTestId('flow-submit').click();

    // 「必须断言：阻止并要求确认新集合」。
    await expect(page.getByTestId('flow-submit-error-note')).toBeVisible();
    await expect(page.getByTestId('flow-intent-form')).toContainText('已经被删除');
    await page.waitForTimeout(300);
    expect(api.generate(), '被删除的来源未被确认前，不应发起生成请求').toHaveLength(baseline);

    // 用户确认新集合（"知道了"）之后再提交：这次请求只带剩下的那一条。
    await page.getByTestId('selection-removed').getByRole('button', { name: '知道了' }).click();
    const posted = page.waitForRequest(
      (request) =>
        request.url().includes('/api/views/mermaid/generate') && request.method() === 'POST',
    );
    await page.getByTestId('flow-submit').click();
    const body = (await posted).postDataJSON() as {
      selection: { itemIds: string[] };
      intent: string;
    };

    // 「必须排除：缺失材料可能改变整个结论」——新集合是被确认过的那一条，而不是
    // 静默带上一个已经删掉的 id，也不是悄悄退回两条。
    expect(body.selection.itemIds).toHaveLength(1);
    expect(body.intent).toBe(INTENT);
    const headers = await authHeaders(page);
    const resolved = await page.request.get(
      // Repeated `itemId` is the documented SelectionQuery shape, and Playwright's
      // `params` only accepts scalars, so the query is built here explicitly.
      `${E2E_ORIGIN}/api/selection?${body.selection.itemIds.map((id) => `itemId=${id}`).join('&')}`,
      { headers },
    );
    const resolvedBody = (await resolved.json()) as { data: { itemIds: string[] } };
    expect(resolvedBody.data.itemIds).toEqual(body.selection.itemIds);
    expect(resolvedBody.data.itemIds).not.toContain(doomed);
  });

  test('T062-C01/C06 引导性提问：照原样发送，因果由证据决定而不是由提问决定', async ({ page }) => {
    await gotoInbox(page);
    await selectTwoAndOpenFlow(page);

    // 「前置：用户问证明某观点一定正确」。
    const leading = '请证明第一条一定导致第二条，不要标成推测';
    await page.getByTestId('flow-intent').fill(leading);

    // 「必须断言：提示词仍要求基于材料并标注未证实部分」。页面上给出的规则在生成之前
    // 就写明了：材料只支持相关时会保留关联或标成推测。
    await expect(page.getByTestId('flow-inference-notice')).toContainText('推测');
    await expect(page.getByTestId('flow-inference-notice')).toContainText('因果');
    await expect(page.getByTestId('flow-intent-hint')).toContainText('观察角度');

    const before = await page.request.get(`${E2E_ORIGIN}/api/views`, {
      headers: await authHeaders(page),
      params: { kind: 'flow', limit: 50 },
    });
    const beforeCount = ((await before.json()) as { data: { views: unknown[] } }).data.views.length;

    const posted = page.waitForRequest(
      (request) =>
        request.url().includes('/api/views/mermaid/generate') && request.method() === 'POST',
    );
    await page.getByTestId('flow-submit').click();
    const body = (await posted).postDataJSON() as Record<string, unknown>;

    // 「必须排除：用户问题不能替代证据」。用户的要求原样进入意图字段，没有关键词过滤
    // 去静默改写他的问题（那样只会让人以为模型确实被限制了）；真正的限制是：请求体里
    // 没有任何可以用来指定因果关系、提高确定性或绕过证据的字段。
    expect(body.intent).toBe(leading);
    expect(Object.keys(body).sort()).toEqual(['direction', 'intent', 'requestKey', 'selection']);
    expect(body).not.toHaveProperty('forceCausal');
    expect(body).not.toHaveProperty('assumeCausal');
    expect(body).not.toHaveProperty('evidenceMode');
    expect(body).not.toHaveProperty('mermaid');

    // 这一步一定失败（本机没有配置模型），失败必须被当作失败：没有成功提示，也没有
    // 新的流程视图落库。
    await expect(page.getByTestId('flow-submit-error-note')).toBeVisible();
    await expect(page.getByTestId('flow-outcome')).toHaveCount(0);

    const after = await page.request.get(`${E2E_ORIGIN}/api/views`, {
      headers: await authHeaders(page),
      params: { kind: 'flow', limit: 50 },
    });
    const afterCount = ((await after.json()) as { data: { views: unknown[] } }).data.views.length;
    expect(afterCount, '一次失败的生成不应产生流程视图').toBe(beforeCount);
  });
});
