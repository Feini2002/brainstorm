import { expect, gotoInbox, test } from './support/fixtures';
import { authHeaders, seedItemViaApi, uniqueText } from './support/harness';
import { E2E_ORIGIN } from './support/env';
import { readItem } from './support/graph';
import { seedView, withSeedDb } from './support/seedData';

/**
 * T060 验收｜脑图 Markdown 与 JSON 导出
 *
 * A download is easy to fake and easy to test badly: asserting that a button
 * exists proves nothing about the file. So every case here reads the **actual
 * bytes** the route returned and asserts on their content and headers, and the one
 * case about the menu asserts the absence of the buttons that must not exist.
 *
 * Four choices worth stating:
 *
 *  1. **The bytes are fetched with the session token, the same way the app fetches
 *     them.** `page.request` bypasses the UI's blob handling but keeps the auth
 *     path, so a route that forgot its guard fails here rather than passing.
 *
 *  2. **Views are seeded; items are real.** Reusing T058/T059's arrangement, so the
 *     source ids and versions written into the file are genuine rows.
 *
 *  3. **The stale case moves the source before exporting.** A snapshot only has
 *     something to report once the record has moved past it, and the export must
 *     show that — the file is the case where the user has no UI left to ask.
 *
 *  4. **`Content-Disposition` is asserted on the hostile-name case.** That header
 *     is the boundary where a title could become a path, and a test on the UI text
 *     would not see it.
 */

interface MindmapNodeLike {
  id: string;
  parentId: string | null;
  label: string;
  itemIds: string[];
  kind: 'group' | 'note';
}

function tree(title: string, itemIds: string[]): { title: string; nodes: MindmapNodeLike[] } {
  return {
    title,
    nodes: [
      { id: 'm1', parentId: null, label: title, itemIds, kind: 'group' },
      ...itemIds.map((itemId, index) => ({
        id: `m${index + 2}`,
        parentId: 'm1',
        label: `导出分支 ${index + 1}`,
        itemIds: [itemId],
        kind: 'note' as const,
      })),
    ],
  };
}

function seedMindmap(name: string, itemIds: string[], content: unknown): string {
  return withSeedDb((db) => seedView(db, { name, kind: 'mindmap', itemIds, content }));
}

async function openMindmap(page: import('@playwright/test').Page, viewId: string): Promise<void> {
  await page.goto('/mindmap');
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await page.getByTestId('mindmap-view-select').selectOption(viewId);
  await expect(page.getByTestId('mindmap-outline')).toBeVisible();
}

async function capture(
  page: import('@playwright/test').Page,
  prefix: string,
): Promise<{ text: string; id: string }> {
  const text = uniqueText(prefix);
  const id = await seedItemViaApi(page, { rawText: text });
  return { text, id };
}

/** Fetch an export exactly as the app does, returning the raw response. */
async function fetchExport(
  page: import('@playwright/test').Page,
  headers: Record<string, string>,
  viewId: string,
  format: 'markdown' | 'json',
): Promise<{ status: number; body: string; disposition: string | null; contentType: string }> {
  const response = await page.request.get(
    `${E2E_ORIGIN}/api/views/${viewId}/export?format=${format}`,
    { headers },
  );
  return {
    status: response.status(),
    body: await response.text(),
    disposition: response.headers()['content-disposition'] ?? null,
    contentType: response.headers()['content-type'] ?? '',
  };
}

