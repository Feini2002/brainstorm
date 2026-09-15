import { expect, gotoInbox, test } from './support/fixtures';
import { E2E_ORIGIN } from './support/env';
import { uniqueText } from './support/harness';
import { seedAiRelation, withSeedDb } from './support/seedData';
import {
  capturePair,
  dragNode,
  nodeTransform,
  openNodeFromCanvas,
  openScopedGraph,
  readItem,
  saveGraphView,
  selectEdgeInList,
} from './support/graph';

/**
 * T049 验收｜节点详情与关系审核交互
 *
 * The point of this spec is that the graph is a *view* of one set of records, not
 * a second application next to them. Three consequences are checked directly:
 *
 *  1. **One drawer, two entry points (T049-R01).** A record opened from the
 *     canvas is the same component, the same endpoint and the same revision as
 *     one opened from the library. A per-page edit form would be the bug.
 *  2. **An edge can be judged from what is on screen (T049-R02).** The inspector
 *     must show the citations the relation was built on, attributed to their
 *     endpoint with the raw version they came from — otherwise the user is asked
 *     to accept or reject a judgement with the material hidden.
 *  3. **Reviewing affects the edge, not the page (T049-R03).** A rejection
 *     re-reads the graph; it does not reload the site, and it does not move the
 *     other nodes.
 */

