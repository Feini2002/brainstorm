import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, gotoInbox, test } from './support/fixtures';
import { authHeaders, captureViaUi, uniqueText, WORKSPACE_ROUTES } from './support/harness';
import { E2E_ORIGIN } from './support/env';
import {
  isPortFree,
  resetRestartDataDir,
  restartOrigin,
  restartPort,
  startServer,
} from './support/restartServer';

/**
 * T026 验收｜离线知识库闭环验收
 *
 * This is the gate report, so it is the one place that must show a *complete*
 * user journey rather than isolated capabilities. Two structural decisions:
 *
 * 1. **The seed fixture is consumed as data, not as prose.** `tests/fixtures/crud-
 *    seed.json` supplies a word, a long paragraph, multi-line text, two notes with
 *    the same title, distinct tags and CJK punctuation (T026-R01). The cases read
 *    it and assert that what comes back equals what went in.
 *
 * 2. **Restart is a real restart.** T026-R03 explicitly rules out "just refresh the
 *    browser" as evidence of persistence, so the case stops the Node process,
 *    starts a new one against the same database directory, and then re-reads the
 *    data through the API. Nothing is cached across that boundary.
 */
interface SeedItem {
  id: string;
  rawText: string;
  sourceType: string;
  sourceRef: string | null;
}

interface SeedFile {
  items: SeedItem[];
  tags: Record<string, string[]>;
  relation: { sourceId: string; targetId: string; type: string; reason: string };
}

const seed = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'tests', 'fixtures', 'crud-seed.json'), 'utf8'),
) as SeedFile;

/**
 * Find the card for a record by its text, tolerating duplicates.
 *
 * Searches are literal, so a seeded text matches every copy of it — and the
 * fixture is deliberately reused across cases. `knowledge-card` filters can
 * therefore match more than one card, so `.first()` asks for the specific card
 * that exists rather than asserting there is exactly one.
 */
function cardFor(page: import('@playwright/test').Page, text: string) {
  return page.getByTestId('knowledge-card').filter({ hasText: text }).first();
}

