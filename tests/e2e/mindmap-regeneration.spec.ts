import { expect, gotoInbox, test } from './support/fixtures';
import { authHeaders, seedItemViaApi, uniqueText, revealMindmapOutline } from './support/harness';
import { E2E_ORIGIN } from './support/env';
import { readItem } from './support/graph';
import { seedView, tagItems, withSeedDb } from './support/seedData';

/**
 * T059 验收｜视图过期、再生成与历史保留
 *
 * The cases are about a *relationship* between two moments: the material as it was
 * when the view was generated, and the material as it is now. Every one of them
 * therefore establishes a baseline, moves something, and then asserts on the pair
 * of facts — never on one alone.
 *
 * Five choices worth stating:
 *
 *  1. **Views are seeded; items are real.** A generated view needs a live model
 *     (T011-C03 rules out shipping a fake), so the view row is written directly.
 *     The items it cites are created through the real capture endpoint and mutated
 *     through the real PATCH/DELETE endpoints, so the versions compared are
 *     genuine — asserting on fabricated versions would prove nothing.
 *
 *  2. **The drift happens between the seed and the read.** Editing first and
 *     seeding second would leave the snapshot already matching, which is the case
 *     that needs no banner. Order is the test.
 *
 *  3. **"Not silently rewritten" is asserted, not assumed.** T059-C01/C03 are
 *     about the *absence* of a change, so each reads the view's content, hash and
 *     generatedAt before and after and compares them. A test that only checked the
 *     banner text would pass against an implementation that promptly overwrote the
 *     map.
 *
 *  4. **Regeneration is checked at the boundary the user actually reaches.** The
 *     confirmation dialog is part of the contract (T059-C04 says the user must be
 *     told which material will be sent), so the scope shown there is asserted
 *     before confirming.
 *
 *  5. **The empty case never reaches the provider.** T059-C06 is asserted by
 *     watching requests: the refusal must happen locally. A 502 from a provider
 *     that was handed an empty prompt would be the wrong failure and would mean
 *     material was invented from nothing.
 */

interface MindmapNodeLike {
  id: string;
  parentId: string | null;
  label: string;
  itemIds: string[];
  kind: 'group' | 'note';
}

interface MindmapContentLike {
  title: string;
  nodes: MindmapNodeLike[];
}

/** A root group over the given ids, plus one leaf per entry. */
function tree(title: string, rootItemIds: string[], children: { label: string; itemIds: string[] }[]): MindmapContentLike {
  return {
    title,
    nodes: [
      { id: 'm1', parentId: null, label: title, itemIds: rootItemIds, kind: 'group' },
      ...children.map((child, index) => ({
        id: `m${index + 2}`,
        parentId: 'm1',
        label: child.label,
        itemIds: child.itemIds,
        kind: 'note' as const,
      })),
    ],
  };
}

function seedMindmapView(name: string, itemIds: string[], content: unknown): string {
  return withSeedDb((db) => seedView(db, { name, kind: 'mindmap', itemIds, content }));
}

async function openMindmap(page: import('@playwright/test').Page, viewId: string): Promise<void> {
  await page.goto('/mindmap');
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await page.getByTestId('mindmap-view-select').selectOption(viewId);
  await revealMindmapOutline(page);
}

async function capture(
  page: import('@playwright/test').Page,
  prefix: string,
): Promise<{ text: string; id: string }> {
  const text = uniqueText(prefix);
  const id = await seedItemViaApi(page, { rawText: text });
  return { text, id };
}

/** Read a view through the API, for the before/after comparisons. */
async function readView(
  page: import('@playwright/test').Page,
  headers: Record<string, string>,
  viewId: string,
): Promise<{
  content: unknown;
  contentHash: string | null;
  generatedAt: string | null;
  isStale: boolean;
  missingSources: string[];
  revision: number;
  name: string;
}> {
  const response = await page.request.get(`${E2E_ORIGIN}/api/views/${viewId}`, { headers });
  expect(response.status(), '读取视图应返回 200').toBe(200);
  const envelope = (await response.json()) as { data: Record<string, unknown> };
  return envelope.data as never;
}

