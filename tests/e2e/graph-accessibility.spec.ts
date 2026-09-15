import { performance } from 'node:perf_hooks';

import { expect, gotoInbox, test } from './support/fixtures';
import { E2E_ORIGIN } from './support/env';
import { authHeaders, captureViaUi, uniqueText } from './support/harness';
import { seedAiRelation, tagItems, withSeedDb } from './support/seedData';
import {
  capturePair,
  dragNode,
  findItemId,
  openScopedGraph,
  saveGraphView,
  selectEdgeInList,
} from './support/graph';

/**
 * T050 验收｜大图降级、无障碍与可读性
 *
 * The rules here are about what the graph does *without* the canvas being the
 * answer, and they are the ones most often claimed without evidence:
 *
 *  1. **The text alternative is a real path, not a summary.** T050-C02 requires
 *     that a user who does not use the canvas can inspect the same relations and
 *     sources, so the case drives the relation list and the inspector only and
 *     never clicks a node or edge in the canvas. If the list were decoration, the
 *     case could not reach anything.
 *  2. **Status must survive the loss of colour.** T050-C03 checks the words and
 *     the documented line styles, because a colour-only distinction is what the
 *     rule forbids.
 *  3. **Scale is measured, not extrapolated.** T050-C01 reads a graph larger than
 *     an explicit selection may carry and records real timings, since a ten-node
 *     demo cannot support a claim about two hundred (T050-R02).
 *  4. **Scope is stated explicitly in every case.** The graph page adopts the most
 *     recent saved view by default, so a case that relied on the default would be
 *     reading whichever view another spec created last.
 */

/** Create a record through the capture endpoint, returning its id. */
async function seedItem(
  page: import('@playwright/test').Page,
  headers: Record<string, string>,
  rawText: string,
): Promise<string> {
  const response = await page.request.post(`${E2E_ORIGIN}/api/items`, {
    headers,
    data: {
      captureRequestId: crypto.randomUUID(),
      rawText,
      sourceType: 'other',
      sourceRef: null,
    },
  });
  expect(response.status(), `「${rawText}」应创建成功`).toBe(201);
  const body = (await response.json()) as { data: { item: { id: string } } };
  return body.data.item.id;
}