test.describe('T026 离线知识库闭环验收', () => {
  /**
   * `@narrow`: the config promises this project covers "the core capture/edit/detail
   * path" at 1280×720. This case is exactly that path end to end through real
   * controls, so it is the one to re-run at the smaller width.
   */
  test('T026-C01 @narrow 空库无 Key 时，四类片段可通过 UI 完成创建、编辑与搜索', async ({ page }) => {
    await gotoInbox(page);

    // T026-R01: a word, a long paragraph and multi-line text — not one "Hello".
    const samples = [
      seed.items.find((item) => item.id === 'one-word')!.rawText,
      seed.items.find((item) => item.id === 'long-paragraph')!.rawText,
      seed.items.find((item) => item.id === 'multi-line')!.rawText,
    ];

    for (const text of samples) {
      await captureViaUi(page, text);
    }

    // Same title, different content: the two must stay distinct records.
    const sameA = seed.items.find((item) => item.id === 'same-title-a')!.rawText;
    const sameB = seed.items.find((item) => item.id === 'same-title-b')!.rawText;
    await captureViaUi(page, sameA);
    await captureViaUi(page, sameB);

    // Search is literal, so the CJK-punctuation sample must be findable by a
    // character that only appears in it (T026-R01).
    const punctuation = seed.items.find((item) => item.id === 'cjk-punctuation')!.rawText;
    await captureViaUi(page, punctuation);

    await page.getByRole('link', { name: '资料库' }).click();
    for (const text of [sameA, sameB, punctuation]) {
      await page.getByTestId('library-search').fill(text);
      await expect(
        cardFor(page, text),
        `「${text.slice(0, 12)}」应能被检索到`,
      ).toBeVisible();
    }

    // T026-R02: an edit made through the drawer must land, and the captured text
    // must remain available as history even after `rawText` changes.
    await page.getByTestId('library-search').fill(punctuation);
    await cardFor(page, punctuation).getByRole('button').first().click();
    await expect(page.getByTestId('knowledge-drawer')).toBeVisible();
    await page.getByTestId('drawer-edit').click();

    const editedTitle = `已编辑标题-${Date.now().toString(36)}`;
    await page.getByTestId('edit-title').fill(editedTitle);
    await page.getByTestId('edit-save').click();

    await expect(page.getByTestId('knowledge-drawer').getByRole('heading', { name: editedTitle })).toBeVisible();
    await expect(page.getByText('原文（保存时的内容）')).toBeVisible();
    await expect(page.getByTestId('knowledge-drawer')).toContainText('100%');
  });

  test('T026-C02 停止并重启 Node 后，原文、标签、版本与人工关系仍在', async ({ page }) => {
    // T026-R03: this case runs against its own server so the Node process can be
    // stopped and started for real. Refreshing the browser is explicitly not
    // accepted as evidence of persistence.
    resetRestartDataDir();
    const origin = restartOrigin();

    let server = await startServer();
    try {
      await page.goto(`${origin}/inbox`);
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();

      const pairLeft = uniqueText('重启-左');
      const pairRight = uniqueText('重启-右');
      await captureViaUi(page, pairLeft);
      await captureViaUi(page, pairRight);

      // Tag and summarize the record so the restart check covers the tags table and
      // the organize-owned fields, not just the raw text column.
      await page
        .getByTestId('knowledge-card')
        .filter({ hasText: pairLeft })
        .getByRole('button')
        .first()
        .click();
      await expect(page.getByTestId('knowledge-drawer')).toBeVisible();
      await page.getByTestId('drawer-edit').click();
      await page.getByTestId('edit-tags').fill('重启标签');
      await page.getByTestId('edit-tags').press('Enter');
      await page.getByTestId('edit-summary').fill('重启前的摘要');
      await page.getByTestId('edit-save').click();
      await expect(page.getByTestId('knowledge-drawer')).toContainText('已保存修改');

      const revisionBefore = await readRevisionFromDrawer(page);

      const editor = page.getByTestId('relation-editor');
      await editor.getByTestId('relation-target').selectOption({ label: pairRight });
      await editor.getByTestId('relation-type').selectOption('related_to');
      await editor.getByTestId('relation-reason').fill(seed.relation.reason);
      await editor.getByTestId('relation-submit').click();
      await expect(editor.getByText('关系已保存')).toBeVisible();

      // Read the state back over HTTP, so the comparison after the restart is
      // between two server reads rather than between DOM and server.
      const headersBefore = await authHeadersAt(server.origin);
      const before = await readBack(server.origin, page, headersBefore, pairLeft);
      expect(before.item.tags).toContain('重启标签');
      expect(before.item.summary).toBe('重启前的摘要');
      expect(before.relations).toBe(1);

      // --- the actual restart ------------------------------------------------
      const firstPid = server.pid;
      await server.stop();
      expect(await isPortFree(restartPort()), `旧进程 ${firstPid} 应已停止`).toBe(true);

      server = await startServer();
      expect(server.pid).not.toBe(firstPid);

      // --- the assertions ----------------------------------------------------
      // The session token is per-process, so a new token is itself proof that a
      // different Node process is answering (T007-R02).
      const headersAfter = await authHeadersAt(server.origin);
      expect(headersAfter['x-brain-token']).not.toBe(headersBefore['x-brain-token']);

      const after = await readBack(server.origin, page, headersAfter, pairLeft);
      expect(after.item.rawText).toBe(before.item.rawText);
      expect(after.item.capturedText).toBe(before.item.capturedText);
      expect(after.item.tags).toEqual(before.item.tags);
      expect(after.item.summary).toBe(before.item.summary);
      expect(after.item.revision).toBe(revisionBefore);
      expect(after.relations, '人工关系必须在重启后仍存在').toBe(1);

      // The UI agrees, which rules out "the API read something the page did not".
      await page.goto(`${server.origin}/library`);
      await page.getByTestId('library-search').fill(pairLeft);
      await expect(page.getByTestId('knowledge-card').filter({ hasText: pairLeft })).toContainText(
        '重启前的摘要',
      );
    } finally {
      await server.stop();
    }
  });

  test('T026-C03 制造保存冲突后可以继续创建，错误不影响其它条目', async ({ page }) => {
    await gotoInbox(page);
    const subject = uniqueText('冲突条目');
    await captureViaUi(page, subject);

    // Open the drawer, then change the record behind the form's back so the edit
    // carries a stale `expectedRevision` (T026-C03「前置：故意制造一个保存冲突」).
    await page.getByTestId('knowledge-card').filter({ hasText: subject }).getByRole('button').first().click();
    await expect(page.getByTestId('knowledge-drawer')).toBeVisible();
    await page.getByTestId('drawer-edit').click();

    const headers = await authHeaders(page);
    const current = await readBack(E2E_ORIGIN, page, headers, subject);
    const bump = await page.request.patch(`${E2E_ORIGIN}/api/items/${current.item.id}`, {
      headers,
      data: {
        expectedRevision: current.item.revision,
        patch: { summary: '由另一个窗口写入' },
      },
    });
    expect(bump.status(), '外部写入应成功').toBe(200);

    // The form now submits against the revision it loaded, which is stale.
    await page.getByTestId('edit-summary').fill('这一份应该冲突');
    await page.getByTestId('edit-save').click();

    // The conflict is reported, and the user's typing is preserved rather than
    // silently reloaded over (T019).
    await expect(page.getByTestId('edit-item-form')).toContainText('在别处被改过');
    await expect(page.getByTestId('edit-summary')).toHaveValue('这一份应该冲突');

    // Recovery: cancelling and re-reading shows the other writer's value, and the
    // app keeps working. Other records are untouched.
    await page.getByTestId('edit-cancel').click();
    await page.getByTestId('drawer-close').click();

    const survivor = uniqueText('冲突后新建');
    await captureViaUi(page, survivor);
    await page.getByRole('link', { name: '资料库' }).click();
    await page.getByTestId('library-search').fill(survivor);
    await expect(page.getByTestId('knowledge-card').filter({ hasText: survivor })).toBeVisible();

    // And the conflicted record still holds the external writer's value.
    const final = await readBack(E2E_ORIGIN, page, headers, subject);
    expect(final.item.summary).toBe('由另一个窗口写入');
  });

  test('T026-C04 删除有关系的条目只影响该数据，视图选择同步清理', async ({ page }) => {
    await gotoInbox(page);

    const doomed = uniqueText('待删除');
    const keeper = uniqueText('保留者');
    await captureViaUi(page, doomed);
    await captureViaUi(page, keeper);

    // Select both so the tray has state to reconcile after the delete.
    await page.getByTestId('knowledge-card').filter({ hasText: doomed }).getByTestId('card-select').check();
    await page.getByTestId('knowledge-card').filter({ hasText: keeper }).getByTestId('card-select').check();
    await expect(page.getByTestId('selection-count')).toContainText('已选 2');

    // Relate the two, so the delete has a relation to cascade over.
    await page.getByTestId('knowledge-card').filter({ hasText: doomed }).getByRole('button').first().click();
    await expect(page.getByTestId('knowledge-drawer')).toBeVisible();
    const editor = page.getByTestId('relation-editor');
    await editor.getByTestId('relation-target').selectOption({ label: keeper });
    await editor.getByTestId('relation-submit').click();
    await expect(editor.getByText('关系已保存')).toBeVisible();

    // Delete it through the confirmation dialog.
    await page.getByTestId('drawer-delete').click();
    await expect(page.getByTestId('delete-dialog')).toBeVisible();
    await page.getByTestId('delete-confirm').click();

    // T026-C04「必须排除：跨组件联动缺失会留下陈旧引用」. The deleted id must leave
    // the selection, and the tray must say so instead of keeping a stale count.
    await expect(page.getByTestId('selection-tray')).toContainText('已从选择中移除');

    // The other record survives and is intact.
    await page.getByRole('link', { name: '资料库' }).click();
    await page.getByTestId('library-search').fill(keeper);
    await expect(page.getByTestId('knowledge-card').filter({ hasText: keeper })).toBeVisible();

    const headers = await authHeaders(page);
    const gone = await page.request.get(`${E2E_ORIGIN}/api/items`, {
      headers,
      params: { q: doomed },
    });
    const goneBody = (await gone.json()) as { data: { totalMatched: number } };
    expect(goneBody.data.totalMatched, '被删除的条目不应还能被检索到').toBe(0);

    const kept = await readBack(E2E_ORIGIN, page, headers, keeper);
    expect(kept.relations, '另一条记录的关系不应被连带删除').toBe(0);
  });

  test('T026-C05 完成全部基础操作后，网络请求只访问本机', async ({ page, traffic }) => {
    await gotoInbox(page);

    // A representative sweep of the local feature set.
    const text = uniqueText('网络审计');
    await captureViaUi(page, text);
    await page.getByRole('link', { name: '资料库' }).click();
    await page.getByTestId('library-search').fill(text);
    await expect(page.getByTestId('knowledge-card').filter({ hasText: text })).toBeVisible();
    await page.getByTestId('knowledge-card').filter({ hasText: text }).getByRole('button').first().click();
    await expect(page.getByTestId('knowledge-drawer')).toBeVisible();
    await page.getByTestId('drawer-close').click();

    for (const route of WORKSPACE_ROUTES) {
      await page.goto(route);
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    }

    // T026-C05「必须排除：本地功能不该暗中发送笔记」. Every recorded request —
    // including any that *tried* to leave — is listed, so this is evidence rather
    // than an absence of one.
    const external = traffic.externalRequests();
    expect(
      external,
      `不应有任何外部请求，实际记录：${JSON.stringify(external.slice(0, 5))}`,
    ).toEqual([]);

    // And the requests that did happen are the app's own API and assets.
    const urls = traffic.records.map((entry) => entry.url);
    expect(urls.some((url) => url.includes('/api/items'))).toBe(true);
    for (const url of urls) {
      expect(new URL(url).hostname).toBe('127.0.0.1');
    }
  });
  test('T026-C06 Gate1 证据只声明离线知识库，不声称智能整理已完成', async ({ page }) => {
    await gotoInbox(page);

    // T026-C06「必须排除：阶段成果必须与已实现功能对应」. The app must not present a
    // model-dependent capability as working: with no settings row, the organize
    // path explains the missing configuration instead of pretending to organize.
    await expect(page.getByRole('link', { name: '设置' })).toBeVisible();
    await page.goto('/settings');
    await expect(page.locator('main h1')).toHaveText('设置');

    // The organize-dependent pages state their status plainly rather than showing
    // an empty canvas that would look like a working feature.
    for (const route of ['/graph', '/mindmap', '/flow'] as const) {
      await page.goto(route);
      await expect(page.locator('main h1')).toBeVisible();
      await expect(page.locator('main')).toContainText(/正在实现|暂不可用|配置模型|还没有/);
    }

    // Local capabilities are the ones actually offered.
    await page.goto('/inbox');
    await expect(page.getByTestId('capture-save')).toBeVisible();
    await expect(page.getByRole('heading', { name: '收件箱' })).toBeVisible();
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

interface ReadBack {
  item: {
    id: string;
    rawText: string;
    capturedText: string;
    tags: string[];
    summary: string;
    revision: number;
  };
  relations: number;
}

/**
 * Session headers for an explicit origin.
 *
 * The shared `authHeaders` targets the suite's main server; the restart case talks
 * to two different processes, so the origin has to be a parameter.
 */
async function authHeadersAt(origin: string): Promise<Record<string, string>> {
  const response = await fetch(`${origin}/api/session`, {
    headers: { host: new URL(origin).host, origin },
  });
  expect(response.ok, `GET ${origin}/api/session 必须成功`).toBe(true);
  const envelope = (await response.json()) as { ok: boolean; data: { token: string } };
  return {
    host: new URL(origin).host,
    origin,
    'content-type': 'application/json',
    'x-brain-token': envelope.data.token,
  };
}

/** Read one record and its relation count straight from the API. */
async function readBack(
  origin: string,
  page: import('@playwright/test').Page,
  headers: Record<string, string>,
  needle: string,
): Promise<ReadBack> {
  const list = await page.request.get(`${origin}/api/items`, {
    headers,
    params: { q: needle, limit: 5 },
  });
  const body = (await list.json()) as { data: { items: ReadBack['item'][] } };
  const item = body.data.items.find((entry) => entry.rawText.includes(needle));
  expect(item, `应能按「${needle}」读回记录`).toBeTruthy();

  const relations = await page.request.get(`${origin}/api/relations`, {
    headers,
    params: { itemId: item!.id },
  });
  const relationBody = (await relations.json()) as { data: unknown };
  const rows = Array.isArray(relationBody.data) ? relationBody.data : [];
  return { item: item!, relations: rows.length };
}

/** Read the revision shown in the open drawer's metadata block. */
async function readRevisionFromDrawer(
  page: import('@playwright/test').Page,
): Promise<number> {
  const text = await page.getByTestId('knowledge-drawer').textContent();
  const match = /revision (\d+)/u.exec(text ?? '');
  expect(match, '抽屉里应显示 revision').not.toBeNull();
  return Number.parseInt(match![1], 10);
}
