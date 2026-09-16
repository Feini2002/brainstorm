import { expect, gotoInbox, test } from './support/fixtures';
import { E2E_ORIGIN } from './support/env';
import { uniqueText } from './support/harness';
import { seedAiRelation, withSeedDb } from './support/seedData';
import {
  capturePair,
  nodeTransform,
  openNodeFromCanvas,
  openScopedGraph,
  readItem,
  saveGraphView,
} from './support/graph';

/**
 * T048 验收｜图筛选、关系阈值与选择稳定性
 *
 * Every rule here is a version of one distinction: **a filter changes what is
 * read, never what is stored** (T048-R01). Four choices follow from that:
 *
 *  1. **Every "the edge disappeared" assertion is paired with a database read.**
 *     A hidden edge and a deleted one look identical on a canvas, so the case
 *     cannot be decided by looking at the canvas.
 *  2. **Seed writes go through `withSeedDb`.** An AI relation with a score and
 *     evidence has no user-facing creation path in this version, and the
 *     alternative — a shipped test-mode endpoint returning fake rows — is ruled
 *     out by T011-C03. The seed writes to the suite's throwaway `tests/e2e/.data`,
 *     guarded by a path check inside `seedData`.
 *  3. **Each case pins its own scope with an explicit-selection View.** The
 *     library is shared across a run and the canvas caps what it draws, so
 *     "everything" is never a fixed baseline.
 *  4. **Threshold steps straddle the fixture's score.** A pass that would also
 *     hold with the filter ignored is not evidence that the filter works.
 */

/** Confirm a relation row is still stored, from the database, not the canvas. */
function relationStillStored(relationId: string): boolean {
  return withSeedDb((db) => {
    const row = db.prepare('SELECT id FROM relations WHERE id = ?').get(relationId);
    return row !== undefined;
  });
}

