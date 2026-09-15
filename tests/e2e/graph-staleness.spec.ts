import { expect, gotoInbox, test } from './support/fixtures';
import { E2E_ORIGIN } from './support/env';
import { uniqueText } from './support/harness';
import { seedAiRelation, withSeedDb } from './support/seedData';
import {
  capturePair,
  dragNode,
  nodeTransform,
  openScopedGraph,
  readItem,
  readStoredView,
  saveGraphView,
  selectEdgeInList,
} from './support/graph';

/**
 * T051 验收｜关系依据失效与图视图一致性
 *
 * The central rule is that freshness is **derived on read from `rawVersion`**,
 * never stored (T051-R06), and this spec is arranged so that a stored flag or a
 * timestamp comparison would fail it:
 *
 *  - **`rawVersion`, not `updatedAt`** (T051-C02). Editing only a title moves the
 *    revision and the timestamp while the text a relation was drawn from is
 *    untouched, so an implementation comparing timestamps would mark the edge
 *    stale and be caught here.
 *  - **One derivation, two readers** (T051-C06). The graph read and the relation
 *    read must agree on the same edge. They can only do that by sharing the
 *    helper, so the case compares the two responses rather than trusting either.
 *  - **Presentation is not knowledge** (T051-C03). Saving a layout writes a View
 *    and must leave every relation's freshness untouched.
 */