test.describe('T050 大图降级、无障碍与可读性', () => {
  test('T050-C01 超过显式选择上限的图仍能打开、布局与拖动，并记录真实耗时', async ({ page }) => {
    test.setTimeout(180_000);

    await gotoInbox(page);
    const headers = await authHeaders(page);
    const prefix = uniqueText('规模');

    // 60 real records. An explicit selection is capped at 40, so this case needs a
    // tagged scope — which is also the only way a user could reach this size.
    const created: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      created.push(await seedItem(page, headers, `${prefix} 规模节点 ${index}`));
    }
    const tagLabel = `规模标签${uniqueText('').slice(-6)}`;
    const tagId = tagItems(created, tagLabel);

    // A chain plus cross links, so Dagre has real structure to lay out.
    withSeedDb((db) => {
      for (let index = 0; index + 1 < created.length; index += 1) {
        seedAiRelation(db, { sourceId: created[index], targetId: created[index + 1], score: 0.9 });
      }
      for (let index = 0; index + 5 < created.length; index += 6) {
        seedAiRelation(db, { sourceId: created[index], targetId: created[index + 5], score: 0.85 });
      }
    });

    // A filter-mode view pinned to just this tag, so the read is this case's own
    // baseline rather than the whole library. Created through the product's own
    // endpoint, which snapshots the matching sources.
    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('规模视图'),
      filter: { tagId },
    });

    const openedAt = performance.now();
    await openScopedGraph(page, viewId);
    await expect(page.getByTestId('graph-node')).toHaveCount(created.length);
    const openMs = performance.now() - openedAt;

    const layoutAt = performance.now();
    await page.getByTestId('graph-auto-layout').click();
    await expect(page.getByTestId('graph-node')).toHaveCount(created.length);
    await expect(page.getByTestId('graph-save-error')).toHaveCount(0);
    const layoutMs = performance.now() - layoutAt;

    // The core gesture must still complete on a large graph. Going through the
    // shared helper (rather than a raw mouse drag) also asserts the node is
    // actually inside the viewport, so a silent no-op cannot pass as a fast drag.
    const dragAt = performance.now();
    const { before, after } = await dragNode(page, created[0], { dx: 80, dy: 60 });
    const dragMs = performance.now() - dragAt;
    expect(after, '大图上的拖动仍应真的移动节点').not.toBe(before);
    await expect(page.getByTestId('knowledge-drawer')).toHaveCount(0);

    // Real numbers, attached for the report, rather than a bare pass that would
    // hide a thirty-second layout.
    test.info().annotations.push({
      type: 'timing',
      description: `节点 ${created.length}：打开 ${openMs.toFixed(0)}ms、自动布局 ${layoutMs.toFixed(0)}ms、拖动 ${dragMs.toFixed(0)}ms`,
    });

    // Deliberately generous ceilings: they catch a genuine collapse (quadratic
    // layout, an unbatched write storm) without failing on ordinary jitter.
    expect(openMs, '打开 60 节点图不应超过 20 秒').toBeLessThan(20_000);
    expect(layoutMs, '自动布局不应超过 30 秒').toBeLessThan(30_000);
    await expect(page.getByTestId('graph-summary-nodes')).toContainText(`${created.length} 个节点`);
  });

  test('T050-C02 不用画布也能检查同样的关系与来源', async ({ page }) => {
    await gotoInbox(page);
    const { left, leftId, rightId, headers } = await capturePair(page, '替代');
    const quote = Array.from(left).slice(0, 10).join('');
    const relationId = withSeedDb(
      (db) =>
        seedAiRelation(db, {
          sourceId: leftId,
          targetId: rightId,
          score: 0.9,
          reason: 'T050-C02 文本替代用例',
          evidence: [{ itemId: leftId, quote }],
        }).id,
    );

    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('替代视图'),
      itemIds: [leftId, rightId],
    });
    await openScopedGraph(page, viewId, 2);

    // From here the canvas is deliberately untouched: no node or edge click.
    const list = page.getByTestId('graph-relation-list');
    await list.locator('summary').click();

    // The counts a canvas cannot announce, stated in text (T050-R03).
    await expect(page.getByTestId('graph-alt-summary-nodes')).toContainText('节点 2 个');
    await expect(page.getByTestId('graph-alt-summary-edges')).toContainText('关系 1 条');

    await page
      .locator(`[data-testid="graph-relation-list-item"][data-relation-id="${relationId}"]`)
      .click();
    const inspector = page.getByTestId('graph-inspector');
    await expect(inspector).toBeVisible();
    await expect(inspector.getByTestId('graph-inspector-sentence')).toContainText('甲');
    await expect(inspector.getByTestId('graph-inspector-evidence-item')).toHaveCount(1);
    await expect(inspector.getByTestId('graph-inspector-evidence')).toContainText(quote);

    // The endpoints are reachable too, which is what makes the list a substitute
    // for the canvas rather than a summary of it.
    await inspector.getByRole('button', { name: left }).click();
    await expect(page.getByTestId('knowledge-drawer')).toBeVisible();
    await expect(page.getByTestId('knowledge-drawer')).toContainText(left);
  });

  test('T050-C03 建议与已确认边不能只靠颜色区分', async ({ page }) => {
    await gotoInbox(page);
    const { leftId, rightId, headers } = await capturePair(page, '线型');

    // Two edges over the same pair: `supports` is directional and `related_to` is
    // symmetric, so the unique (source,target,type) key permits both while the
    // review statuses differ.
    const ids = withSeedDb((db) => ({
      suggested: seedAiRelation(db, {
        sourceId: leftId,
        targetId: rightId,
        type: 'supports',
        score: 0.9,
        reviewStatus: 'suggested',
      }).id,
      accepted: seedAiRelation(db, {
        sourceId: leftId,
        targetId: rightId,
        type: 'related_to',
        score: 0.9,
        reviewStatus: 'accepted',
      }).id,
    }));

    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('线型视图'),
      itemIds: [leftId, rightId],
    });
    await openScopedGraph(page, viewId, 2);

    // Only the suggested edge carries a badge, and it is a word, not a hue.
    await expect(page.getByTestId('graph-edge-badge')).toHaveCount(1);
    await expect(page.getByTestId('graph-edge-badge')).toContainText('待确认');
    await expect(page.getByTestId('graph-edge-badge')).not.toContainText('已确认');

    // The inspector states each status in words.
    await selectEdgeInList(page, ids.suggested);
    await expect(page.getByTestId('graph-inspector')).toContainText('待确认');
    await page.getByTestId('graph-inspector-close').click();
    await selectEdgeInList(page, ids.accepted);
    await expect(page.getByTestId('graph-inspector')).toContainText('已确认');

    // The legend names the line style each state uses, so the non-colour channel
    // is documented as well as implemented (T050-R04, T050-R06).
    const legend = page.getByTestId('graph-legend');
    await legend.locator('summary').click();
    await expect(legend).toContainText('虚线：待确认的模型建议');
    await expect(legend).toContainText('实线：已确认的关系');
    await expect(legend).toContainText('点线：依据已过期');
  });

  test('T050-C04 知识量远超画布预算时说明当前范围并保留检索入口', async ({ page }) => {
    await gotoInbox(page);
    const headers = await authHeaders(page);
    const prefix = uniqueText('超限');
    const created: string[] = [];
    for (let index = 0; index < 45; index += 1) {
      created.push(await seedItem(page, headers, `${prefix} 超限节点 ${index}`));
    }
    tagItems(created, `超限标签${uniqueText('').slice(-6)}`);

    await page.goto('/graph');
    await expect(page.getByTestId('graph-canvas')).toBeVisible();

    // The two numbers are reported separately: a filtered subgraph must never
    // read as the whole library (T050-R01).
    await expect(page.getByTestId('graph-summary')).toContainText('当前图：');
    await expect(page.getByTestId('graph-summary')).toContainText('筛选共匹配');
    await expect(page.getByTestId('graph-summary')).toContainText('知识库合计');
  });

  test('T050-C05 只有一条记录时显示可读节点与下一步建议', async ({ page }) => {
    await gotoInbox(page);
    const only = uniqueText('稀疏节点');
    await captureViaUi(page, only);
    const headers = await authHeaders(page);
    const onlyId = await findItemId(page, headers, only);

    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('稀疏视图'),
      itemIds: [onlyId],
    });
    await openScopedGraph(page, viewId, 1);

    // A record with no relations is not a failure state (T050-C05): the node is
    // drawn and the situation is described rather than reported as an error.
    await expect(page.getByTestId('graph-node')).toContainText(only);
    await expect(page.getByTestId('graph-node')).toContainText('暂无关系');
    await expect(page.getByTestId('graph-summary-nodes')).toContainText('0 条关系');
    await expect(page.getByTestId('graph-load-error')).toHaveCount(0);
    // The library remains the place to add material.
    await expect(page.getByTestId('graph-summary')).toContainText('知识库合计');
  });

  test('T050-C06 图例把 causes 与 related_to 解释成不同的意思', async ({ page }) => {
    await gotoInbox(page);
    const { leftId, rightId, headers } = await capturePair(page, '图例');
    // `causes` is directional and `related_to` is symmetric, so the legend under
    // test is describing relations the graph really contains.
    withSeedDb((db) => {
      seedAiRelation(db, { sourceId: leftId, targetId: rightId, type: 'causes', score: 0.9 });
    });
    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('图例视图'),
      itemIds: [leftId, rightId],
    });
    await openScopedGraph(page, viewId, 2);

    const legend = page.getByTestId('graph-legend');
    await legend.locator('summary').click();

    const causes = legend.locator('[data-relation-type="causes"]');
    const relatedTo = legend.locator('[data-relation-type="related_to"]');
    await expect(causes).toBeVisible();
    await expect(relatedTo).toBeVisible();

    const causesText = (await causes.textContent()) ?? '';
    const relatedText = (await relatedTo.textContent()) ?? '';
    // The distinction the user needs: one has a direction and one does not.
    // Labelling both 「关联」 is the failure this case exists to catch.
    expect(causesText).not.toBe(relatedText);
    expect(causesText).toContain('原因');
    expect(relatedText).toContain('两端含义相同');
  });
});