test.describe('T048 图筛选、关系阈值与选择稳定性', () => {
  test('T048-C01 阈值变化只隐藏低分边，数据库没有删除', async ({ page }) => {
    await gotoInbox(page);
    const { left, leftId, rightId, headers } = await capturePair(page, '阈值');

    // 0.80 sits between the 0.70 and 0.90 steps, so raising the threshold must
    // hide this edge and lowering it must bring the same row back.
    const relationId = withSeedDb(
      (db) => seedAiRelation(db, { sourceId: leftId, targetId: rightId, score: 0.8 }).id,
    );

    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('阈值视图'),
      itemIds: [leftId, rightId],
    });
    await openScopedGraph(page, viewId, 2);
    await expect(page.getByTestId('graph-summary-nodes')).toContainText('1 条关系');

    // Both node labels came from the captured text, so the picture is of the
    // records this case made rather than of some other pair.
    await expect(page.getByTestId('graph-node').filter({ hasText: left })).toBeVisible();

    await page.getByTestId('graph-filter-score').selectOption('0.9');
    await expect(page.getByTestId('graph-summary-nodes')).toContainText('0 条关系');
    // The nodes stay: filtering relations is not filtering records.
    await expect(page.getByTestId('graph-node')).toHaveCount(2);

    await page.getByTestId('graph-filter-score').selectOption('0');
    await expect(page.getByTestId('graph-summary-nodes')).toContainText('1 条关系');

    // T048-C01「必须排除：筛选不是数据清理」.
    expect(relationStillStored(relationId), '提高阈值不得删除关系行').toBe(true);

    const reread = await page.request.get(`${E2E_ORIGIN}/api/relations`, {
      headers,
      params: { itemId: leftId },
    });
    const rereadBody = (await reread.json()) as { data: { id: string }[] };
    expect(rereadBody.data.map((entry) => entry.id)).toContain(relationId);
  });

  test('T048-C02 人工边不受低分阈值约束，null 评分不等于不可靠', async ({ page }) => {
    await gotoInbox(page);
    const { leftId, rightId, headers } = await capturePair(page, '人工');

    // A manual relation written through the product's own endpoint, so the row
    // under test is one the application could really have created.
    const leftItem = await readItem(page, headers, leftId);
    const rightItem = await readItem(page, headers, rightId);
    const created = await page.request.post(`${E2E_ORIGIN}/api/relations`, {
      headers,
      data: {
        sourceId: leftId,
        targetId: rightId,
        type: 'related_to',
        reason: 'T048-C02 人工边不受评分阈值影响',
        sourceExpectedRevision: leftItem.revision,
        targetExpectedRevision: rightItem.revision,
      },
    });
    expect(created.status(), '人工关系应创建成功').toBe(201);

    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('人工边视图'),
      itemIds: [leftId, rightId],
    });
    await openScopedGraph(page, viewId, 2);
    await expect(page.getByTestId('graph-summary-nodes')).toContainText('1 条关系');

    // The highest threshold offered. A manual edge has no score at all; reading
    // `null` as "very low" would silently hide every human-made relation.
    await page.getByTestId('graph-filter-score').selectOption('0.9');
    await expect(
      page.getByTestId('graph-summary-nodes'),
      '人工边没有模型评分，不应被评分阈值筛掉',
    ).toContainText('1 条关系');
    await expect(page.getByTestId('graph-summary')).toContainText('人工');
  });

  test('T048-C03 筛选把已打开节点移出范围时给出提示，不报错', async ({ page }) => {
    await gotoInbox(page);
    const { leftId, rightId, headers } = await capturePair(page, '范围');
    withSeedDb((db) => seedAiRelation(db, { sourceId: leftId, targetId: rightId, score: 0.9 }));

    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('范围视图'),
      itemIds: [leftId, rightId],
    });
    await openScopedGraph(page, viewId, 2);

    // Open one node through the canvas, which is what makes a later filter able
    // to strand the selection.
    await openNodeFromCanvas(page, leftId);

    // A type neither record has: every node leaves the scope.
    await page.getByTestId('graph-filter-type').selectOption('todo');
    await expect(page.getByTestId('graph-node')).toHaveCount(0);
    await expect(page.getByTestId('graph-empty-filtered')).toBeVisible();

    // The record still exists; the page says it is out of scope rather than
    // showing an unexplained panel or an error (T048-R03).
    await expect(page.getByTestId('graph-selection-out-of-scope')).toBeVisible();
    await expect(page.getByTestId('graph-selection-out-of-scope')).toContainText('没有被删除');
    await expect(page.getByTestId('graph-load-error')).toHaveCount(0);

    await page.getByTestId('graph-filter-type').selectOption('');
    await expect(page.getByTestId('graph-node')).toHaveCount(2);
    await expect(page.getByTestId('graph-selection-out-of-scope')).toHaveCount(0);
  });

  test('T048-C04 筛选来回切换后已保存坐标不变', async ({ page }) => {
    await gotoInbox(page);
    const { leftId, rightId, headers } = await capturePair(page, '坐标');

    // Deliberately arbitrary numbers: a restore that re-ran Dagre instead of
    // reading the view would produce round values, not these.
    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('坐标视图'),
      itemIds: [leftId, rightId],
      positions: { [leftId]: { x: 37, y: 61 }, [rightId]: { x: 411, y: 233 } },
    });
    await openScopedGraph(page, viewId, 2);

    const beforeLeft = await nodeTransform(page, leftId);
    const beforeRight = await nodeTransform(page, rightId);
    expect(beforeLeft, '应渲染出已保存坐标').not.toBe('');

    await page.getByTestId('graph-filter-type').selectOption('idea');
    await expect(page.getByTestId('graph-node')).toHaveCount(2);
    await page.getByTestId('graph-filter-type').selectOption('todo');
    await expect(page.getByTestId('graph-node')).toHaveCount(0);

    // Back to the original range: the stored coordinates must be reused. Having
    // to rearrange after every filter is the failure T048-R04 names.
    await page.getByTestId('graph-filter-type').selectOption('idea');
    await expect(page.getByTestId('graph-node')).toHaveCount(2);
    expect(await nodeTransform(page, leftId)).toBe(beforeLeft);
    expect(await nodeTransform(page, rightId)).toBe(beforeRight);
  });

  test('T048-C05 快速连续改筛选后，最终图对应最后一次查询', async ({ page }) => {
    await gotoInbox(page);
    const { leftId, rightId, headers } = await capturePair(page, '乱序');
    // 0.80, so the steps straddle it: shown at 0.50, hidden at 0.90.
    withSeedDb((db) => seedAiRelation(db, { sourceId: leftId, targetId: rightId, score: 0.8 }));

    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('乱序视图'),
      itemIds: [leftId, rightId],
    });
    await openScopedGraph(page, viewId, 2);
    await expect(page.getByTestId('graph-summary-nodes')).toContainText('1 条关系');

    /**
     * Delay the first graph read so it settles *after* the later ones.
     *
     * Without an induced reordering "the newest response wins" is not actually
     * being tested: a fast local server answers in order, so the case would pass
     * with no sequence guard at all (T048-C05「模拟响应乱序」).
     */
    let delayed = 0;
    await page.route('**/api/graph', async (route) => {
      if (delayed === 0) {
        delayed += 1;
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      await route.continue();
    });

    // The first (slow) read is at 0.5, which *shows* the 0.80 edge. The last is
    // at 0.9, which hides it. If the slow response were allowed to win, the
    // canvas would still show an edge the current filter excludes.
    await page.getByTestId('graph-filter-score').selectOption('0.5');
    await page.getByTestId('graph-filter-score').selectOption('0.7');
    await page.getByTestId('graph-filter-score').selectOption('0.9');

    // Past the induced delay, so a stale write has had every chance to land.
    await page.waitForTimeout(1600);

    await expect(page.getByTestId('graph-filter-score')).toHaveValue('0.9');
    await expect(page.getByTestId('graph-summary-nodes')).toContainText('0 条关系');
    await expect(page.getByTestId('graph-edge-badge')).toHaveCount(0);
    // The records are still drawn: the last query narrowed relations, not records,
    // so a stale response cannot have replaced the whole subgraph either.
    await expect(page.getByTestId('graph-node')).toHaveCount(2);
  });

  test('T048-C06 过期关系默认隐藏，开启后单独标注', async ({ page }) => {
    await gotoInbox(page);
    const { leftId, rightId, headers } = await capturePair(page, '过期');
    // Recorded against the current versions, so it starts out fresh.
    const relationId = withSeedDb(
      (db) => seedAiRelation(db, { sourceId: leftId, targetId: rightId, score: 0.9 }).id,
    );

    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('过期视图'),
      itemIds: [leftId, rightId],
    });
    await openScopedGraph(page, viewId, 2);
    await expect(page.getByTestId('graph-summary-nodes')).toContainText('1 条关系');
    await expect(page.getByTestId('graph-toggle-stale')).toContainText('显示依据已变化的关系');

    // Move the endpoint's raw text — the only change that invalidates recorded
    // evidence. A title edit deliberately would not (see T051-C02).
    const item = await readItem(page, headers, leftId);
    const edited = await page.request.patch(`${E2E_ORIGIN}/api/items/${leftId}`, {
      headers,
      data: {
        expectedRevision: item.revision,
        patch: { rawText: `${item.rawText}\nT048-C06 追加一行，使旧依据过期` },
      },
    });
    expect(edited.status()).toBe(200);

    await page.getByTestId('graph-toggle-stale').click();
    await expect(page.getByTestId('graph-toggle-stale')).toContainText('隐藏依据已变化的关系');
    await expect(page.getByTestId('graph-summary-nodes')).toContainText('1 条关系');
    // T082-R02 renamed this state: 「过期」 read as "the data is bad", while
    // 「依据已变化」 says what actually happened (the recorded evidence was drawn
    // from an older raw version). The case's requirement is unchanged — the notice
    // must explain the classification — so the assertion follows the wording the
    // product now uses.
    await expect(page.getByTestId('graph-freshness-notice')).toContainText('依据已变化');

    // Hide it again: the edge leaves the canvas, and the number of hidden stale
    // edges is stated so "it vanished" is never silent.
    await page.getByTestId('graph-toggle-stale').click();
    await expect(page.getByTestId('graph-summary-nodes')).toContainText('0 条关系');
    await expect(page.getByTestId('graph-stale-hidden')).toContainText('1 条');

    // T048-C06「必须排除：陈旧语义不能与当前关系混淆」 — the row was never
    // rewritten, only classified differently at read time.
    expect(relationStillStored(relationId)).toBe(true);
  });
});