/** The ids of every saved mindmap, for "a failed attempt added nothing" checks. */
async function listMindmapIds(
  page: import('@playwright/test').Page,
  headers: Record<string, string>,
): Promise<string[]> {
  const response = await page.request.get(`${E2E_ORIGIN}/api/views?kind=mindmap&limit=50`, {
    headers,
  });
  expect(response.status(), '列出视图应返回 200').toBe(200);
  const envelope = (await response.json()) as { data: { views: { id: string }[] } };
  return envelope.data.views.map((view) => view.id).sort();
}

/** Edit an item's raw text through the product's own endpoint. */
async function editItemText(
  page: import('@playwright/test').Page,
  headers: Record<string, string>,
  itemId: string,
  nextText: string,
): Promise<void> {
  const before = await readItem(page, headers, itemId);
  const response = await page.request.patch(`${E2E_ORIGIN}/api/items/${itemId}`, {
    headers,
    data: {
      expectedRevision: before.revision,
      patch: { rawText: nextText },
    },
  });
  expect(response.status(), 'PATCH 原文应返回 200').toBe(200);
}

test.describe('T059 视图过期、再生成与历史保留', () => {
  test('T059-C01 原文变化：显示过期原因，图内容不被暗改', async ({ page }) => {
    await gotoInbox(page);
    const note = await capture(page, '原文变化');
    const headers = await authHeaders(page);

    const viewId = seedMindmapView(
      uniqueText('原文变化脑图'),
      [note.id],
      tree('原文变化根', [note.id], [{ label: '引用会被改写的记录', itemIds: [note.id] }]),
    );

    const before = await readView(page, headers, viewId);
    expect(before.isStale, '刚生成时不应是过期的').toBe(false);

    // Move the source *after* the snapshot was taken. This is the whole premise of
    // the case: the view is a record of an earlier moment.
    await editItemText(page, headers, note.id, `${note.text}\nT059-C01 生成之后改写的一行`);

    await openMindmap(page, viewId);

    const banner = page.getByTestId('view-freshness-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('data-stale', 'true');
    // The reason names what changed, not merely that something did (T059-R01).
    await expect(page.getByTestId('view-freshness-reason')).toContainText('条笔记已修改');

    // The banner's own statement: the picture is the one that was generated.
    await expect(page.getByTestId('view-freshness-scope')).toContainText('仍然显示生成时的内容');

    // "未被暗改" is an invariant about stored state, so it is checked against stored
    // state: content, hash and generatedAt must all be untouched by the *read*.
    const after = await readView(page, headers, viewId);
    expect(after.content, '读取不应改写图内容').toEqual(before.content);
    expect(after.contentHash, '读取不应重算哈希').toBe(before.contentHash);
    expect(after.generatedAt, '读取不应改动生成时间').toBe(before.generatedAt);
    expect(after.isStale, '过期状态应被报告').toBe(true);
  });

  test('T059-C02 再生成成功：产生新 ID，旧视图仍可访问', async ({ page }) => {
    await gotoInbox(page);
    const note = await capture(page, '再生成成功');
    const headers = await authHeaders(page);

    const viewId = seedMindmapView(
      uniqueText('再生成成功旧图'),
      [note.id],
      tree('再生成成功根', [note.id], [{ label: '旧图的分支', itemIds: [note.id] }]),
    );

    await openMindmap(page, viewId);
    const before = await readView(page, headers, viewId);
    const listBefore = await listMindmapIds(page, headers);

    // The confirmation is the part of this case a browser can prove: the user is
    // told a *new* map will be created and the old one kept, and told which
    // material would be sent (T059-C04's requirement, reached through the same
    // control that actually spends the money).
    await page.getByTestId('regenerate-open').click();
    const confirm = page.getByTestId('regenerate-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('1 条来源');
    await expect(confirm).toContainText('新旧两张会同时保留');
    await expect(page.getByTestId('regenerate-same')).toBeVisible();

    await page.getByTestId('regenerate-confirm-go').click();

    // This environment has no provider configured, so the attempt ends in a
    // *reported* failure rather than a fabricated success — which is the other
    // half of T059-C02/C03 and worth asserting rather than hiding: the product
    // must say what went wrong instead of pretending to have generated something.
    // "产生新 ID" itself is a service-level fact, covered with a real stub adapter
    // and a real second insert in tests/integration/view-regeneration.test.ts
    // (T059-R02) — a browser run cannot honestly prove it without a live model.
    const failure = page.locator('[role="alert"]').filter({ hasText: '原图没有被改动' });
    await expect(failure).toBeVisible({ timeout: 30_000 });

    const after = await readView(page, headers, viewId);
    // Same id, same revision, same content, same time. "新生成总是新 View"
    // (docs/03_contracts/09 §5) — an attempt is not a rewrite of its source.
    expect(after.content, '旧图内容不应被覆盖').toEqual(before.content);
    expect(after.contentHash, '旧图哈希不应被覆盖').toBe(before.contentHash);
    expect(after.generatedAt, '旧图生成时间不应被覆盖').toBe(before.generatedAt);
    expect(after.revision, '旧图不应被写入').toBe(before.revision);
    expect(after.name, '旧图名称不应被覆盖').toBe(before.name);

    // A failed attempt adds no view either: the list is exactly what it was, so
    // nothing half-built was left behind.
    expect(await listMindmapIds(page, headers)).toEqual(listBefore);

    // And the old view is still openable through the list.
    await openMindmap(page, viewId);
    await expect(page.getByTestId('mindmap-outline-node').first()).toContainText('再生成成功根');
  });

  test('T059-C03 再生成失败：保持原内容与时间', async ({ page }) => {
    await gotoInbox(page);
    const note = await capture(page, '再生成失败');
    const headers = await authHeaders(page);

    const viewId = seedMindmapView(
      uniqueText('再生成失败旧图'),
      [note.id],
      tree('再生成失败根', [note.id], [{ label: '失败也要保留的分支', itemIds: [note.id] }]),
    );

    await openMindmap(page, viewId);
    const before = await readView(page, headers, viewId);

    // Force the new request to fail at the transport layer, which is the harshest
    // version of "新请求返回错误": the response never arrives at all.
    await page.route('**/api/views/mindmap/generate', (route) => route.abort('failed'));

    await page.getByTestId('regenerate-open').click();
    await page.getByTestId('regenerate-confirm-go').click();

    // The failure is reported and the old map is explicitly said to be unchanged.
    await expect(page.getByText('原图没有被改动')).toBeVisible({ timeout: 30_000 });

    const after = await readView(page, headers, viewId);
    expect(after.content, '失败不应改动内容').toEqual(before.content);
    expect(after.contentHash, '失败不应改动哈希').toBe(before.contentHash);
    expect(after.generatedAt, '失败不应改动生成时间').toBe(before.generatedAt);

    // The map is still readable, which is the point of the case: an error must not
    // destroy an existing result.
    await revealMindmapOutline(page);
  });

  test('T059-C04 标签成员变化：显示新的选择数量供确认', async ({ page }) => {
    await gotoInbox(page);
    const first = await capture(page, '标签成员-甲');
    const second = await capture(page, '标签成员-乙');

    // A filter-backed view: the selection is stored as a *filter*, so it is
    // re-resolved on every read and legitimately covers a different set now than it
    // did at generation time. The snapshot stays frozen regardless (T054-C04).
    const tagLabel = uniqueText('成员变化标签');
    const tagId = tagItems([first.id], tagLabel);
    expect(tagId).toBeTruthy();

    // Seeded while the tag had one member, so the recorded snapshot is that one.
    const viewId = withSeedDb((db) =>
      seedView(db, {
        name: uniqueText('标签成员脑图'),
        kind: 'mindmap',
        itemIds: [first.id],
        content: tree('标签成员根', [first.id], [{ label: '按标签选中的一条', itemIds: [first.id] }]),
        selection: { mode: 'filter', filter: { tagId } },
        selectionItems: [first.id],
      }),
    );

    // The second member joins the tag *after* the view was saved.
    tagItems([second.id], tagLabel);

    await openMindmap(page, viewId);

    // The stored snapshot had one source; the filter now matches two. The user is
    // told the *new* number, because that is what would be sent.
    await page.getByTestId('regenerate-open').click();
    const confirm = page.getByTestId('regenerate-confirm');
    await expect(confirm).toBeVisible();
    await expect(page.getByTestId('regenerate-scope')).toContainText('2 条来源');
    await expect(confirm).toContainText('2 条来源');
    // Both numbers appear, so "what changed about the selection?" is answerable.
    await expect(confirm).toContainText('原图生成时是 1 条');
    await expect(page.getByTestId('regenerate-added')).toContainText('新增 1 条');

    // The old map itself was not rewritten by the tag gaining a member.
    const headers = await authHeaders(page);
    const view = await readView(page, headers, viewId);
    expect(view.content).toEqual(
      tree('标签成员根', [first.id], [{ label: '按标签选中的一条', itemIds: [first.id] }]),
    );
  });

  test('T059-C05 只改名称：不调用模型，不更新 generatedAt', async ({ page, traffic }) => {
    await gotoInbox(page);
    const note = await capture(page, '只改名称');
    const headers = await authHeaders(page);

    const viewId = seedMindmapView(
      uniqueText('只改名称旧图'),
      [note.id],
      tree('只改名称根', [note.id], [{ label: '改名不应影响的分支', itemIds: [note.id] }]),
    );

    const before = await readView(page, headers, viewId);

    // A rename goes through the real PATCH endpoint — the same one the product
    // uses. `traffic` observes the requests the page makes, and the API check
    // below observes the outcome; the two together are the claim.
    traffic.reset();
    const renamed = await page.request.patch(`${E2E_ORIGIN}/api/views/${viewId}`, {
      headers,
      data: { expectedRevision: before.revision, name: uniqueText('改名之后') },
    });
    expect(renamed.status(), 'PATCH 名称应返回 200').toBe(200);

    const after = await readView(page, headers, viewId);
    expect(after.name, '名称应已更新').not.toBe(before.name);
    // The three things a rename must not touch. `generatedAt` is the one the case
    // names: a rename is not a re-analysis.
    expect(after.generatedAt, '改名不应改动生成时间').toBe(before.generatedAt);
    expect(after.content, '改名不应改动内容').toEqual(before.content);
    expect(after.contentHash, '改名不应改动哈希').toBe(before.contentHash);

    // No generation request was issued by the rename itself.
    expect(
      traffic.apiRequests().filter((request) => request.url.includes('/mindmap/generate')),
      '改名不应触发模型请求',
    ).toEqual([]);
  });

  test('T059-C06 来源全删：阻止无材料生成，旧图仍可读', async ({ page, traffic }) => {
    await gotoInbox(page);
    const doomed = await capture(page, '来源全删');
    const headers = await authHeaders(page);

    const viewId = seedMindmapView(
      uniqueText('来源全删脑图'),
      [doomed.id],
      tree('来源全删根', [doomed.id], [{ label: '唯一来源会被删除', itemIds: [doomed.id] }]),
    );

    // Remove every source the view cites, so nothing is left to organise.
    const item = await readItem(page, headers, doomed.id);
    const deleted = await page.request.delete(`${E2E_ORIGIN}/api/items/${doomed.id}`, {
      headers,
      data: { expectedRevision: item.revision },
    });
    expect(deleted.status(), 'DELETE 条目应返回 200').toBe(200);

    await openMindmap(page, viewId);
    traffic.reset();

    // The refusal is stated, and no button invites a request that cannot work.
    const blocked = page.getByTestId('regenerate-blocked');
    await expect(blocked).toBeVisible();
    await expect(blocked).toContainText('全部删除');
    await expect(page.getByTestId('regenerate-open')).toHaveCount(0);

    // "阻止无材料请求" is checked at the wire: nothing was sent, so no provider
    // could have been asked to invent sources from an empty prompt.
    expect(
      traffic.apiRequests().filter((request) => request.url.includes('/mindmap/generate')),
      '来源全删后不应发起生成请求',
    ).toEqual([]);

    // The old map is still readable and still lists its now-missing source.
    await revealMindmapOutline(page);
    await expect(page.getByTestId('mindmap-outline-node')).toHaveCount(2);
    await page.getByTestId('mindmap-outline-select').nth(1).click();
    await expect(page.getByTestId('source-missing')).toBeVisible();
  });
});
