import { writeFile } from 'node:fs/promises';

import { expect, gotoInbox, test } from '../support/fixtures';
import { authHeaders, seedItemViaApi, uniqueText } from '../support/harness';
import { E2E_ORIGIN } from '../support/env';
import { readItem } from '../support/graph';
import { seedView, withSeedDb } from '../support/seedData';

/**
 * Evidence capture for T059 (not an acceptance case).
 *
 * Writes one screenshot of the freshness banner plus its regenerate confirmation
 * so the delivery evidence shows what the user actually sees, rather than only
 * asserting on test ids. Kept in `tests/e2e/evidence/` so the acceptance specs
 * stay free of side effects and so this file can be run on demand.
 *
 * Deliberately excluded from the default project (see the `testIgnore` in
 * `playwright.config.ts`): it produces artifacts, and an acceptance run must not
 * depend on artifacts existing.
 */
test('capture T059 freshness banner and regeneration confirmation', async ({ page }) => {
  await gotoInbox(page);
  const note = await captureNote(page, '证据-原文变化');
  const headers = await authHeaders(page);

  const viewId = withSeedDb((db) =>
    seedView(db, {
      name: uniqueText('证据脑图'),
      kind: 'mindmap',
      itemIds: [note.id],
      content: {
        title: '证据脑图根',
        nodes: [
          { id: 'm1', parentId: null, label: '证据脑图根', itemIds: [note.id], kind: 'group' },
          { id: 'm2', parentId: 'm1', label: '会被改写引用的分支', itemIds: [note.id], kind: 'note' },
        ],
      },
    }),
  );

  // Move the source so the banner has something specific to report.
  const before = await readItem(page, headers, note.id);
  await page.request.patch(`${E2E_ORIGIN}/api/items/${note.id}`, {
    headers,
    data: {
      expectedRevision: before.revision,
      patch: { rawText: `${note.text}\nT059 证据：生成之后改写的一行` },
    },
  });

  await page.goto('/mindmap');
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await page.getByTestId('mindmap-view-select').selectOption(viewId);

  await expect(page.getByTestId('view-freshness-banner')).toBeVisible();
  await expect(page.getByTestId('view-freshness-reason')).toContainText('条笔记已修改');
  await page.screenshot({
    path: 'implementation/progress/evidence/assets/T059-freshness-banner.png',
    fullPage: true,
  });

  await page.getByTestId('regenerate-open').click();
  await expect(page.getByTestId('regenerate-confirm')).toBeVisible();
  await page.screenshot({
    path: 'implementation/progress/evidence/assets/T059-regenerate-confirm.png',
    fullPage: true,
  });

  // T060's surface: the export menu with its two implemented formats and the
  // stale warning that precedes the download.
  await page.getByTestId('regenerate-confirm-cancel').click();
  await expect(page.getByTestId('export-mindmap')).toBeVisible();
  await expect(page.getByTestId('export-markdown')).toBeVisible();
  await expect(page.getByTestId('export-json')).toBeVisible();
  await expect(page.getByTestId('export-stale-warning')).toBeVisible();
  await page.screenshot({
    path: 'implementation/progress/evidence/assets/T060-export-menu.png',
    fullPage: true,
  });

  // And the exported file itself, fetched through the same guarded route the app
  // uses, so the evidence shows real bytes rather than a description of them.
  const response = await page.request.get(
    `${E2E_ORIGIN}/api/views/${viewId}/export?format=markdown`,
    { headers },
  );
  expect(response.status(), 'Markdown 导出应返回 200').toBe(200);
  const body = await response.text();
  expect(body).toContain('依据可能已过期');
  await writeFile(
    'implementation/progress/evidence/assets/T060-exported-markdown.md',
    body,
    'utf8',
  );
});

async function captureNote(
  page: import('@playwright/test').Page,
  prefix: string,
): Promise<{ text: string; id: string }> {
  const text = uniqueText(prefix);
  const id = await seedItemViaApi(page, { rawText: text });
  return { text, id };
}
