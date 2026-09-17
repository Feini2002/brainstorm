import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import type { ItemDTO, RelationDTO } from '@/domain/knowledge';

import { expect, test } from './support/fixtures';
import { drawnTexts, waitForDrawnSvg } from './support/goflow';
import { headersAt, writeScript } from './support/gomindmap';
import { captureViaUi, uniqueText, WORKSPACE_ROUTES } from './support/harness';
import {
  isPortFree,
  type ManagedServer,
  resetRestartDataDir,
  restartDataDir,
  restartOrigin,
  restartPort,
  startServer,
} from './support/restartServer';

/**
 * T084 验收｜最终用户旅程与MVP完成定义
 *
 * 这是 G6 的收口文件，也是整个规格包的最后一份验收。与 T069/T083 的 Gate 报告一样，
 * 它不重复证明某个模块的规则，而是把 T001–T083 已各自验证过的能力**按一个用户会真正
 * 走的顺序**串起来，从一个空目录开始。六个决定值得写在最前面：
 *
 *  1. **自己的进程、自己的空目录。** 共享的 3100 套件库在这里之前已被几百条用例写满，
 *     无法回答「新仓库首次启动是什么样」。本文件用 `startServer()` 在 3101 上起一个
 *     指向 `.data-restart` 的进程，开头 `resetRestartDataDir()` 把目录整个删掉——
 *     `brain.db` 是否由第一次启动**真的**建出来，是 C01 的第一条断言，不是注释里的声称。
 *
 *  2. **串行，且共享状态。** 六个用例是一段旅程的六个阶段，后一段依赖前一段留下的
 *     记录、关系与视图。`mode: 'serial'` 让前一段失败时后面直接跳过，而不是在错误
 *     的前提上继续断言。这与「每个场景必须从明确基线开始」不冲突：基线是 C01 建立的
 *     那个空库，后面每一步都只依赖自己在这条链里明确创建的东西。
 *
 *  3. **所有会花钱的动作走用户的按钮，模型的回答是脚本文件。** 整理、脑图、流程图、
 *     连接测试都从界面点击发出，请求走真实的 `/api/...` 路由、守卫、schema、事务与
 *     入库；只有向模型出网那一步被 `BRAIN_SCRIPTED_PROVIDER` 的回放文件替代
 *     （见 `src/server/llm/transport.ts`）。这是 06_llm_pipeline §1 允许的**唯一**替身。
 *     在此之前没有任何 e2e 从抽屉按钮把「用模型整理」走到成功，也没有任何 e2e 从
 *     设置页的表单保存过 Key——这两段接线是本文件新增的覆盖。
 *
 *  4. **多视图同源不是「看起来一样」，是同一个 UUID。** C03 把三条记录的 id 从
 *     `/api/items` 读出来，再分别在资料库卡片、脑图来源列表、流程图来源面板、抽屉里
 *     找**同一个 id**；每个图只保存对材料的引用，`relations` 表不因画图而多出一行。
 *
 *  5. **人工控制用第二次整理去撞。** C04 先手动改摘要、拒绝一条 AI 关系，再让脚本
 *     模型交出一份「想覆盖摘要、想恢复同一条关系」的回答；断言的是落库后摘要未变、
 *     关系仍是 `rejected` 墓碑且没有第二行，而不是界面上少了一个按钮。
 *
 *  6. **恢复证明用「导出 → 删库 → 重启 → 恢复 → 逐字段对比」。** 对比的基准是恢复前
 *     从 API 读出来的完整状态快照，而不是导出文件本身——文件与库一致是 T070 的事，
 *     这里要证明的是**另一个空库**在恢复后与原库等价，且 Key 需要重新配置。
 *
 * 清理：`afterAll` 停掉本文件起的进程；`.data-restart` 由下一次运行的 `reset` 清空；
 * 备份临时文件写在仓库外的 `%LOCALAPPDATA%\Temp` 并在结束时删除（T078-R06）。
 */

test.describe.configure({ mode: 'serial' });

/* -------------------------------------------------------------------------- */
/* 旅程共享状态                                                                 */
/* -------------------------------------------------------------------------- */

interface Note {
  id: string;
  text: string;
}

/** 视图 DTO 里本文件会对比的部分（见 `ViewBase`）。 */
interface StoredView {
  id: string;
  revision: number;
  selection: { mode: 'explicit'; itemIds: string[] } | { mode: 'filter' };
  sourceSnapshot: { items: { id: string; rawVersion: number; revision: number }[] };
  content: { nodes: { itemIds: string[] }[] };
  contentHash: string | null;
  generatedAt: string | null;
  isStale: boolean;
}

const origin = restartOrigin();
let server: ManagedServer | null = null;

/** 三条记录：甲、乙、丙。C01 建，后面每一段都引用同一组 id。 */
const notes: Note[] = [];
/** C03 由整理产生的 AI 关系（甲 → 乙），C04 拒绝它，C05 检查墓碑随备份走。 */
let aiRelationId = '';
let mindmapViewId = '';
/** C04 改了乙的原文后重新生成的第二张脑图；旧图 `mindmapViewId` 必须同时保留。 */
let regeneratedMindmapId = '';
let flowViewId = '';

/** 替身凭据：永不离开本机，也永不到达任何供应商。 */
const JOURNEY_KEY = 'sk-journey-secret-0000-NEVER-ECHO';
const JOURNEY_BASE_URL = 'https://journey.invalid/v1';
const JOURNEY_MODEL = 'journey-scripted';