test.describe('T060 脑图 Markdown 与 JSON 导出', () => {
  test('T060-C01 中文编码：导出的 Markdown 重新打开后完整无乱码', async ({ page }) => {
    await gotoInbox(page);
    const note = await capture(page, '中文导出-甲');
    const second = await capture(page, '中文导出-乙');
    const headers = await authHeaders(page);

    const title = uniqueText('中文标题-含标点，与「引号」');
    const viewId = seedMindmap(title, [note.id, second.id], tree(title, [note.id, second.id]));

    await openMindmap(page, viewId);

    // The download goes through the real route with the real session token.
    const file = await fetchExport(page, headers, viewId, 'markdown');
    expect(file.status, 'Markdown 导出应返回 200').toBe(200);
    expect(file.contentType).toContain('text/markdown');

    // The Chinese survives byte-for-byte, including the punctuation.
    expect(file.body).toContain(title);
    expect(file.body).toContain('导出分支 1');
    expect(file.body).toContain('导出分支 2');
    expect(file.body).not.toContain('\uFFFD');

    // Both real source ids and their versions are listed, so the file is traceable.
    expect(file.body).toContain(note.id);
    expect(file.body).toContain(second.id);
    expect(file.body).toContain('## 来源清单（2 条）');
  });

  test('T060-C02 危险名称：点击下载得到安全文件名', async ({ page }) => {
    await gotoInbox(page);
    const note = await capture(page, '危险名称');
    const headers = await authHeaders(page);

    // A name with path separators, reserved characters and a Windows device name.
    const hostile = '..\\..\\Windows\\System32/CON:<>|?*';
    const viewId = seedMindmap(hostile, [note.id], tree('安全标题', [note.id]));

    await openMindmap(page, viewId);

    const file = await fetchExport(page, headers, viewId, 'json');
    expect(file.status).toBe(200);
    expect(file.disposition, '必须带下载文件名').not.toBeNull();

    const name = /filename="([^"]+)"/u.exec(file.disposition ?? '')?.[1] ?? '';
    // The header carries the safe name built from view id + date...
    expect(name).toBe(`feini-mindmap-${viewId}-${new Date().toISOString().slice(0, 10)}.json`);
    // ...and nothing from the title reached it.
    expect(name).not.toMatch(/[\\/:*?"<>|]/u);
    expect(name).not.toContain('CON');
    expect(name).not.toContain('System32');
    expect(name).not.toContain('..');

    // The title is still in the file's *content*, where it costs nothing.
    expect((JSON.parse(file.body) as { name: string }).name).toBe(hostile);
  });

  test('T060-C03 秘密检查：导出脑图 JSON 里没有 Key 或 Authorization', async ({ page }) => {
    await gotoInbox(page);
    const note = await capture(page, '秘密检查');
    const headers = await authHeaders(page);

    const viewId = seedMindmap(uniqueText('秘密检查脑图'), [note.id], tree('秘密检查', [note.id]));
    await openMindmap(page, viewId);

    const json = await fetchExport(page, headers, viewId, 'json');
    const markdown = await fetchExport(page, headers, viewId, 'markdown');

    for (const file of [json, markdown]) {
      expect(file.status).toBe(200);
      // No credential shape, and no settings fields that could carry one.
      expect(file.body).not.toMatch(/sk-[A-Za-z0-9-]{8,}/u);
      expect(file.body).not.toMatch(/authorization/iu);
      expect(file.body).not.toMatch(/bearer\s/iu);
      expect(file.body).not.toContain('apiKey');
      expect(file.body).not.toContain('baseUrl');
      // The session token the request used must not appear in its own response.
      expect(file.body).not.toContain(headers['x-brain-token'] ?? '\u0000impossible');
    }
  });

  test('T060-C04 过期标记：导出说明生成依据时间与过期状态', async ({ page }) => {
    await gotoInbox(page);
    const note = await capture(page, '过期导出');
    const headers = await authHeaders(page);

    const viewId = seedMindmap(uniqueText('过期导出脑图'), [note.id], tree('过期导出', [note.id]));

    // Move the source *after* the view was seeded, then export.
    const before = await readItem(page, headers, note.id);
    const patched = await page.request.patch(`${E2E_ORIGIN}/api/items/${note.id}`, {
      headers,
      data: {
        expectedRevision: before.revision,
        patch: { rawText: `${before.rawText}\nT060-C04 生成之后改写的一行` },
      },
    });
    expect(patched.status(), 'PATCH 原文应返回 200').toBe(200);

    await openMindmap(page, viewId);

    // The UI warns before download, so the file's caveat is not a surprise.
    await expect(page.getByTestId('export-stale-warning')).toBeVisible();
    await expect(page.getByTestId('export-stale-warning')).toContainText('条笔记已修改');

    const file = await fetchExport(page, headers, viewId, 'markdown');
    // The file itself carries both times and the verdict — this is the only place a
    // reader with no application can learn the basis moved.
    expect(file.body).toContain('生成时间：');
    expect(file.body).toContain('导出时间：');
    expect(file.body).toContain('依据可能已变化');
    expect(file.body).toContain('1 条笔记已修改');
    expect(file.body).toContain('不代表知识库的最新状态');

    const json = JSON.parse((await fetchExport(page, headers, viewId, 'json')).body) as {
      generatedAt: string | null;
      exportedAt: string;
      freshness: { isStale: boolean };
    };
    expect(json.freshness.isStale).toBe(true);
    // Generated and exported are separate facts and must not be conflated.
    expect(json.generatedAt).not.toBe(json.exportedAt);
  });

  test('T060-C05 可重复编译：同一棵树导出两次只有导出时间不同', async ({ page }) => {
    await gotoInbox(page);
    const note = await capture(page, '可重复编译');
    const headers = await authHeaders(page);

    const viewId = seedMindmap(
      uniqueText('可重复编译脑图'),
      [note.id],
      tree('可重复编译', [note.id]),
    );
    await openMindmap(page, viewId);

    const first = await fetchExport(page, headers, viewId, 'markdown');
    const second = await fetchExport(page, headers, viewId, 'markdown');

    // T060-C05 allows exactly one difference: the explicit export time. Everything
    // else must be identical, so normalizing that one line must make the two files
    // byte-for-byte equal. Asserting raw equality would be stricter than the
    // contract and would fail on a clock tick rather than on a real regression.
    const stripExportTime = (text: string) => text.replace(/^- 导出时间：.*$/mu, '- 导出时间：（略）');
    expect(stripExportTime(second.body)).toBe(stripExportTime(first.body));
    // Structure comes from the compiled tree, not a re-render.
    expect(first.body.split('\n')[0]).toBe('# 可重复编译');
    expect(second.body.split('\n')[0]).toBe('# 可重复编译');

    // The JSON agrees on content and hash across the two downloads.
    const a = JSON.parse((await fetchExport(page, headers, viewId, 'json')).body) as {
      content: unknown;
      contentHash: string | null;
    };
    const b = JSON.parse((await fetchExport(page, headers, viewId, 'json')).body) as {
      content: unknown;
      contentHash: string | null;
    };
    expect(b.content).toEqual(a.content);
    expect(b.contentHash).toBe(a.contentHash);
  });

  test('T060-C06 无额外格式：只提供已实现格式，不显示无效 PDF 按钮', async ({ page }) => {
    await gotoInbox(page);
    const note = await capture(page, '格式检查');

    const viewId = seedMindmap(uniqueText('格式检查脑图'), [note.id], tree('格式检查', [note.id]));
    await openMindmap(page, viewId);

    // Exactly the two implemented formats are offered.
    await expect(page.getByTestId('export-markdown')).toBeVisible();
    await expect(page.getByTestId('export-json')).toBeVisible();

    // No control suggests a capability that does not exist. Checked by text as well
    // as by test id, because the failure mode is a button someone adds later.
    const menu = page.getByTestId('export-mindmap');
    await expect(menu.locator('button')).toHaveCount(2);
    await expect(menu).not.toContainText('PDF');
    await expect(menu).not.toContainText('SVG');
    await expect(menu).not.toContainText('PNG');

    // Asking for an unimplemented format is refused, not silently defaulted — a
    // silent default would let a caller believe they got a PDF.
    const pdf = await page.request.get(`${E2E_ORIGIN}/api/views/${viewId}/export?format=pdf`, {
      headers: await authHeaders(page),
    });
    expect(pdf.status(), '未实现的格式应被拒绝').toBe(400);
    const envelope = (await pdf.json()) as { ok: boolean; error: { code: string } };
    // A JSON error, not an empty file that looks like a broken PDF.
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('VALIDATION');
  });
});