test.describe('T049 节点详情与关系审核交互', () => {
  test('T049-C01 从 Library 与 Graph 打开的同一 ID 共享同一个抽屉与端点', async ({ page }) => {
    await gotoInbox(page);
    const { left, leftId, headers } = await capturePair(page, '一致');

    // Edit through the library's drawer, which is the surface T049-R01 says the
    // graph must reuse rather than reimplement.
    await page.getByRole('link', { name: '资料库' }).click();
    await page.getByTestId('library-search').fill(left);
    await page.getByTestId('knowledge-card').filter({ hasText: left }).getByRole('button').first().click();
    await expect(page.getByTestId('knowledge-drawer')).toBeVisible();
    await page.getByTestId('drawer-edit').click();
    const newTitle = `T049 标题 ${uniqueText('改')}`;
    await page.getByTestId('edit-title').fill(newTitle);
    await page.getByTestId('edit-save').click();
    await expect(page.getByTestId('edit-item-form')).toHaveCount(0);

    // The API now reports both the new title and a moved revision. Asserting on
    // the id (not the text) is what makes "same record" a fact rather than a
    // coincidence of two similarly named notes.
    const afterEdit = await readItem(page, headers, leftId);
    expect(afterEdit.revision).toBeGreaterThan(1);

    // Now the same id, opened from the canvas.
    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('一致视图'),
      itemIds: [leftId],
    });
    await openScopedGraph(page, viewId, 1);
    await expect(page.getByTestId('graph-node')).toHaveAttribute('data-item-id', leftId);
    // The node label is the title that was just edited, which proves the canvas
    // reads the same field the drawer wrote.
    await expect(page.getByTestId('graph-node')).toContainText(newTitle);

    await openNodeFromCanvas(page, leftId);
    // The drawer shows the edited title, and it offers the same edit control the
    // library does — one implementation, reachable two ways.
    await expect(page.getByTestId('knowledge-drawer')).toContainText(newTitle);
    await expect(page.getByTestId('drawer-edit')).toBeVisible();
  });

  test('T049-C02 选中 AI 建议边能看到对应的原文摘录与版本', async ({ page }) => {
    await gotoInbox(page);
    const { left, right, leftId, rightId, headers } = await capturePair(page, '证据');

    // Quotes must be real substrings of the endpoints' text: `seedAiRelation`
    // refuses anything else, so the excerpt shown below is one the database
    // could genuinely have produced.
    const leftQuote = Array.from(left).slice(0, 12).join('');
    const rightQuote = Array.from(right).slice(0, 12).join('');
    const relationId = withSeedDb((db) =>
      seedAiRelation(db, {
        sourceId: leftId,
        targetId: rightId,
        score: 0.86,
        reason: 'T049-C02 两条记录在讲同一件事',
        evidence: [
          { itemId: leftId, quote: leftQuote },
          { itemId: rightId, quote: rightQuote },
        ],
      }).id,
    );

    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('证据视图'),
      itemIds: [leftId, rightId],
    });
    await openScopedGraph(page, viewId, 2);

    // Reach the edge through the accessible relation list: the canvas label is a
    // short badge by design (T049-R05), so the list is the entry point that does
    // not depend on hitting a thin line.
    await selectEdgeInList(page, relationId);
    const inspector = page.getByTestId('graph-inspector');
    await expect(inspector).toBeVisible();

    // The citations, with the endpoint each belongs to and the version it came
    // from. Without these the edge would be a decoration.
    const evidence = inspector.getByTestId('graph-inspector-evidence-item');
    await expect(evidence).toHaveCount(2);
    await expect(inspector.getByTestId('graph-inspector-evidence')).toContainText(leftQuote);
    await expect(inspector.getByTestId('graph-inspector-evidence')).toContainText(rightQuote);
    // Each quote is attributed to the endpoint it was verified against.
    await expect(
      inspector.locator(`[data-evidence-item-id="${leftId}"]`),
    ).toContainText('原文 v1');
    await expect(
      inspector.locator(`[data-evidence-item-id="${rightId}"]`),
    ).toContainText('原文 v1');

    // T049-R02 also asks for the score to be explained rather than printed bare.
    await expect(inspector.getByTestId('graph-inspector-score')).toContainText('不是正确率');
    await expect(inspector.getByTestId('graph-inspector-versions')).toContainText('起点原文 v1');

    // And the reason, which is the sentence a bare score cannot convey.
    await expect(inspector.getByTestId('graph-inspector-reason')).toContainText('讲同一件事');
  });

  test('T049-C03 拖动节点结束时不误开编辑或删除对话框', async ({ page }) => {
    await gotoInbox(page);
    const { leftId, rightId, headers } = await capturePair(page, '拖动');
    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('拖动视图'),
      itemIds: [leftId, rightId],
      positions: { [leftId]: { x: 60, y: 60 }, [rightId]: { x: 420, y: 260 } },
    });
    await openScopedGraph(page, viewId, 2);

    // A real drag: press, move in several steps (React Flow emits a change per
    // frame and only the drop is committed), then release. The helper scrolls the
    // node into the viewport first and asserts it landed there — a node below the
    // fold still reports a `boundingBox()`, but mouse events aimed past the
    // viewport height hit nothing and the gesture would be a silent no-op.
    const { before, after } = await dragNode(page, leftId, { dx: 90, dy: 70 }, 12);

    // T049-C03「必须排除：交互冲突会使画布难用」 — releasing after a drag is not a
    // click, so neither the drawer nor the delete confirmation may appear.
    await expect(page.getByTestId('knowledge-drawer')).toHaveCount(0);
    await expect(page.getByTestId('delete-dialog')).toHaveCount(0);
    await expect(page.getByTestId('edit-item-form')).toHaveCount(0);

    // The drag really moved the node, so the assertion above is not passing
    // merely because the gesture did nothing at all.
    expect(after, '拖动应改变节点在画布上的位置').not.toBe(before);
  });

  test('T049-C04 在图上拒绝建议后该边按过滤规则消失，其它节点位置保留', async ({ page }) => {
    await gotoInbox(page);
    const { leftId, rightId, headers } = await capturePair(page, '审核');
    const relationId = withSeedDb(
      (db) => seedAiRelation(db, { sourceId: leftId, targetId: rightId, score: 0.9 }).id,
    );

    const positions = { [leftId]: { x: 25, y: 35 }, [rightId]: { x: 455, y: 305 } };
    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('审核视图'),
      itemIds: [leftId, rightId],
      positions,
    });
    await openScopedGraph(page, viewId, 2);
    const beforeLeft = await nodeTransformOf(page, leftId);
    const beforeRight = await nodeTransformOf(page, rightId);

    await selectEdgeInList(page, relationId);
    await expect(page.getByTestId('graph-inspector')).toBeVisible();
    await page.getByTestId('graph-inspector-reject').click();

    // A rejected edge is excluded by default, so the re-read that follows must
    // report none.
    await expect(page.getByTestId('graph-summary-nodes')).toContainText('0 条关系');

    // The decision is a row state, not a canvas state.
    const relations = await page.request.get(`${E2E_ORIGIN}/api/relations`, {
      headers,
      params: { itemId: leftId, includeRejected: true },
    });
    const body = (await relations.json()) as { data: { id: string; reviewStatus: string }[] };
    const stored = body.data.find((entry) => entry.id === relationId);
    expect(stored, '拒绝必须保留墓碑行而不是删除').toBeTruthy();
    expect(stored!.reviewStatus).toBe('rejected');

    // T049-C04「必须排除：整图重建会破坏用户上下文」 — the nodes did not move.
    await expect(page.getByTestId('graph-node')).toHaveCount(2);
    expect(await nodeTransformOf(page, leftId)).toBe(beforeLeft);
    expect(await nodeTransformOf(page, rightId)).toBe(beforeRight);
  });

  test('T049-C05 用旧 revision 审核返回冲突，不以乐观 UI 掩盖', async ({ page }) => {
    await gotoInbox(page);
    const { leftId, rightId, headers } = await capturePair(page, '冲突');
    const relationId = withSeedDb(
      (db) => seedAiRelation(db, { sourceId: leftId, targetId: rightId, score: 0.9 }).id,
    );

    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('冲突视图'),
      itemIds: [leftId, rightId],
    });
    await openScopedGraph(page, viewId, 2);
    await selectEdgeInList(page, relationId);
    await expect(page.getByTestId('graph-inspector')).toBeVisible();

    // Another window reaches the decision first, moving the revision forward.
    const external = await page.request.patch(`${E2E_ORIGIN}/api/relations/${relationId}`, {
      headers,
      data: { action: 'accept', expectedRevision: 1 },
    });
    expect(external.status(), '外部审核应先成功').toBe(200);

    // The page still holds revision 1 in its inspector. Submitting must be
    // refused rather than silently overwriting the other decision.
    await page.getByTestId('graph-inspector-reject').click();
    await expect(page.getByTestId('graph-inspector')).toContainText('已被其他窗口更新');

    // The other window's decision stands.
    const relations = await page.request.get(`${E2E_ORIGIN}/api/relations`, {
      headers,
      params: { itemId: leftId },
    });
    const body = (await relations.json()) as { data: { id: string; reviewStatus: string }[] };
    expect(body.data.find((entry) => entry.id === relationId)?.reviewStatus).toBe('accepted');
  });

  test('T049-C06 密集边时完整理由只在检查面板里，不铺满画布', async ({ page }) => {
    await gotoInbox(page);
    const { left, leftId, rightId, headers } = await capturePair(page, '密集');
    const longReason = 'T049-C06 一段很长的理由，用来确认它只出现在检查面板而不是画布上。'.repeat(4);
    const relationId = withSeedDb(
      (db) =>
        seedAiRelation(db, {
          sourceId: leftId,
          targetId: rightId,
          score: 0.88,
          reason: longReason,
          // The quote must be a real substring of the endpoint's raw text, which
          // `seedAiRelation` verifies — a citation the schema could not have
          // produced would make the inspector show a fabricated excerpt.
          evidence: [{ itemId: leftId, quote: Array.from(left).slice(0, 10).join('') }],
        }).id,
    );

    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('密集视图'),
      itemIds: [leftId, rightId],
    });
    await openScopedGraph(page, viewId, 2);

    // The canvas carries a short badge, never the paragraph (T049-R05). Drawing
    // the reason on every edge is what turns a graph into a wall of text.
    const badge = page.getByTestId('graph-edge-badge');
    await expect(badge).toHaveCount(1);
    const badgeText = (await badge.textContent()) ?? '';
    expect(Array.from(badgeText).length, '边标签必须很短').toBeLessThan(12);
    expect(badgeText).not.toContain('一段很长的理由');

    // The full sentence is still reachable, in the panel.
    await selectEdgeInList(page, relationId);
    await expect(page.getByTestId('graph-inspector-reason')).toContainText('一段很长的理由');
    await expect(page.getByTestId('graph-inspector-sentence')).toBeVisible();
  });
});

/** Rendered transform of one node; used to prove a review did not disturb layout. */
async function nodeTransformOf(page: import('@playwright/test').Page, itemId: string): Promise<string> {
  return nodeTransform(page, itemId);
}