/** 整理后模型给甲的字段——后面在四个地方核对的就是这几个字。 */
const ORGANIZED = {
  title: `旅程甲-模型标题-${Date.now().toString(36)}`,
  summary: '模型第一次写的摘要：甲讨论了记录如何进入知识库。',
  tags: ['旅程', '收尾'],
};
const MANUAL_SUMMARY = '我手动改过的摘要——模型不得覆盖这一句。';
const SECOND_TITLE = `旅程甲-第二次标题-${Date.now().toString(36)}`;

const tempFiles: string[] = [];

/* -------------------------------------------------------------------------- */
/* 小工具：都针对旅程进程的 origin，而不是套件的 3100                            */
/* -------------------------------------------------------------------------- */

async function getJson<T>(page: Page, route: string, params?: Record<string, string>): Promise<T> {
  const response = await page.request.get(`${origin}${route}`, {
    headers: await headersAt(origin),
    ...(params ? { params } : {}),
  });
  expect(response.status(), `GET ${route} 应返回 200，实际 ${response.status()}`).toBe(200);
  return ((await response.json()) as { data: T }).data;
}

async function listItems(page: Page): Promise<ItemDTO[]> {
  return (await getJson<{ items: ItemDTO[] }>(page, '/api/items', { limit: '50' })).items;
}

async function readItem(page: Page, id: string): Promise<ItemDTO> {
  return getJson<ItemDTO>(page, `/api/items/${id}`);
}

async function relationsOf(page: Page, itemId: string): Promise<RelationDTO[]> {
  return getJson<RelationDTO[]>(page, '/api/relations', {
    itemId,
    includeRejected: 'true',
    includeStale: 'true',
  });
}

async function listViewIds(page: Page, kind: 'mindmap' | 'flow'): Promise<string[]> {
  const body = await getJson<{ views: { id: string }[] }>(page, '/api/views', { kind, limit: '50' });
  return body.views.map((view) => view.id);
}

async function openWorkspace(page: Page, route: (typeof WORKSPACE_ROUTES)[number]): Promise<void> {
  await page.goto(`${origin}${route}`);
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
}

/** 在资料库找到一张卡并打开它的抽屉。 */
async function openDrawerFor(page: Page, note: Note): Promise<void> {
  await openWorkspace(page, '/library');
  const card = page.locator(`[data-testid="knowledge-card"][data-item-id="${note.id}"]`);
  await expect(card).toBeVisible();
  await card.getByRole('button').first().click();
  await expect(page.getByTestId('knowledge-drawer')).toBeVisible();
}

/** 关掉页面再停进程，避免半路的读请求被记成 console.error。 */
async function stopServer(page: Page): Promise<void> {
  await page.goto('about:blank');
  if (server) await server.stop();
  server = null;
  expect(await isPortFree(restartPort()), '旧进程应已停止并释放端口').toBe(true);
}

function writeTempBundle(bytes: string, label: string): string {
  const dir = path.join(process.env.LOCALAPPDATA ?? process.cwd(), 'Temp');
  const file = path.join(dir, `${label}-${Date.now()}-${process.pid}.json`);
  writeFileSync(file, bytes, 'utf8');
  tempFiles.push(file);
  return file;
}

test.afterAll(async () => {
  if (server) await server.stop();
  server = null;
  for (const file of tempFiles.splice(0)) rmSync(file, { force: true });
});

/* -------------------------------------------------------------------------- */
/* 用例                                                                         */
/* -------------------------------------------------------------------------- */