test.describe('T051 关系依据失效与图视图一致性', () => {
  test('T051-C01 编辑原文后 accepted 边显示过期，状态保留但不假装最新', async ({ page }) => {
    await gotoInbox(page);
    const { leftId, rightId, headers } = await capturePair(page, '原文变更');
    const relationId = withSeedDb(
      (db) =>
        seedAiRelation(db, {
          sourceId: leftId,
          targetId: rightId,
          score: 0.9,
          reviewStatus: 'accepted',
        }).id,
    );

    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('过期依据视图'),
      itemIds: [leftId, rightId],
    });
    await openScopedGraph(page, viewId, 2);
    // Fresh to begin with, so the change below is the only cause of staleness.
    await expect(page.getByTestId('graph-summary-nodes')).toContainText('1 条关系');
    await expect(page.getByTestId('graph-freshness-notice')).toHaveCount(0);

    const item = await readItem(page, headers, leftId);
    const edited = await page.request.patch(`${E2E_ORIGIN}/api/items/${leftId}`, {
      headers,
      data: {
        expectedRevision: item.revision,
        patch: { rawText: `${item.rawText}\nT051-C01 改写一行` },
      },
    });
    expect(edited.status()).toBe(200);

    // Show stale edges, which is the only way the edge can be inspected now.
    await page.getByTestId('graph-toggle-stale').click();
    await expect(page.getByTestId('graph-summary-nodes')).toContainText('1 条关系');
    await expect(page.getByTestId('graph-freshness-notice')).toContainText('依据已过期');

    await selectEdgeInList(page, relationId);
    const inspector = page.getByTestId('graph-inspector');
    await expect(inspector.getByTestId('graph-inspector-stale')).toContainText('原文版本已经变化');
    // The recorded version is still reported as what it was, rather than being
    // silently rewritten to the current version.
    await expect(inspector.getByTestId('graph-inspector-versions')).toContainText('起点原文 v1');

    // And the row's own status is untouched: expiring is a statement about the
    // evidence, not a demotion of the relation (T051-R02).
    const relations = await page.request.get(`${E2E_ORIGIN}/api/relations`, {
      headers,
      params: { itemId: leftId, includeStale: true },
    });
    const body = (await relations.json()) as
      { data: { id: string; reviewStatus: string; sourceRawVersion: number }[] };
    const stored = body.data.find((entry) => entry.id === relationId);
    expect(stored?.reviewStatus, '原文变化不改变审核状态').toBe('accepted');
    expect(stored?.sourceRawVersion).toBe(1);
  });

  test('T051-C02 只改标题不使关系依据失效', async ({ page }) => {
    await gotoInbox(page);
    const { leftId, rightId, headers } = await capturePair(page, '标题变更');
    const relationId = withSeedDb(
      (db) => seedAiRelation(db, { sourceId: leftId, targetId: rightId, score: 0.9 }).id,
    );

    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('标题视图'),
      itemIds: [leftId, rightId],
    });
    await openScopedGraph(page, viewId, 2);

    const before = await readItem(page, headers, leftId);
    const newTitle = `T051 只改标题 ${uniqueText('')}`;
    const edited = await page.request.patch(`${E2E_ORIGIN}/api/items/${leftId}`, {
      headers,
      data: { expectedRevision: before.revision, patch: { title: newTitle } },
    });
    expect(edited.status()).toBe(200);

    const after = await readItem(page, headers, leftId);
    // The change really did move the record, so the staleness assertion below is
    // not passing because the PATCH silently did nothing.
    expect(after.revision, '改标题应推进 revision').toBeGreaterThan(before.revision);
    expect(after.rawVersion, '改标题不应推进 rawVersion').toBe(before.rawVersion);

    // Re-open the graph, which is a fresh read of both the item and the relation.
    // (The page cannot pick up a server-side edit on its own, and auto-layout
    // would be a different operation than the one under test.)
    await openScopedGraph(page, viewId, 2);
    await expect(page.getByTestId('graph-summary-nodes')).toContainText('1 条关系');
    await expect(
      page.getByTestId('graph-freshness-notice'),
      '只改标题不应让依据过期',
    ).toHaveCount(0);
    await expect(page.getByTestId('graph-node').filter({ hasText: newTitle })).toBeVisible();

    // The API agrees, which is what rules out "the page hid a stale badge".
    const relation = await page.request.get(`${E2E_ORIGIN}/api/relations`, {
      headers,
      params: { itemId: leftId },
    });
    const relationBody = (await relation.json()) as { data: { id: string; isStale: boolean }[] };
    expect(relationBody.data.find((entry) => entry.id === relationId)?.isStale).toBe(false);
  });

  test('T051-C03 保存布局不改变任何关系的新鲜度', async ({ page }) => {
    await gotoInbox(page);
    const { leftId, rightId, headers } = await capturePair(page, '布局变化');
    withSeedDb((db) => seedAiRelation(db, { sourceId: leftId, targetId: rightId, score: 0.9 }));

    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('布局新鲜度视图'),
      itemIds: [leftId, rightId],
      positions: { [leftId]: { x: 50, y: 50 }, [rightId]: { x: 400, y: 250 } },
    });
    await openScopedGraph(page, viewId, 2);

    const readGraph = async (): Promise<{ staleCount: number; freshCount: number }> => {
      // Read through the view endpoint's own kind so the request matches what the
      // page sends; the summary comes from the same derivation.
      const response = await page.request.post(`${E2E_ORIGIN}/api/graph`, {
        headers,
        data: { filter: { includeStale: true }, itemIds: [leftId, rightId] },
      });
      expect(response.status()).toBe(200);
      const body = (await response.json()) as {
        data: { freshness: { staleCount: number; freshCount: number } };
      };
      return body.data.freshness;
    };

    const before = await readGraph();
    expect(before.staleCount, '初始没有过期依据').toBe(0);
    expect(before.freshCount, '初始只有一条新鲜关系').toBe(1);

    // Read the stored layout *before* the drag: the drag is debounce-committed, so
    // a baseline captured after it might already contain the new coordinates and
    // the "did the write land" check below would race the timer.
    const storedBefore = await readStoredView(page, headers, viewId);
    expect(storedBefore.content.positions[leftId]).toEqual({ x: 50, y: 50 });
    const storedBeforeTransform = await nodeTransform(page, leftId);

    // Drag a node and let the layout commit — a pure presentation write.
    const { after: transformAfterDrag } = await dragNode(page, leftId, { dx: 70, dy: 50 });
    expect(transformAfterDrag, '拖动应改变节点位置').not.toBe(storedBeforeTransform);
    // The drag must actually reach the stored row before the freshness read
    // below, otherwise "freshness did not change" would also be satisfied by a
    // dropped write.
    await expect
      .poll(
        async () => {
          const view = await readStoredView(page, headers, viewId);
          return (
            view.revision > storedBefore.revision &&
            JSON.stringify(view.content.positions[leftId]) !==
              JSON.stringify({ x: 50, y: 50 })
          );
        },
        { message: '拖动应被持久化到视图' },
      )
      .toBe(true);

    // T051-C03「必须排除：presentation 修改不应污染知识版本」.
    expect(await readGraph(), '保存布局不得改变关系新鲜度').toEqual(before);
    // The drag was real, so the assertion above is not vacuous.
    expect(await nodeTransform(page, leftId)).toBe(transformAfterDrag);
  });

  test('T051-C04 人工边在原文大改后也提示需要重新确认依据', async ({ page }) => {
    await gotoInbox(page);
    const { leftId, rightId, headers } = await capturePair(page, '人工过期');

    // A manual relation written through the product, so it carries no score but
    // does carry the raw versions it was confirmed against.
    const leftItem = await readItem(page, headers, leftId);
    const rightItem = await readItem(page, headers, rightId);
    const created = await page.request.post(`${E2E_ORIGIN}/api/relations`, {
      headers,
      data: {
        sourceId: leftId,
        targetId: rightId,
        type: 'related_to',
        reason: 'T051-C04 人工判断也有时效',
        sourceExpectedRevision: leftItem.revision,
        targetExpectedRevision: rightItem.revision,
      },
    });
    expect(created.status()).toBe(201);
    const relationId = ((await created.json()) as { data: { id: string } }).data.id;

    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('人工过期视图'),
      itemIds: [leftId, rightId],
    });
    await openScopedGraph(page, viewId, 2);

    // Rewrite one endpoint substantially.
    const current = await readItem(page, headers, rightId);
    const edited = await page.request.patch(`${E2E_ORIGIN}/api/items/${rightId}`, {
      headers,
      data: {
        expectedRevision: current.revision,
        patch: { rawText: 'T051-C04 这条原文已经被完全重写，与原先的人工判断无关了。' },
      },
    });
    expect(edited.status()).toBe(200);

    await page.getByTestId('graph-toggle-stale').click();
    await expect(page.getByTestId('graph-freshness-notice')).toContainText('依据已过期');
    await selectEdgeInList(page, relationId);

    // The manual edge is flagged like any other; a human judgement made against
    // text that has since changed is no more current than a model's.
    await expect(page.getByTestId('graph-inspector-stale')).toContainText('原文版本已经变化');
    // It is still manual and still accepted — expiring did not reclassify it.
    await expect(page.getByTestId('graph-inspector')).toContainText('人工建立');
    await expect(page.getByTestId('graph-inspector')).toContainText('已确认');
    await expect(page.getByTestId('graph-inspector-score')).toContainText('没有模型评分');
  });

  test('T051-C05 删除图上一个节点后，其余节点坐标不变', async ({ page }) => {
    await gotoInbox(page);
    const { leftId, rightId, headers } = await capturePair(page, '删除局部');

    const positions = { [leftId]: { x: 44, y: 88 }, [rightId]: { x: 388, y: 176 } };
    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('删除局部视图'),
      itemIds: [leftId, rightId],
      positions,
    });
    await openScopedGraph(page, viewId, 2);
    const beforeRight = await nodeTransform(page, rightId);

    // Delete one endpoint through the product's own endpoint. It cascades the
    // relations it participates in but must leave the surviving node alone.
    const item = await readItem(page, headers, leftId);
    const deleted = await page.request.delete(`${E2E_ORIGIN}/api/items/${leftId}`, {
      headers,
      data: { expectedRevision: item.revision },
    });
    expect(deleted.status()).toBe(200);

    // Re-open the same view: the surviving node keeps its stored coordinate.
    await openScopedGraph(page, viewId, 1);
    await expect(page.getByTestId('graph-node')).toHaveAttribute('data-item-id', rightId);
    expect(
      await nodeTransform(page, rightId),
      '删除一个节点不应让其余节点重排',
    ).toBe(beforeRight);
  });

  test('T051-C06 图读与关系读对同一条边的过期标记一致', async ({ page }) => {
    await gotoInbox(page);
    const { leftId, rightId, headers } = await capturePair(page, '派生一致');
    const relationId = withSeedDb(
      (db) => seedAiRelation(db, { sourceId: leftId, targetId: rightId, score: 0.9 }).id,
    );

    // Invalidate it, so both readers have something to classify.
    const item = await readItem(page, headers, leftId);
    await page.request.patch(`${E2E_ORIGIN}/api/items/${leftId}`, {
      headers,
      data: {
        expectedRevision: item.revision,
        patch: { rawText: `${item.rawText}\nT051-C06 追加` },
      },
    });

    // Reader one: the relation endpoint the Library detail panel uses.
    const relations = await page.request.get(`${E2E_ORIGIN}/api/relations`, {
      headers,
      params: { itemId: leftId, includeStale: true },
    });
    const relationBody = (await relations.json()) as { data: { id: string; isStale: boolean }[] };
    const viaRelation = relationBody.data.find((entry) => entry.id === relationId);
    expect(viaRelation, '关系读应包含过期关系').toBeTruthy();

    // Reader two: the graph read the canvas uses, scoped to these two records.
    const graphRead = await page.request.post(`${E2E_ORIGIN}/api/graph`, {
      headers,
      data: { filter: { includeStale: true }, itemIds: [leftId, rightId] },
    });
    expect(graphRead.status()).toBe(200);
    const graphBody = (await graphRead.json()) as {
      data: {
        edges: { id: string; isStale: boolean }[];
        freshness: { byRelationId: Record<string, string> };
      };
    };
    const viaGraph = graphBody.data.edges.find((edge) => edge.id === relationId);
    expect(viaGraph, '图读应包含该边（includeStale）').toBeTruthy();

    // T051-C06「必须排除：多处重复计算容易语义漂移」 — the two must agree, which
    // they can only do by sharing one derivation. A second implementation would
    // eventually disagree on a case like the title-only edit above.
    expect(viaGraph!.isStale).toBe(viaRelation!.isStale);
    expect(viaGraph!.isStale).toBe(true);
    expect(graphBody.data.freshness.byRelationId[relationId]).toBe('stale');
  });
});
