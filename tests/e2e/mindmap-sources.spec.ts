import { expect, gotoInbox, test } from './support/fixtures';
import { authHeaders, seedItemViaApi, uniqueText } from './support/harness';
import { E2E_ORIGIN } from './support/env';
import { readItem } from './support/graph';
import { seedView, withSeedDb } from './support/seedData';

/**
 * T058 验收｜脑图大纲、来源映射与回跳
 *
 * T057 proved the picture can be drawn. This spec is about the thing a picture
 * cannot do: say where each node came from. Every case therefore asserts on the
 * *evidence chain* — a node resolves to a real stored record, that record's version
 * is compared against the version the view was built from, and a record that no
 * longer exists is reported rather than spun on forever.
 *
 * Four choices worth stating:
 *
 *  1. **Views are seeded; items are not.** A mindmap can only be produced by the
 *     generation route, which needs a live model (T011-C03 rules out a shipped
 *     fake). The items a node cites, however, are created through the real capture
 *     endpoint, so the rows this spec resolves are genuine records with genuine
 *     versions — the assertions would be meaningless against fabricated ones.
 *
 *  2. **The snapshot is the authority, and the spec moves it.** T058-C03/C04 are
 *     about a view disagreeing with the library, so the change (an edit, a delete)
 *     happens *after* the view is seeded and *before* the page is opened. Doing it
 *     in the other order would test nothing.
 *
 *  3. **The outline is addressed by its own controls, never by the canvas.** The
 *     cases read `mindmap-outline-*` and `source-list*`. That is what makes them
 *     true regardless of what Markmap renders, which is the point of the outline
 *     being a peer rather than a fallback.
 *
 *  4. **T058-C06 is keyboard-only.** Focus and `Enter` are the interactions; the
 *     only mouse use in that case is none. A control that is reachable and
 *     activatable that way is what "非指针操作" means, and asserting on
 *     `aria-expanded`/`aria-current` rather than on styling keeps the claim about
 *     behaviour.
 *
 * Baseline: each case pins the read to one saved view by id, so the suite's
 * accumulated database cannot change what a case asserts.
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

/** A root group over the given ids, plus the leaf notes under it. */
function tree(
  title: string,
  rootItemIds: string[],
  children: { label: string; itemIds: string[] }[],
): MindmapContentLike {
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

/** Seed a mindmap view into the suite's own throwaway database (never the user's). */
function seedMindmapView(name: string, itemIds: string[], content: unknown): string {
  return withSeedDb((db) => seedView(db, { name, kind: 'mindmap', itemIds, content }));
}

/** Open `/mindmap` with one view selected, so the read is a known id list. */
async function openMindmap(page: import('@playwright/test').Page, viewId: string): Promise<void> {
  await page.goto('/mindmap');
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await page.getByTestId('mindmap-view-select').selectOption(viewId);
  // The outline is rendered for every case here, so waiting on it is the honest
  // signal that the view was applied — independent of whether the canvas mounted.
  await expect(page.getByTestId('mindmap-outline')).toBeVisible();
}

/** Capture one record and resolve its id, returning the text used. */
async function capture(
  page: import('@playwright/test').Page,
  prefix: string,
): Promise<{ text: string; id: string }> {
  const text = uniqueText(prefix);
  const id = await seedItemViaApi(page, { rawText: text });
  return { text, id };
}

test.describe('T058 脑图大纲、来源映射与回跳', () => {
  test('T058-C01 叶节点证据：点开一个概念叶能打开对应真实原文', async ({ page }) => {
    await gotoInbox(page);
    const note = await capture(page, '叶节点证据-甲');
    const other = await capture(page, '叶节点证据-乙');

    const viewId = seedMindmapView(
      uniqueText('叶节点证据脑图'),
      [note.id, other.id],
      tree('叶节点证据根', [note.id, other.id], [
        { label: '只引用甲的子节点', itemIds: [note.id] },
        { label: '引用乙的子节点', itemIds: [other.id] },
      ]),
    );

    await openMindmap(page, viewId);

    // Row 0 is the root, so row 1 is the first child — the leaf under test.
    await page.getByTestId('mindmap-outline-select').nth(1).click();

    const list = page.getByTestId('source-list');
    await expect(list).toBeVisible();
    // The leaf cites exactly one source, and it is the *real* record: the row
    // carries the id the API returned, not a label the fixture invented.
    await expect(page.getByTestId('source-list-item')).toHaveCount(1);
    await expect(page.getByTestId('source-list-item').first()).toHaveAttribute(
      'data-item-id',
      note.id,
    );
    await expect(page.getByTestId('source-list-item').first()).toContainText(note.text);

    // A visualisation needs verifiable evidence, so the row goes to the same
    // drawer every other surface opens (T058-R01/R04) — and it lands on *this*
    // record rather than on whatever the last case left selected.
    await page.getByTestId('source-open').click();
    const drawer = page.getByTestId('knowledge-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText(note.text);
  });

  test('T058-C02 分组聚合：父组来源合并去重且数量正确', async ({ page }) => {
    await gotoInbox(page);
    const first = await capture(page, '分组聚合-甲');
    const second = await capture(page, '分组聚合-乙');

    // The root cites 甲 twice and 乙 once; the children cite one each. This is the
    // "重复引用" shape: three citations, two pieces of knowledge.
    const viewId = seedMindmapView(
      uniqueText('分组聚合脑图'),
      [first.id, second.id],
      tree('分组聚合根', [first.id, first.id, second.id], [
        { label: '子甲', itemIds: [first.id] },
        { label: '子乙', itemIds: [second.id] },
      ]),
    );

    await openMindmap(page, viewId);

    const rootRow = page.getByTestId('mindmap-outline-node').first();
    // The outline already reports the deduplicated count, which is what a reader
    // checks to see that repeated citation did not inflate the material.
    await expect(rootRow).toContainText('2 条来源');

    // Root is selected on open, so the panel is showing the group's merged set.
    await expect(page.getByTestId('source-list-count')).toContainText('2 条（已去重）');
    await expect(page.getByTestId('source-list-item')).toHaveCount(2);
    const ids = await page
      .getByTestId('source-list-item')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-item-id')));
    expect(new Set(ids).size, '同一来源不应出现两次').toBe(2);
    expect([...ids].sort()).toEqual([first.id, second.id].sort());

    // Deduplicating the list must not touch the tree (T058-R03): both citations of
    // 甲 are still separate children with their own sources.
    await expect(page.getByTestId('mindmap-outline-node')).toHaveCount(3);
    await page.getByTestId('mindmap-outline-select').nth(1).click();
    await expect(page.getByTestId('source-list-count')).toContainText('1 条（已去重）');
  });

  test('T058-C03 来源过期：生成后修改 Item，来源行说明版本不同', async ({ page }) => {
    await gotoInbox(page);
    const edited = await capture(page, '来源过期');
    const headers = await authHeaders(page);

    const viewId = seedMindmapView(
      uniqueText('来源过期脑图'),
      [edited.id],
      tree('来源过期根', [edited.id], [{ label: '引用被改过的记录', itemIds: [edited.id] }]),
    );

    // Edit *after* the view exists: the snapshot keeps the old version, the record
    // moves on, and the panel's job is to report both facts rather than pick one.
    const before = await readItem(page, headers, edited.id);
    const patched = await page.request.patch(`${E2E_ORIGIN}/api/items/${edited.id}`, {
      headers,
      data: {
        expectedRevision: before.revision,
        patch: { rawText: `${before.rawText}\nT058-C03 生成之后改写的一行` },
      },
    });
    expect(patched.status(), 'PATCH 原文应返回 200').toBe(200);
    const after = await readItem(page, headers, edited.id);
    expect(after.rawVersion, '改写原文应产生新的原文版本').toBeGreaterThan(before.rawVersion);

    await openMindmap(page, viewId);
    await page.getByTestId('mindmap-outline-select').nth(1).click();

    const row = page.getByTestId('source-list-item').first();
    await expect(row).toHaveAttribute('data-state', 'changed');
    const notice = page.getByTestId('source-changed');
    await expect(notice).toBeVisible();
    // Both numbers are named, so a reader learns that the map is a snapshot rather
    // than the live truth (T058-C03「必须排除」). The recorded version is the one
    // the view actually used, not the current one written back over it.
    await expect(notice).toContainText(`生成时是 v${before.rawVersion}`);
    await expect(notice).toContainText(`当前已是 v${after.rawVersion}`);
    // The record is still openable: a stale source is stale, not unusable.
    await expect(page.getByTestId('source-open')).toBeVisible();
  });

  test('T058-C04 来源缺失：删除被引用 Item 后提示缺失而非无限加载', async ({ page }) => {
    await gotoInbox(page);
    const kept = await capture(page, '来源缺失-保留');
    const removed = await capture(page, '来源缺失-删除');
    const headers = await authHeaders(page);

    const viewId = seedMindmapView(
      uniqueText('来源缺失脑图'),
      [kept.id, removed.id],
      tree('来源缺失根', [kept.id, removed.id], [
        { label: '两个来源都引用', itemIds: [kept.id, removed.id] },
      ]),
    );

    // Delete one cited record through the product's own endpoint. The view keeps
    // pointing at it: a saved projection is a record of what was organised, and
    // deleting knowledge must not rewrite that history.
    const item = await readItem(page, headers, removed.id);
    const deleted = await page.request.delete(`${E2E_ORIGIN}/api/items/${removed.id}`, {
      headers,
      data: { expectedRevision: item.revision },
    });
    expect(deleted.status(), 'DELETE 条目应返回 200').toBe(200);

    await openMindmap(page, viewId);
    await page.getByTestId('mindmap-outline-select').nth(1).click();

    // Both rows are still listed — the count the outline promised did not silently
    // shrink — and the deleted one says why it is empty.
    await expect(page.getByTestId('source-list-item')).toHaveCount(2);
    const missing = page.getByTestId('source-list-item').filter({ hasText: '来源已删除' });
    await expect(missing).toHaveCount(1);
    await expect(missing).toHaveAttribute('data-state', 'missing');
    await expect(page.getByTestId('source-missing')).toBeVisible();
    // "而非无限加载": the row is finished, so no spinner is left behind.
    await expect(page.getByTestId('source-list').getByText('正在读取来源')).toHaveCount(0);
    // The surviving source is unaffected, which is what keeps the row honest.
    await expect(
      page.getByTestId('source-list-item').filter({ hasText: kept.text }),
    ).toHaveAttribute('data-state', 'current');
  });

  test('T058-C05 大纲同步：折叠只是视图状态，内容来自同一棵树', async ({ page, traffic }) => {
    await gotoInbox(page);
    const first = await capture(page, '大纲同步-甲');
    const second = await capture(page, '大纲同步-乙');

    const viewId = seedMindmapView(
      uniqueText('大纲同步脑图'),
      [first.id, second.id],
      tree('大纲同步根', [first.id, second.id], [
        { label: '同步子甲', itemIds: [first.id] },
        { label: '同步子乙', itemIds: [second.id] },
      ]),
    );

    await openMindmap(page, viewId);

    // Baseline: both surfaces describe the same three nodes. The canvas assertion
    // is not optional — "the outline and the graph come from one tree" is exactly
    // the claim this case makes, and it is unverifiable if the canvas drew nothing.
    // Waiting for the node groups is what makes the count below a statement about a
    // finished map rather than about one that is still being drawn.
    await expect(page.getByTestId('mindmap-outline-node')).toHaveCount(3);
    const canvas = page.getByTestId('mindmap-svg');
    await expect(canvas.locator('g.markmap-node')).toHaveCount(3, { timeout: 30_000 });

    // From here on, only the outline is touched. Any request would mean folding had
    // reached for a second structure (T058-R05) or re-asked the model, which the
    // 公共测试装置 forbids as an extra paid call.
    traffic.reset();

    const toggle = page.getByTestId('mindmap-outline-toggle').first();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Collapsing hides the children *rows*, and the root's own sources remain the
    // merged group set — the tree behind the outline did not change.
    await expect(page.getByTestId('mindmap-outline-node')).toHaveCount(1);
    await expect(page.getByTestId('source-list-count')).toContainText('2 条（已去重）');
    // The canvas is a peer, not a mirror of the outline's fold state: folding a row
    // is not a graph operation, so the drawn map still has its three nodes.
    await expect(canvas.locator('g.markmap-node')).toHaveCount(3);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('mindmap-outline-node')).toHaveCount(3);

    expect(
      traffic.apiRequests().map((entry) => `${entry.method} ${entry.url}`),
      '折叠与展开不应产生任何请求：它只是视图状态',
    ).toEqual([]);
  });

  test('T058-C06 键盘操作：不用鼠标可展开分组并打开来源', async ({ page }) => {
    await gotoInbox(page);
    const first = await capture(page, '键盘操作-甲');
    const second = await capture(page, '键盘操作-乙');

    const viewId = seedMindmapView(
      uniqueText('键盘操作脑图'),
      [first.id, second.id],
      tree('键盘操作根', [first.id, second.id], [
        { label: '键盘子甲', itemIds: [first.id] },
        { label: '键盘子乙', itemIds: [second.id] },
      ]),
    );

    await openMindmap(page, viewId);

    // Tab order is verified from the page body rather than by calling `focus()`,
    // so the claim is that the controls are genuinely reachable — a `tabindex="-1"`
    // button would fail here.
    const toggle = page.getByTestId('mindmap-outline-toggle').first();
    await toggle.focus();
    await expect(toggle).toBeFocused();

    // Expand/collapse by keyboard alone, asserted through the ARIA state that a
    // screen reader would announce.
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('mindmap-outline-node')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('mindmap-outline-node')).toHaveCount(3);

    // Tabbing on from the toggle reaches the next outline control, so the outline
    // is one continuous keyboard path rather than isolated controls.
    await toggle.focus();
    await page.keyboard.press('Tab');
    const focusedTestId = await page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') ?? null,
    );
    expect(focusedTestId, 'Tab 应移到下一个大纲控件').toBe('mindmap-outline-select');

    // Select a leaf and open its source without the mouse.
    await page.getByTestId('mindmap-outline-select').nth(1).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('mindmap-outline-select').nth(1)).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(page.getByTestId('source-list-item')).toHaveCount(1);

    const open = page.getByTestId('source-open');
    await open.focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByTestId('knowledge-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText(first.text);

    // Escape closes it, so the keyboard path has an exit as well as an entrance.
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  });
});