test.describe('T084 最终用户旅程', () => {
  test('T084-C01 新仓库启动：空目录首次启动后能进入 Inbox，记录真实落库并在重启后仍在', async ({
    page,
  }) => {
    // ---- 基线：目录不存在，端口空闲 ------------------------------------------
    resetRestartDataDir();
    const databaseFile = path.join(restartDataDir(), 'brain.db');
    expect(existsSync(databaseFile), '开始前不应有数据库文件').toBe(false);
    expect(await isPortFree(restartPort()), '旅程端口开始时应空闲').toBe(true);

    // ---- 首次启动：走的是用户同一条 `scripts/start-local.mjs start` ------------
    server = await startServer();

    await openWorkspace(page, '/inbox');
    await expect(page.getByTestId('capture-input')).toBeVisible();
    expect(await listItems(page), '新库应为空').toEqual([]);
    // 数据库在第一次真正的数据读写时建出（`/api/health` 不碰库）；到这里它必须已存在。
    expect(existsSync(databaseFile), '首次数据访问应由迁移建出数据库文件').toBe(true);

    // ---- 三条记录从输入框进去 -------------------------------------------------
    const texts = [
      uniqueText('旅程甲 记录如何进入知识库'),
      uniqueText('旅程乙 记录被整理成结构'),
      uniqueText('旅程丙 结构被画成三种图'),
    ];
    for (const text of texts) await captureViaUi(page, text);

    // 资料库这一端：三张卡，且每张卡带着服务端返回的 id。
    await openWorkspace(page, '/library');
    await expect(page.getByTestId('knowledge-card')).toHaveCount(3);
    const stored = await listItems(page);
    expect(stored).toHaveLength(3);
    for (const text of texts) {
      const match = stored.find((item) => item.rawText === text);
      expect(match, `「${text.slice(0, 8)}」应在 /api/items 里`).toBeTruthy();
      notes.push({ id: match!.id, text });
      await expect(
        page.locator(`[data-testid="knowledge-card"][data-item-id="${match!.id}"]`),
      ).toContainText(text);
    }

    // ---- 停掉进程再起一个：持久化不是刷新页面能证明的 ----------------------------
    const firstPid = server.pid;
    const tokenBefore = (await headersAt(origin))['x-brain-token'];
    await stopServer(page);
    server = await startServer();
    expect(server.pid).not.toBe(firstPid);
    // 令牌按进程签发：新令牌本身就是「另一个进程在回答」的证据（T007-R02）。
    expect((await headersAt(origin))['x-brain-token']).not.toBe(tokenBefore);

    const after = await listItems(page);
    expect(after.map((item) => item.id).sort()).toEqual(notes.map((note) => note.id).sort());
    for (const note of notes) {
      expect(after.find((item) => item.id === note.id)!.rawText).toBe(note.text);
    }
    await openWorkspace(page, '/library');
    await expect(page.getByTestId('knowledge-card')).toHaveCount(3);
  });

  test('T084-C02 Key 前端配置：设置页保存连接后测试与整理可用，Key 不在任何响应或 DOM 里回显', async ({
    page,
  }) => {
    expect(server, 'C01 应已启动旅程进程').not.toBeNull();

    // ---- 前置：没有人碰过 env，也没有任何已保存的连接 -----------------------------
    //
    // 产品没有任何读取 Key 的环境变量（AGENTS.md 禁止 Key 进 env / NEXT_PUBLIC）；
    // 这里核对的是仓库里确实没有 .env 文件，配置只能从设置页进来。
    for (const envFile of ['.env', '.env.local', '.env.production']) {
      expect(existsSync(path.join(process.cwd(), envFile)), `${envFile} 不应存在`).toBe(false);
    }
    const before = await getJson<{ apiKeyConfigured: boolean; config: { baseUrl: string } }>(
      page,
      '/api/settings/llm',
    );
    expect(before.apiKeyConfigured).toBe(false);
    expect(before.config.baseUrl).toBe('');

    // ---- 用设置页的表单保存 ----------------------------------------------------
    await openWorkspace(page, '/settings');
    await page.getByTestId('llm-base-url').fill(JOURNEY_BASE_URL);
    await page.getByTestId('llm-model').fill(JOURNEY_MODEL);
    await page.getByTestId('llm-api-key').fill(JOURNEY_KEY);

    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/settings/llm') && response.request().method() === 'PUT',
    );
    await page.getByTestId('settings-save').click();
    const saveResponse = await saved;
    expect(saveResponse.status(), '保存应返回 200').toBe(200);
    const saveBody = await saveResponse.text();
    expect(saveBody, '保存的响应不得带回 Key').not.toContain(JOURNEY_KEY);
    expect(saveBody).not.toContain('"apiKey"');

    await expect(page.getByTestId('settings-saved')).toContainText('已保存');
    // 保存成功的那一刻输入框就必须清空：DOM 不保存明文（T027-C01）。
    await expect(page.getByTestId('llm-api-key')).toHaveValue('');
    await expect(page.getByTestId('key-status')).toContainText('Key');
    expect(await page.content(), '整页 DOM 不得含 Key 明文').not.toContain(JOURNEY_KEY);

    const configured = await getJson<{ apiKeyConfigured: boolean; config: { baseUrl: string; model: string } }>(
      page,
      '/api/settings/llm',
    );
    expect(configured.apiKeyConfigured, '服务端应确认已保存 Key').toBe(true);
    expect(configured.config.baseUrl).toBe(JOURNEY_BASE_URL);
    expect(configured.config.model).toBe(JOURNEY_MODEL);

    // ---- 测试连接：走「测试」按钮，模型回答由脚本给出 ----------------------------
    writeScript('{"ok":true}');
    const tested = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/settings/llm/test') &&
        response.request().method() === 'POST',
    );
    await page.getByTestId('settings-test').click();
    const testResponse = await tested;
    expect(testResponse.status(), '连接测试应返回 200').toBe(200);
    expect(await testResponse.text(), '测试响应不得带回 Key').not.toContain(JOURNEY_KEY);
    await expect(page.getByTestId('test-connection-state')).toContainText('连接：通过');
    await expect(page.getByTestId('test-format-state')).toContainText('结构校验：通过');

    // ---- 重开设置页：Key 仍不回显，但状态说明已配置 ------------------------------
    await page.reload();
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    await expect(page.getByTestId('llm-api-key')).toHaveValue('');
    await expect(page.getByTestId('key-status')).toContainText('Key');
    expect(await page.content()).not.toContain(JOURNEY_KEY);
  });

  test('T084-C03 多视图同源：整理、脑图、流程图引用同一组真实 id，没有独立的知识副本', async ({
    page,
  }) => {
    expect(notes, 'C01 应已建出三条记录').toHaveLength(3);
    const [jia, yi, bing] = notes as [Note, Note, Note];

    // ---- 整理甲：从抽屉按钮出发，模型回答里带一条指向乙的关系 ---------------------
    writeScript(
      JSON.stringify({
        title: ORGANIZED.title,
        summary: ORGANIZED.summary,
        type: 'idea',
        tags: ORGANIZED.tags,
        keywords: ['记录', '知识库'],
        importance: 3,
        relations: [
          {
            targetId: yi.id,
            type: 'similar_to',
            reason: '两条都在说记录进入并变成结构',
            score: 0.9,
            // 引文必须是乙原文的逐字片段：verifyEvidence 会核对（T039）。
            evidence: [{ itemId: yi.id, quote: yi.text }],
          },
        ],
      }),
    );

    await openDrawerFor(page, jia);
    const organized = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/items/${jia.id}/organize`) &&
        response.request().method() === 'POST',
    );
    await page.getByTestId('drawer-organize').click();
    const organizeResponse = await organized;
    expect(organizeResponse.status(), '整理请求应返回 200').toBe(200);
    const organizeBody = (await organizeResponse.json()) as {
      data: { state: string; warnings: string[] };
    };
    expect(organizeBody.data.state, `整理应成功，警告：${organizeBody.data.warnings.join('；')}`).toBe(
      'succeeded',
    );

    // 抽屉重读后显示模型给的标题；同一个字段再从 API 读一次。
    const drawer = page.getByTestId('knowledge-drawer');
    await expect(drawer.getByRole('heading', { name: ORGANIZED.title })).toBeVisible();
    const organizedItem = await readItem(page, jia.id);
    expect(organizedItem.title).toBe(ORGANIZED.title);
    expect(organizedItem.summary).toBe(ORGANIZED.summary);
    expect(organizedItem.tags).toEqual(expect.arrayContaining(ORGANIZED.tags));
    expect(organizedItem.manualFields, '模型写入的字段不是手工字段').toEqual([]);

    // 关系在 relations 表里是一行 AI 建议，指向乙的真实 id。
    const relations = await relationsOf(page, jia.id);
    expect(relations, '整理应写入一条 AI 关系建议').toHaveLength(1);
    expect(relations[0]!.origin).toBe('ai');
    expect(relations[0]!.reviewStatus).toBe('suggested');
    expect([relations[0]!.sourceId, relations[0]!.targetId].sort()).toEqual([jia.id, yi.id].sort());
    aiRelationId = relations[0]!.id;
    await expect(drawer.getByTestId('relation-row')).toHaveCount(1);
    await page.getByTestId('drawer-close').click();

    // ---- 整理丙：模型一条关系都没提，也必须成功；原文一个字不动（T084-R02）------------
    const bingBefore = await readItem(page, bing.id);
    writeScript(
      JSON.stringify({
        title: '旅程丙-模型标题',
        summary: '丙与前两条无直接关系。',
        type: 'question',
        tags: ['旅程'],
        keywords: ['图'],
        importance: 2,
        relations: [],
      }),
    );
    await openDrawerFor(page, bing);
    const organizedBing = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/items/${bing.id}/organize`) &&
        response.request().method() === 'POST',
    );
    await page.getByTestId('drawer-organize').click();
    const bingBody = (await (await organizedBing).json()) as { data: { state: string } };
    expect(bingBody.data.state, '零关系的整理也应成功').toBe('succeeded');
    await expect(drawer.getByRole('heading', { name: '旅程丙-模型标题' })).toBeVisible();
    const bingAfter = await readItem(page, bing.id);
    expect(bingAfter.rawText, '整理不得改动原文').toBe(bingBefore.rawText);
    expect(bingAfter.capturedText, '整理不得改动首次保存的内容').toBe(bingBefore.capturedText);
    expect(bingAfter.rawVersion, '原文版本不应因整理而变化').toBe(bingBefore.rawVersion);
    expect(bingAfter.type).toBe('question');
    expect(await relationsOf(page, bing.id), '零关系就是零行').toEqual([]);
    await page.getByTestId('drawer-close').click();
    // 乙不整理：它以原始状态进入三张图，证明「未整理的记录同样是一等材料」。

    // ---- 同一批材料进选择条 -------------------------------------------------------
    await openWorkspace(page, '/library');
    for (const note of notes) {
      await page
        .locator(`[data-testid="knowledge-card"][data-item-id="${note.id}"]`)
        .getByTestId('card-select')
        .check();
    }
    await expect(page.getByTestId('selection-count')).toContainText('已选 3');
    // 资料库卡片上已经是模型给的标题——这是第一处引用。
    await expect(
      page.locator(`[data-testid="knowledge-card"][data-item-id="${jia.id}"]`),
    ).toContainText(ORGANIZED.title);

    // ---- 脑图：从选择条进入，点生成 ---------------------------------------------
    writeScript(
      JSON.stringify({
        title: '旅程脑图',
        nodes: [
          { id: 'm1', parentId: null, label: '旅程脑图', itemIds: notes.map((n) => n.id), kind: 'group' },
          { id: 'm2', parentId: 'm1', label: '甲：进入', itemIds: [jia.id], kind: 'note' },
          { id: 'm3', parentId: 'm1', label: '乙：整理', itemIds: [yi.id], kind: 'note' },
          { id: 'm4', parentId: 'm1', label: '丙：成图', itemIds: [bing.id], kind: 'note' },
        ],
      }),
    );
    await page.getByTestId('selection-to-mindmap').click();
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    await expect(page.getByTestId('mindmap-generate-count')).toContainText('已选 3');
    await page.getByTestId('mindmap-generate').click();
    await expect(page.getByTestId('mindmap-generate-outcome')).toContainText('已经生成脑图', {
      timeout: 30_000,
    });
    const mindmaps = await listViewIds(page, 'mindmap');
    expect(mindmaps, '应恰好保存了一张脑图').toHaveLength(1);
    mindmapViewId = mindmaps[0]!;

    // 脑图来源：叶节点 m2 的来源列表里正是甲的 id，并且能回跳到同一条记录。
    await expect(page.getByTestId('mindmap-outline-select').first()).toBeVisible();
    await page.getByTestId('mindmap-outline-select').nth(1).click();
    await expect(page.getByTestId('source-list-item')).toHaveCount(1);
    await expect(page.getByTestId('source-list-item').first()).toHaveAttribute('data-item-id', jia.id);
    await expect(page.getByTestId('source-list-item').first()).toContainText(ORGANIZED.title);
    await page.getByTestId('source-open').click();
    await expect(page.getByTestId('knowledge-drawer')).toBeVisible();
    await expect(page.getByTestId('knowledge-drawer')).toContainText(jia.text);
    await expect(
      page.getByTestId('knowledge-drawer').getByRole('heading', { name: ORGANIZED.title }),
    ).toBeVisible();
    await page.getByTestId('drawer-close').click();

    // ---- 流程图：同一选择条，写观察问题，点生成 ----------------------------------
    //
    // 边 n2→n3 声称 causal 却不带任何关系依据：产品必须把它降级为「推测」并在结果里说明
    // （T063/T069-C01）。这里让它出现在旅程里，是因为「不确定性被显式标出」是 R03 的要求。
    writeScript(
      JSON.stringify({
        title: '旅程流程',
        direction: 'LR',
        nodes: [
          { id: 'n1', label: '记录进入', itemIds: [jia.id] },
          { id: 'n2', label: '整理成结构', itemIds: [yi.id] },
          { id: 'n3', label: '画成三种图', itemIds: [bing.id] },
        ],
        edges: [
          { source: 'n1', target: 'n2', kind: 'sequence', label: '然后', itemIds: [jia.id, yi.id], relationIds: [] },
          { source: 'n2', target: 'n3', kind: 'causal', label: '导致', itemIds: [yi.id, bing.id], relationIds: [] },
        ],
      }),
    );
    await page.getByTestId('selection-to-flow').click();
    await expect(page.getByTestId('flow-intent-form')).toBeVisible();
    await expect(page.getByTestId('flow-scope-count')).toContainText('已选 3');
    await expect(page.getByTestId('flow-material-titles')).toBeVisible();
    await page.getByTestId('flow-intent').fill('这三条记录之间的先后顺序是什么？');
    await page.getByTestId('flow-submit').click();
    await expect(page.getByTestId('flow-outcome')).toContainText('已经生成流程视图', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('flow-outcome')).toContainText('推测');
    const flows = await listViewIds(page, 'flow');
    expect(flows, '应恰好保存了一张流程图').toHaveLength(1);
    flowViewId = flows[0]!;

    // 画面上推测边写明「推测：」；来源面板里节点 n1 的来源就是甲的 id。
    await waitForDrawnSvg(page);
    expect((await drawnTexts(page)).join(' | ')).toContain('推测：');
    await page.getByTestId('flow-source-node').selectOption('n1');
    await expect(page.getByTestId('source-list-item')).toHaveCount(1);
    await expect(page.getByTestId('source-list-item').first()).toHaveAttribute('data-item-id', jia.id);
    await expect(page.getByTestId('source-list-item').first()).toContainText(ORGANIZED.title);
    await page.getByTestId('flow-source-node').selectOption('n3');
    await expect(page.getByTestId('flow-hypothesis-row')).toHaveCount(1);

    // ---- 同源：两张图存的都是引用，知识本体只有三行、一条关系 --------------------
    const mindmap = await getJson<StoredView>(page, `/api/views/${mindmapViewId}`);
    const flow = await getJson<StoredView>(page, `/api/views/${flowViewId}`);
    const allIds = notes.map((n) => n.id).sort();
    for (const view of [mindmap, flow]) {
      // 视图只保存「选了哪些 id」与「当时它们的版本」，不保存原文副本。
      expect(view.selection.mode).toBe('explicit');
      if (view.selection.mode === 'explicit') {
        expect([...view.selection.itemIds].sort()).toEqual(allIds);
      }
      expect(view.sourceSnapshot.items.map((s) => s.id).sort()).toEqual(allIds);
      for (const node of view.content.nodes) {
        for (const id of node.itemIds) expect(allIds, `节点引用的 ${id} 必须是真实记录`).toContain(id);
      }
      expect(JSON.stringify(view.content), '视图内容不应内嵌原文').not.toContain(jia.text);
      expect(view.isStale, '刚生成的视图不应过期').toBe(false);
    }
    expect((await listItems(page)).length, '画图不应复制出新的记录').toBe(3);
    expect((await relationsOf(page, jia.id)).length, '画图不应写入新的知识关系').toBe(1);
    expect((await relationsOf(page, bing.id)).length, '推测边不得变成关系').toBe(0);
  });

  test('T084-C04 人工控制：手动改摘要并拒绝一条边之后再次整理，修改与拒绝都保持', async ({
    page,
  }) => {
    expect(aiRelationId, 'C03 应已产生一条 AI 关系').not.toBe('');
    const [jia, yi] = notes as [Note, Note, Note];

    // ---- 手动改摘要 ------------------------------------------------------------
    await openDrawerFor(page, jia);
    await page.getByTestId('drawer-edit').click();
    await page.getByTestId('edit-summary').fill(MANUAL_SUMMARY);
    await page.getByTestId('edit-save').click();
    await expect(page.getByTestId('knowledge-drawer')).toContainText('已保存修改');
    const edited = await readItem(page, jia.id);
    expect(edited.summary).toBe(MANUAL_SUMMARY);
    expect(edited.manualFields, '手动改过的字段必须被标记').toContain('summary');

    // ---- 拒绝那条 AI 关系 -------------------------------------------------------
    const row = page.getByTestId('knowledge-drawer').getByTestId('relation-row');
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: '拒绝' }).click();
    await expect(row.getByRole('button', { name: '重新允许这条建议' })).toBeVisible();
    const rejected = (await relationsOf(page, jia.id)).find((r) => r.id === aiRelationId);
    expect(rejected?.reviewStatus, '拒绝后应留下墓碑而不是删除').toBe('rejected');

    // ---- 再次整理：模型想覆盖摘要、想恢复同一条关系 -------------------------------
    writeScript(
      JSON.stringify({
        title: SECOND_TITLE,
        summary: '模型第二次想覆盖的摘要——不应落库。',
        type: 'idea',
        tags: ORGANIZED.tags,
        keywords: ['记录'],
        importance: 4,
        relations: [
          {
            targetId: yi.id,
            type: 'similar_to',
            reason: '第二次仍然认为相似',
            score: 0.95,
            evidence: [{ itemId: yi.id, quote: yi.text }],
          },
        ],
      }),
    );
    const organized = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/items/${jia.id}/organize`) &&
        response.request().method() === 'POST',
    );
    await page.getByTestId('drawer-organize').click();
    const body = (await (await organized).json()) as { data: { state: string; warnings: string[] } };
    expect(body.data.state, `第二次整理应成功，警告：${body.data.warnings.join('；')}`).toBe('succeeded');

    // 非手工字段照常更新，手工字段一字未动。
    await expect(
      page.getByTestId('knowledge-drawer').getByRole('heading', { name: SECOND_TITLE }),
    ).toBeVisible();
    const after = await readItem(page, jia.id);
    expect(after.title, '未手动维护的标题应被第二次整理更新').toBe(SECOND_TITLE);
    expect(after.summary, '手动摘要不得被模型覆盖').toBe(MANUAL_SUMMARY);
    expect(after.manualFields).toContain('summary');

    // 拒绝决定保持：仍是同一行墓碑，没有新的 suggested 行复活它。
    const relations = await relationsOf(page, jia.id);
    const pair = relations.filter(
      (r) => [r.sourceId, r.targetId].sort().join() === [jia.id, yi.id].sort().join(),
    );
    expect(pair, '甲—乙之间只应有一行关系').toHaveLength(1);
    expect(pair[0]!.id).toBe(aiRelationId);
    expect(pair[0]!.reviewStatus).toBe('rejected');
    await expect(
      page.getByTestId('knowledge-drawer').getByRole('button', { name: '重新允许这条建议' }),
    ).toBeVisible();
    await expect(
      page.getByTestId('knowledge-drawer').getByRole('button', { name: '确认' }),
    ).toHaveCount(0);

    // 界面这一端：资料库卡片显示的是手动摘要 + 第二次的标题（抽屉只读态不显示摘要，
    // 摘要在卡片和编辑表单里；这一点记入 final-acceptance 的观察项）。
    await page.getByTestId('drawer-close').click();
    await openWorkspace(page, '/library');
    const card = page.locator(`[data-testid="knowledge-card"][data-item-id="${jia.id}"]`);
    await expect(card).toContainText(SECOND_TITLE);
    await expect(card).toContainText(MANUAL_SUMMARY);

    // ---- 改一条来源 → 旧脑图过期 → 重新生成另存 → 旧图仍可读（T084-R04）------------
    //
    // 注意：这张脑图在这里**已经**过期——上面对甲的手动编辑与第二次整理都推进了甲的
    // revision，而来源快照记的正是每条材料生成时的 revision（C03 末尾断言过刚生成时
    // `isStale === false`）。下面再改乙的原文，是为了让 rawVersion 也动一次，并让新图的
    // 快照能证明它基于的是改后的版本。
    const yiBefore = await readItem(page, yi.id);
    const oldView = await getJson<StoredView>(page, `/api/views/${mindmapViewId}`);
    expect(oldView.isStale, '甲被手动编辑并重新整理后，引用它的脑图应已过期').toBe(true);

    await openDrawerFor(page, yi);
    await page.getByTestId('drawer-edit').click();
    await page.getByTestId('edit-raw').fill(`${yi.text}\n补充：这一行是在脑图生成之后加的。`);
    await page.getByTestId('edit-save').click();
    await expect(page.getByTestId('knowledge-drawer')).toContainText('已保存修改');
    await page.getByTestId('drawer-close').click();
    const yiAfter = await readItem(page, yi.id);
    expect(yiAfter.rawVersion, '改原文应推进原文版本').toBe(yiBefore.rawVersion + 1);

    // 过期是**读出来**的，不是猜的：API 与页面横幅都说这张图基于旧版本。
    expect((await getJson<StoredView>(page, `/api/views/${mindmapViewId}`)).isStale).toBe(true);
    await openWorkspace(page, '/mindmap');
    await page.getByTestId('mindmap-view-select').selectOption(mindmapViewId);
    await expect(page.getByTestId('mindmap-renderer')).toBeVisible();
    await expect(page.getByTestId('view-freshness-banner')).toHaveAttribute('data-stale', 'true');
    await expect(page.getByTestId('view-freshness-reason')).toContainText('条笔记已修改');

    // 重新生成：确认框说明新旧两张同时保留，模型回答是一棵不同的树。
    writeScript(
      JSON.stringify({
        title: '旅程脑图（重生成）',
        nodes: [
          { id: 'r1', parentId: null, label: '旅程脑图（重生成）', itemIds: notes.map((n) => n.id), kind: 'group' },
          { id: 'r2', parentId: 'r1', label: '甲乙：从进入到整理', itemIds: [jia.id, yi.id], kind: 'group' },
          { id: 'r3', parentId: 'r2', label: '乙有补充的一行', itemIds: [yi.id], kind: 'note' },
          { id: 'r4', parentId: 'r1', label: '丙：成图', itemIds: [notes[2]!.id], kind: 'note' },
        ],
      }),
    );
    await page.getByTestId('regenerate-open').click();
    await expect(page.getByTestId('regenerate-confirm')).toContainText('新旧两张会同时保留');
    await page.getByTestId('regenerate-confirm-go').click();
    await expect(page.getByTestId('regenerate-outcome-state')).toContainText('已经生成新的脑图', {
      timeout: 30_000,
    });

    const mindmaps = await listViewIds(page, 'mindmap');
    expect(mindmaps, '重新生成应另存为第二张脑图').toHaveLength(2);
    const freshId = mindmaps.find((id) => id !== mindmapViewId)!;
    const fresh = await getJson<StoredView>(page, `/api/views/${freshId}`);
    expect(fresh.isStale, '新图基于当前版本，不应过期').toBe(false);
    expect(fresh.sourceSnapshot.items.find((s) => s.id === yi.id)?.rawVersion).toBe(yiAfter.rawVersion);

    // 旧图一字未改，也仍然能打开——它仍然诚实地标着过期。
    const oldAfter = await getJson<StoredView>(page, `/api/views/${mindmapViewId}`);
    expect(oldAfter.content).toEqual(oldView.content);
    expect(oldAfter.contentHash).toBe(oldView.contentHash);
    expect(oldAfter.generatedAt).toBe(oldView.generatedAt);
    expect(oldAfter.revision).toBe(oldView.revision);
    expect(oldAfter.isStale).toBe(true);
    await page.getByTestId('mindmap-view-select').selectOption(mindmapViewId);
    await expect(page.getByTestId('mindmap-renderer')).toBeVisible();
    await expect(page.getByTestId('view-freshness-banner')).toHaveAttribute('data-stale', 'true');
    regeneratedMindmapId = freshId;
  });

  test('T084-C05 恢复证明：导出后恢复到另一个空库，原文、关系、视图等价，Key 需重新配置', async ({
    page,
  }) => {
    expect(mindmapViewId && flowViewId && regeneratedMindmapId, 'C03/C04 应已保存三张视图').toBeTruthy();
    const viewIds = [mindmapViewId, regeneratedMindmapId, flowViewId];

    // ---- 恢复前的完整状态快照（从 API 读，不从导出文件读）----------------------------
    const itemsBefore = await listItems(page);
    const relationsBefore = await relationsOf(page, notes[0]!.id);
    const viewsBefore = new Map<string, StoredView>();
    for (const id of viewIds) viewsBefore.set(id, await getJson<StoredView>(page, `/api/views/${id}`));
    expect(itemsBefore).toHaveLength(3);
    expect(relationsBefore).toHaveLength(1);
    // 旧脑图带着「过期」进入备份：恢复后这个判断必须还能算出来。
    expect(viewsBefore.get(mindmapViewId)!.isStale).toBe(true);
    expect(viewsBefore.get(regeneratedMindmapId)!.isStale).toBe(false);

    // ---- 导出：设置页按钮，真实 download ----------------------------------------------
    await openWorkspace(page, '/settings');
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('backup-export').click();
    const download = await downloadPromise;
    const file = await download.path();
    expect(file, '导出应真的产生一个下载文件').toBeTruthy();
    const bytes = readFileSync(file!, 'utf8');

    const bundle = JSON.parse(bytes) as {
      schemaVersion: number;
      data: {
        knowledgeItems: { id: string; manualFields: string[] }[];
        relations: { id: string; reviewStatus: string }[];
        views: { id: string }[];
      };
    };
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.data.knowledgeItems.map((i) => i.id).sort()).toEqual(notes.map((n) => n.id).sort());
    expect(bundle.data.relations.find((r) => r.id === aiRelationId)?.reviewStatus, '拒绝墓碑应随备份走').toBe(
      'rejected',
    );
    expect(bundle.data.views.map((v) => v.id).sort()).toEqual([...viewIds].sort());
    // 逻辑导出不含 Key，也不含连接配置。
    expect(bytes).not.toContain(JOURNEY_KEY);
    expect(bytes).not.toMatch(/sk-[A-Za-z0-9-]{8,}/u);
    expect(bytes).not.toContain('apiKey');
    expect(bytes).not.toContain('baseUrl');

    // ---- 删库重启：这就是「另一个空库」 --------------------------------------------
    await stopServer(page);
    resetRestartDataDir();
    expect(existsSync(path.join(restartDataDir(), 'brain.db'))).toBe(false);
    server = await startServer();
    expect(await listItems(page), '恢复前目标库必须是空的').toEqual([]);
    const settingsEmpty = await getJson<{ apiKeyConfigured: boolean }>(page, '/api/settings/llm');
    expect(settingsEmpty.apiKeyConfigured).toBe(false);

    // ---- 恢复：设置页选文件 → 校验 → 勾选 → 恢复 --------------------------------------
    await openWorkspace(page, '/settings');
    await page.getByTestId('backup-file').setInputFiles(writeTempBundle(bytes, 't084-journey'));
    await expect(page.getByTestId('backup-picked-file')).toBeVisible();
    await page.getByTestId('backup-validate').click();
    const counts = page.getByTestId('backup-validation-counts');
    await expect(counts).toBeVisible({ timeout: 30_000 });
    await expect(counts).toHaveAttribute('data-valid', 'true');
    await expect(counts).toContainText(`条目 ${bundle.data.knowledgeItems.length}`);
    await expect(counts).toContainText(`关系 ${bundle.data.relations.length} ·`);
    await expect(counts).toContainText(`视图 ${bundle.data.views.length}`);
    await expect(page.getByTestId('backup-restore')).toBeDisabled();
    await page.getByTestId('backup-confirm-empty').check();
    await page.getByTestId('backup-restore').click();
    await expect(page.getByTestId('backup-restore-notice')).toContainText('已恢复到空知识库', {
      timeout: 30_000,
    });

    // ---- 等价：逐字段对比恢复前的快照 -----------------------------------------------
    const itemsAfter = await listItems(page);
    expect(itemsAfter.map((i) => i.id).sort()).toEqual(itemsBefore.map((i) => i.id).sort());
    for (const before of itemsBefore) {
      const after = itemsAfter.find((i) => i.id === before.id)!;
      expect(after.rawText).toBe(before.rawText);
      expect(after.capturedText).toBe(before.capturedText);
      expect(after.title).toBe(before.title);
      expect(after.summary).toBe(before.summary);
      expect(after.manualFields).toEqual(before.manualFields);
      expect([...after.tags].sort()).toEqual([...before.tags].sort());
      expect(after.rawVersion).toBe(before.rawVersion);
    }
    const relationsAfter = await relationsOf(page, notes[0]!.id);
    expect(relationsAfter).toHaveLength(1);
    expect(relationsAfter[0]!.id).toBe(relationsBefore[0]!.id);
    expect(relationsAfter[0]!.reviewStatus).toBe('rejected');
    expect(relationsAfter[0]!.evidence).toEqual(relationsBefore[0]!.evidence);

    expect((await listViewIds(page, 'mindmap')).sort()).toEqual([mindmapViewId, regeneratedMindmapId].sort());
    expect(await listViewIds(page, 'flow')).toEqual([flowViewId]);
    for (const id of viewIds) {
      const before = viewsBefore.get(id)!;
      const after = await getJson<StoredView>(page, `/api/views/${id}`);
      expect(after.content, `视图 ${id} 内容应等价`).toEqual(before.content);
      expect(after.selection).toEqual(before.selection);
      // 来源快照也要等价：它记录的是「图基于哪个版本的原文」，丢了就没法判断过期。
      expect(after.sourceSnapshot).toEqual(before.sourceSnapshot);
      expect(after.contentHash).toBe(before.contentHash);
      expect(after.generatedAt).toBe(before.generatedAt);
      // 过期与否是从快照和当前原文版本算出来的，两边都恢复对了它才会相同。
      expect(after.isStale, `视图 ${id} 的过期判断应一致`).toBe(before.isStale);
    }

    // ---- 打开原文和保存的视图：界面这一端也能到达 ------------------------------------
    await openDrawerFor(page, notes[0]!);
    await expect(page.getByTestId('knowledge-drawer')).toContainText(notes[0]!.text);
    await expect(
      page.getByTestId('knowledge-drawer').getByRole('button', { name: '重新允许这条建议' }),
    ).toBeVisible();
    await page.getByTestId('drawer-close').click();
    await expect(
      page.locator(`[data-testid="knowledge-card"][data-item-id="${notes[0]!.id}"]`),
    ).toContainText(MANUAL_SUMMARY);

    await openWorkspace(page, '/mindmap');
    await page.getByTestId('mindmap-view-select').selectOption(mindmapViewId);
    await expect(page.getByTestId('mindmap-renderer')).toBeVisible();
    await page.getByTestId('mindmap-outline-select').nth(1).click();
    await expect(page.getByTestId('source-list-item').first()).toHaveAttribute('data-item-id', notes[0]!.id);

    await openWorkspace(page, '/flow');
    await page.getByTestId('flow-view-select').selectOption(flowViewId);
    await expect(page.getByTestId('flow-renderer')).toBeVisible();
    await waitForDrawnSvg(page);

    // ---- Key 需要独立配置：备份不带它，恢复后设置页明确说没有 -------------------------
    const settingsAfter = await getJson<{ apiKeyConfigured: boolean; config: { baseUrl: string } }>(
      page,
      '/api/settings/llm',
    );
    expect(settingsAfter.apiKeyConfigured, '恢复不得带回 Key').toBe(false);
    expect(settingsAfter.config.baseUrl, '恢复不得带回连接配置').toBe('');
    await openWorkspace(page, '/settings');
    await expect(page.getByTestId('llm-api-key')).toHaveValue('');
    await expect(page.getByTestId('llm-base-url')).toHaveValue('');
  });

  test('T084-C06 完成边界：最终说明与任务台账一致，产品只暴露六个已交付页面', async ({ page }) => {
    const root = process.cwd();
    const read = (file: string): string => readFileSync(path.join(root, file), 'utf8');

    // ---- 台账：每个任务的状态只能是允许值，且 T084 之外全部 verified ----------------
    const ledger = JSON.parse(read('implementation/progress/tasks.current.json')) as {
      tasks: { id: string; status: string }[];
    };
    const allowed = new Set(['not_started', 'in_progress', 'blocked', 'verified']);
    expect(ledger.tasks.length).toBe(84);
    const notVerified = ledger.tasks.filter((t) => t.status !== 'verified').map((t) => t.id);
    for (const task of ledger.tasks) expect(allowed.has(task.status), `${task.id} 状态 ${task.status}`).toBe(true);

    // ---- 最终说明：四张清单齐全，未验证清单与台账一致 --------------------------------
    const acceptance = read('docs/release/final-acceptance.md');
    for (const heading of ['已实现', '未实现', '已验证', '未验证']) {
      expect(acceptance, `最终说明应有「${heading}」清单`).toContain(`## ${heading}`);
    }
    for (const id of notVerified) {
      expect(acceptance, `${id} 未 verified，必须出现在最终说明里`).toContain(id);
    }
    // 明确写出范围外能力，而不是留白让读者去猜。
    for (const excluded of ['云同步', '多用户', '向量检索']) {
      expect(acceptance, `最终说明应明确「${excluded}」不在范围内`).toContain(excluded);
    }

    // ---- README 的交付状态与台账一致 -------------------------------------------------
    const readme = read('README.md');
    expect(readme).toContain('final-acceptance.md');
    expect(readme).toContain('known-issues.md');

    // ---- 产品：主导航恰好是六个页面，没有承诺范围外的入口 -------------------------------
    expect(server, '旅程进程应仍在运行').not.toBeNull();
    await openWorkspace(page, '/inbox');
    const nav = page.getByRole('navigation', { name: '主导航' });
    const links = await nav.getByRole('link').evaluateAll((anchors) =>
      anchors.map((a) => new URL((a as HTMLAnchorElement).href).pathname),
    );
    expect(links.sort()).toEqual([...WORKSPACE_ROUTES].sort());
    for (const route of ['/login', '/sync', '/api/auth', '/api/sync']) {
      const response = await page.request.get(`${origin}${route}`, {
        headers: await headersAt(origin),
      });
      expect(response.status(), `${route} 不在范围内，不应存在`).toBe(404);
    }
  });
});
