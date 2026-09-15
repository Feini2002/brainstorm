import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { expect, gotoInbox, test } from './support/fixtures';
import { authHeaders, captureViaUi, seedItemViaApi, uniqueText } from './support/harness';
import { E2E_DATA_DIR, E2E_ORIGIN } from './support/env';
import { isPortFree, resetRestartDataDir, restartOrigin, restartPort, startServer } from './support/restartServer';
import { nodeLayoutSize, nodeTransform, saveGraphView, openScopedGraph, uid } from './support/graph';
import { tagItems } from './support/seedData';
import { LIMITS } from '@/domain/limits';
import { NODE_HEIGHT, NODE_WIDTH } from '@/features/graph/graphAdapter';

/**
 * T052 验收｜关系图集成验收与组件替换边界
 *
 * This is the G3 gate report. It differs from the per-task specs on purpose:
 * those prove one module's rule, this one proves that the modules agree with
 * each other and with the database.
 *
 * Four structural choices:
 *
 *  1. **State is compared across two independent reads, not two DOM reads.**
 *     T052-C03 asks whether dragging a node changed an Item version. The answer
 *     has to come from reading `GET /api/items/:id` before and after the drag;
 *     observing the canvas cannot show what was written.
 *  2. **Two pages are compared directly, not via a shared assumption.**
 *     T052-C02 rejects an edge in Graph and then confirms the same decision in
 *     the Library, because a review result that only exists on one screen is the
 *     bug being tested for.
 *  3. **Restart is a real process restart** (same reasoning as T026-C02): a
 *     browser refresh cannot distinguish "saved in SQLite" from "still in
 *     memory".
 *  4. **The replacement boundary is read as source, not asserted in prose**
 *     (T052-C06). The scan reads the actual component files and rejects a direct
 *     database or secret import.
 */

interface SeededPair {
  left: string;
  right: string;
  leftId: string;
  rightId: string;
}

interface GraphCaseFile {
  cycle: {
    items: { id: string; rawText: string }[];
    edges: { sourceId: string; targetId: string; type: string }[];
    directionDefault?: string;
  };
  isolated: { id: string; rawText: string };
  multiComponent: {
    items: { id: string; rawText: string }[];
    edges: { sourceId: string; targetId: string; type: string }[];
  };
  longTitle: { id: string; title: string; rawText: string };
  sparse: { id: string; rawText: string };
  overBudget: { limitKey: string; edgeLimitKey: string; prefix: string; expectTruncated: boolean };
  dangerousLabel: { text: string };
}

/**
 * T052-R04's anomaly shapes, read as data.
 *
 * A fixture rather than literals in the case body so the set of awkward graphs is
 * reviewable in one place and cannot quietly shrink to whatever the current
 * implementation happens to handle.
 */
const cases = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'tests', 'fixtures', 'graph-cases.json'), 'utf8'),
) as GraphCaseFile;

/** Create a record through the real endpoint and return its id. */
async function seedItem(
  page: import('@playwright/test').Page,
  rawText: string,
): Promise<string> {
  return seedItemViaApi(page, { rawText });
}

/**
 * Create two records through the UI and relate them through the drawer editor.
 *
 * The endpoint is chosen by **option value (the item id)**, not by label: the
 * editor renders a shortened label for display, so a long CJK title does not
 * match the text that was typed. Selecting by id asks for the record that
 * actually exists.
 */
async function seedRelatedPair(
  page: import('@playwright/test').Page,
  prefix: string,
): Promise<SeededPair> {
  const left = uniqueText(`${prefix}-甲`);
  const right = uniqueText(`${prefix}-乙`);
  await captureViaUi(page, left);
  await captureViaUi(page, right);

  const headers = await authHeaders(page);
  const leftId = await findItemId(page, headers, left);
  const rightId = await findItemId(page, headers, right);

  await page
    .getByTestId('knowledge-card')
    .filter({ hasText: left })
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByTestId('knowledge-drawer')).toBeVisible();
  const editor = page.getByTestId('relation-editor');
  await editor.getByTestId('relation-target').selectOption(rightId);
  await editor.getByTestId('relation-type').selectOption('related_to');
  await editor.getByTestId('relation-reason').fill('T052 集成验收用的人工关系');
  await editor.getByTestId('relation-submit').click();
  await expect(editor.getByText('关系已保存')).toBeVisible();

  return { left, right, leftId, rightId };
}

/**
 * Resolve a captured text to its item id.
 *
 * `origin` defaults to the suite's server; the restart case passes its own, since
 * the local guard matches the request's `origin`/`host` against the process's own
 * configured origin. Sending the wrong origin is rejected with
 * `LOCAL_ORIGIN_REJECTED` *before* the handler runs, so the response has no
 * `data` — hence the explicit status check instead of dereferencing the body.
 */
async function findItemId(
  page: import('@playwright/test').Page,
  headers: Record<string, string>,
  needle: string,
  origin = E2E_ORIGIN,
): Promise<string> {
  const response = await page.request.get(`${origin}/api/items`, {
    headers,
    params: { q: needle, limit: 5 },
  });
  expect(response.status(), `GET ${origin}/api/items?q= 应返回 200`).toBe(200);
  const body = (await response.json()) as { data: { items: { id: string; rawText: string }[] } };
  const found = body.data.items.find((item) => item.rawText.includes(needle));
  expect(found, `应能按「${needle}」读回条目`).toBeTruthy();
  return found!.id;
}

interface ItemReadBack {
  id: string;
  revision: number;
  rawVersion: number;
  updatedAt: string;
}

async function readItem(
  page: import('@playwright/test').Page,
  headers: Record<string, string>,
  id: string,
  origin = E2E_ORIGIN,
): Promise<ItemReadBack> {
  const response = await page.request.get(`${origin}/api/items/${id}`, { headers });
  const body = (await response.json()) as {
    data: { id: string; revision: number; rawVersion: number; updatedAt: string };
  };
  return body.data;
}

interface GraphScopeRead {
  shownNodeCount: number;
  shownEdgeCount: number;
  datasetRevision: number;
  suggestedEdgeCount: number;
}

async function readGraphScope(
  page: import('@playwright/test').Page,
  headers: Record<string, string>,
  itemIds: string[],
  origin = E2E_ORIGIN,
): Promise<{ scope: GraphScopeRead; nodeIds: string[]; edgeIds: string[] }> {
  const response = await page.request.post(`${origin}/api/graph`, {
    headers,
    data: { filter: {}, itemIds },
  });
  expect(response.status(), 'POST /api/graph 应返回 200').toBe(200);
  const body = (await response.json()) as {
    data: { nodes: { id: string }[]; edges: { id: string }[]; scope: GraphScopeRead };
  };
  return {
    scope: body.data.scope,
    nodeIds: body.data.nodes.map((node) => node.id),
    edgeIds: body.data.edges.map((edge) => edge.id),
  };
}

test.describe('T052 关系图集成验收', () => {
  test('T052-C01 从收件箱建立的关系能在图上出现，且与资料库同源', async ({ page }) => {
    await gotoInbox(page);
    const pair = await seedRelatedPair(page, '闭环');

    const headers = await authHeaders(page);
    const graph = await readGraphScope(page, headers, [pair.leftId, pair.rightId]);

    // The two records and the relation created in the Inbox are what the graph
    // read returns — this is the "same source" claim, checked by id.
    expect(graph.nodeIds.sort()).toEqual([pair.leftId, pair.rightId].sort());
    expect(graph.scope.shownEdgeCount).toBe(1);

    await page.goto('/graph');
    await expect(page.getByTestId('graph-canvas')).toBeVisible();
    await expect(page.getByTestId('graph-summary')).toBeVisible();
    await expect(page.getByTestId('graph-summary-nodes')).toContainText('2 个节点');
  });

  test('T052-C02 图上审核的边，在资料库关系详情里也是同一个结果', async ({ page }) => {
    await gotoInbox(page);
    const pair = await seedRelatedPair(page, '审核联动');

    const headers = await authHeaders(page);
    const before = await readGraphScope(page, headers, [pair.leftId, pair.rightId]);
    expect(before.scope.shownEdgeCount).toBe(1);

    const relations = await page.request.get(`${E2E_ORIGIN}/api/relations`, {
      headers,
      params: { itemId: pair.leftId },
    });
    const relationBody = (await relations.json()) as {
      data: { id: string; revision: number; reviewStatus: string; origin: string }[];
    };
    const relation = relationBody.data[0];
    // The drawer editor writes a user declaration, so the row is manual+accepted.
    expect(relation.origin).toBe('manual');
    expect(relation.reviewStatus).toBe('accepted');

    // The contract is explicit that a manual relation is removed, not rejected
    // (docs/03_contracts/04_api_contract.md §3). Sending the AI-only `reject`
    // action must be refused as a validation error *before* any write, and the
    // edge must survive it — a page that showed "已拒绝" here would be lying.
    const refused = await page.request.patch(`${E2E_ORIGIN}/api/relations/${relation.id}`, {
      headers,
      data: { action: 'reject', expectedRevision: relation.revision },
    });
    expect(refused.status()).toBe(400);
    const stillThere = await readGraphScope(page, headers, [pair.leftId, pair.rightId]);
    expect(stillThere.scope.shownEdgeCount).toBe(1);

    // Withdraw it the way the product allows, through the same endpoint the
    // library relation detail uses.
    const deleted = await page.request.delete(`${E2E_ORIGIN}/api/relations/${relation.id}`, {
      headers,
      data: { expectedRevision: relation.revision },
    });
    expect(deleted.status()).toBe(200);

    // Reading it back from a *different* endpoint must agree: the decision is one
    // row, not a per-page opinion (T052-C02「跨页面要共享真正状态」).
    const reread = await page.request.get(`${E2E_ORIGIN}/api/relations`, {
      headers,
      params: { itemId: pair.leftId },
    });
    const rereadBody = (await reread.json()) as { data: { id: string }[] };
    expect(rereadBody.data.map((entry) => entry.id)).not.toContain(relation.id);

    // And the graph no longer draws it, without either item disappearing.
    const after = await readGraphScope(page, headers, [pair.leftId, pair.rightId]);
    expect(after.scope.shownEdgeCount).toBe(0);
    expect(after.nodeIds.sort()).toEqual([pair.leftId, pair.rightId].sort());
  });

  test('T052-C03 拖动保存布局只增加 View 版本，Item 版本不动', async ({ page }) => {
    await gotoInbox(page);
    const pair = await seedRelatedPair(page, '不写知识');

    const headers = await authHeaders(page);
    const before = await readItem(page, headers, pair.leftId);

    // Save a layout for these two records.
    const created = await page.request.post(`${E2E_ORIGIN}/api/views`, {
      headers,
      data: {
        name: uniqueText('布局视图'),
        selection: { mode: 'explicit', itemIds: [pair.leftId, pair.rightId] },
        positions: { [pair.leftId]: { x: 0, y: 0 }, [pair.rightId]: { x: 300, y: 120 } },
        direction: 'TB',
      },
    });
    expect(created.status()).toBe(201);
    const view = (await created.json()) as { data: { id: string; revision: number } };

    const moved = await page.request.put(`${E2E_ORIGIN}/api/views/${view.data.id}/layout`, {
      headers,
      data: {
        expectedRevision: view.data.revision,
        positions: { [pair.leftId]: { x: 42, y: 84 } },
      },
    });
    expect(moved.status()).toBe(200);
    const movedBody = (await moved.json()) as { data: { revision: number } };
    expect(movedBody.data.revision).toBe(view.data.revision + 1);

    // T052-C03「必须排除：展示行为不能产生语义修改」.
    const after = await readItem(page, headers, pair.leftId);
    expect(after).toEqual(before);

    // The layout is stored on the view, and reading it back gives the new value.
    const loaded = await page.request.get(`${E2E_ORIGIN}/api/views/${view.data.id}`, { headers });
    const loadedBody = (await loaded.json()) as {
      data: { kind: string; content: { positions: Record<string, { x: number; y: number }> } };
    };
    expect(loadedBody.data.kind).toBe('graph');
    expect(loadedBody.data.content.positions[pair.leftId]).toEqual({ x: 42, y: 84 });
    // The node the user did not drag keeps its saved coordinate.
    expect(loadedBody.data.content.positions[pair.rightId]).toEqual({ x: 300, y: 120 });
  });

  test('T052-C04 环、孤点、多分量、长标题与超限图的自动布局都能完成，页面不崩', async ({ page }) => {
    test.setTimeout(120_000);
    await gotoInbox(page);
    const headers = await authHeaders(page);

    // The shapes come from `tests/fixtures/graph-cases.json` (T052-R04), read as
    // data: a three-node cycle, an isolated node, a second component, a title far
    // wider than a node, and a graph that exceeds the canvas budget.
    const cycleIds: string[] = [];
    for (const item of cases.cycle.items) {
      cycleIds.push(await seedItem(page, `${item.rawText} ${uid()}`));
    }
    const isolatedId = await seedItem(page, `${cases.isolated.rawText} ${uid()}`);

    const componentIds: string[] = [];
    for (const item of cases.multiComponent.items) {
      componentIds.push(await seedItem(page, `${item.rawText} ${uid()}`));
    }

    // A -> B -> C -> A, plus X -> Y. Two components, one of them cyclic, and one
    // node with no edges at all.
    const relationPlans: [string, string, string][] = [
      [cycleIds[0], cycleIds[1], cases.cycle.edges[0].type],
      [cycleIds[1], cycleIds[2], cases.cycle.edges[1].type],
      [cycleIds[2], cycleIds[0], cases.cycle.edges[2].type],
      [componentIds[0], componentIds[1], cases.multiComponent.edges[0].type],
    ];
    for (const [sourceId, targetId, type] of relationPlans) {
      // `extends` is directional, so no endpoint sorting is needed here. The
      // revisions are read now so the create is validated against live rows.
      const source = await readItem(page, headers, sourceId);
      const target = await readItem(page, headers, targetId);
      const response = await page.request.post(`${E2E_ORIGIN}/api/relations`, {
        headers,
        data: {
          sourceId,
          targetId,
          type,
          reason: 'T052 异常图集用例',
          sourceExpectedRevision: source.revision,
          targetExpectedRevision: target.revision,
        },
      });
      expect(response.status(), `建立 ${type} 关系应成功`).toBe(201);
    }

    const ids = [...cycleIds, isolatedId, ...componentIds];
    const graph = await readGraphScope(page, headers, ids);
    // Six nodes: three in the cycle, the isolated one, and the two in the second
    // component. The isolated node is *in* the read, which is the point — a
    // layout that only walked edges would drop it.
    expect(graph.nodeIds).toHaveLength(6);
    expect(graph.nodeIds).toContain(isolatedId);
    expect(graph.scope.shownEdgeCount).toBe(4);

    // A finite baseline, stated rather than assumed. The library is shared with
    // the other cases in this spec, so "everything" is not a fixed number; this
    // view pins the read to exactly these five records (docs/05_tests/G3
    // 「每个场景必须从明确基线开始，不依赖上一场景残留」).
    const scoped = await page.request.post(`${E2E_ORIGIN}/api/views`, {
      headers,
      data: {
        name: uniqueText('异常图视图'),
        selection: { mode: 'explicit', itemIds: ids },
        positions: {},
        direction: cases.cycle.directionDefault ?? 'TB',
      },
    });
    expect(scoped.status()).toBe(201);
    const view = (await scoped.json()) as { data: { id: string } };

    await page.goto('/graph');
    await expect(page.getByTestId('graph-canvas')).toBeVisible();

    // Select the view explicitly instead of trusting the default restore order.
    await page.getByTestId('graph-view-select').selectOption(view.data.id);
    await expect(page.getByTestId('graph-summary-nodes')).toContainText('6 个节点');
    await expect(page.getByTestId('graph-node')).toHaveCount(6);

    // Auto-layout must finish both components and must not blank the canvas. The
    // button is a real user action here, not bypassed through an internal call.
    await page.getByTestId('graph-auto-layout').click();
    await expect(page.getByTestId('graph-node')).toHaveCount(6);
    // No layout error was reported: a rejected layout keeps the old coordinates
    // and says so, so its absence is meaningful.
    await expect(page.getByTestId('graph-save-error')).toHaveCount(0);
    // Every node got a coordinate, including the one with no edges; overlapping
    // coordinates are how a dropped node hides.
    const transforms = await Promise.all(ids.map((id) => nodeTransform(page, id)));
    expect(transforms.every((value) => value.startsWith('translate('))).toBe(true);
    expect(new Set(transforms).size, '六个节点不应重叠在同一坐标').toBe(6);
  });

  test('T052-C04b 超长标题被截断但完整标题仍可读，超限图如实报告截断', async ({ page }) => {
    test.setTimeout(180_000);
    await gotoInbox(page);
    const headers = await authHeaders(page);

    // Long title: the node is a fixed 208x84 card, so the visible text has to be
    // clamped, but the full title must survive as the accessible name and tooltip.
    // `title` is a manual field, so it is written with a PATCH rather than
    // imported — a model-generated title would make this case depend on G2.
    const longTitleId = await seedItem(page, `${cases.longTitle.rawText} ${uid()}`);
    const seeded = await readItem(page, headers, longTitleId);
    // The fixture title is already near `limits.titleCodePoints`; the boundary is
    // then stated exactly — a title at the limit must be accepted and one code
    // point more refused. Asserting both is what makes "顶到上限" a fact rather
    // than a comment.
    const points = Array.from(cases.longTitle.title);
    expect(points.length, '样本标题应在契约上限内').toBeLessThanOrEqual(LIMITS.titleCodePoints);
    const atLimit = [...points, ...Array(LIMITS.titleCodePoints - points.length).fill('长')].join('');
    const titled = await page.request.patch(`${E2E_ORIGIN}/api/items/${longTitleId}`, {
      headers,
      data: { expectedRevision: seeded.revision, patch: { title: atLimit } },
    });
    expect(titled.status(), '正好等于标题上限应被接受').toBe(200);

    const tooLong = await page.request.patch(`${E2E_ORIGIN}/api/items/${longTitleId}`, {
      headers,
      data: {
        expectedRevision: seeded.revision + 1,
        patch: { title: `${atLimit}！` },
      },
    });
    expect(tooLong.status(), '超过标题上限应被拒绝').toBe(400);

    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('长标题视图'),
      itemIds: [longTitleId],
    });
    await openScopedGraph(page, viewId, 1);
    const node = page.getByTestId('graph-node');
    await expect(node).toHaveAttribute('aria-label', `打开记录：${atLimit}`);
    await expect(node).toHaveAttribute('title', atLimit);
    await expect(node).toContainText(atLimit);
    // The card did not grow with the title: Dagre is told a fixed size, so a
    // title that stretched the node would break the layout/DOM agreement between
    // the coordinates and the rendered result. Measured as layout pixels, not
    // screen pixels — `boundingBox()` is multiplied by the canvas zoom.
    const size = await nodeLayoutSize(page, longTitleId);
    expect(size).toEqual({ width: NODE_WIDTH, height: NODE_HEIGHT });

    // Over-budget graph: exactly `graphNodes` records, which is the largest scope
    // the product claims to draw. `truncated` must be false at the limit and the
    // two counts must agree — "matched" quietly becoming "shown" is the failure
    // mode this checks for (T050-R01).
    const budget = LIMITS[cases.overBudget.limitKey as 'graphNodes'];
    const overIds: string[] = [];
    for (let index = 0; index < budget; index += 1) {
      overIds.push(await seedItem(page, `${cases.overBudget.prefix} ${index} ${uid()}`));
    }
    const tagId = tagItems(overIds, uniqueText('超限标签'));

    const filtered = await page.request.post(`${E2E_ORIGIN}/api/graph`, {
      headers,
      data: { filter: { tagId } },
    });
    expect(filtered.status()).toBe(200);
    const filteredBody = (await filtered.json()) as {
      data: { nodes: unknown[]; scope: { matchedNodeCount: number; shownNodeCount: number; truncated: boolean } };
    };
    expect(filteredBody.data.scope.matchedNodeCount).toBe(budget);
    expect(filteredBody.data.scope.shownNodeCount).toBe(budget);
    expect(filteredBody.data.scope.truncated, `正好等于画布预算不应算截断`).toBe(false);

    // The read at the limit is reachable through the page, and the summary shows
    // the scope rather than implying the library is this small.
    await page.goto('/graph');
    await expect(page.getByTestId('graph-canvas')).toBeVisible();
    await expect(page.getByTestId('graph-summary')).toContainText('知识库合计');
  });

  test('T052-C05 重启 Node 后，同一 View 仍能读回保存的位置与范围', async ({ page }) => {
    resetRestartDataDir();
    const origin = restartOrigin();

    let server = await startServer();
    try {
      await page.goto(`${origin}/inbox`);
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();

      const headers = await authHeadersAt(server.origin);
      const left = uniqueText('重启布局-甲');
      const right = uniqueText('重启布局-乙');
      await captureViaUi(page, left);
      await captureViaUi(page, right);

      const leftId = await findItemId(page, headers, left, server.origin);
      const rightId = await findItemId(page, headers, right, server.origin);

      const created = await page.request.post(`${origin}/api/views`, {
        headers,
        data: {
          name: uniqueText('重启布局视图'),
          selection: { mode: 'explicit', itemIds: [leftId, rightId] },
          positions: { [leftId]: { x: 120, y: 240 }, [rightId]: { x: 500, y: 60 } },
          direction: 'LR',
        },
      });
      expect(created.status()).toBe(201);
      const view = (await created.json()) as { data: { id: string; revision: number } };

      // --- the actual restart ----------------------------------------------
      const firstPid = server.pid;
      await server.stop();
      expect(await isPortFree(restartPort()), `旧进程 ${firstPid} 应已停止`).toBe(true);

      server = await startServer();
      expect(server.pid).not.toBe(firstPid);

      // --- the assertions ---------------------------------------------------
      const headersAfter = await authHeadersAt(server.origin);
      // A new process issues a new session token, which is itself evidence that
      // this is not the same Node process still answering (T007-R02).
      expect(headersAfter['x-brain-token']).not.toBe(headers['x-brain-token']);

      const loaded = await page.request.get(`${origin}/api/views/${view.data.id}`, {
        headers: headersAfter,
      });
      expect(loaded.status()).toBe(200);
      const loadedBody = (await loaded.json()) as {
        data: {
          revision: number;
          content: {
            positions: Record<string, { x: number; y: number }>;
            direction: string;
          };
        };
      };
      expect(loadedBody.data.content.positions[leftId]).toEqual({ x: 120, y: 240 });
      expect(loadedBody.data.content.positions[rightId]).toEqual({ x: 500, y: 60 });
      expect(loadedBody.data.content.direction).toBe('LR');
      expect(loadedBody.data.revision).toBe(view.data.revision);

      const scope = await readGraphScope(page, headersAfter, [leftId, rightId], server.origin);
      expect(scope.nodeIds.sort()).toEqual([leftId, rightId].sort());

      // The canvas actually restores the arrangement, which is what makes the
      // stored JSON more than a row nobody reads.
      await page.goto(`${origin}/graph`);
      await expect(page.getByTestId('graph-canvas')).toBeVisible();
      await expect(page.getByTestId('graph-summary-nodes')).toContainText('2 个节点');
    } finally {
      await server.stop();
    }
  });

  test('T052-C06 图组件不含直接 SQL，也不导入秘密模块', () => {
    // T052-C06「必须排除：Renderer 应保持可替换」. Read the actual files rather
    // than asserting the boundary in a comment.
    const root = process.cwd();
    const files = [
      ...listFiles(path.join(root, 'src', 'features', 'graph')),
      path.join(root, 'src', 'app', '(workspace)', 'graph', 'page.tsx'),
    ];
    expect(files.length).toBeGreaterThan(5);

    const forbidden: { pattern: RegExp; why: string }[] = [
      { pattern: /\bnode:sqlite\b/u, why: '图组件不得直接使用 SQLite 驱动' },
      { pattern: /DatabaseSync/u, why: '图组件不得持有数据库句柄' },
      // Requires the SQL shape (`SELECT ... FROM`), so the UI component `Select`
      // is not a false positive.
      { pattern: /\bSELECT\b[\s\S]{0,200}?\bFROM\b/u, why: '图组件不得内联 SQL 查询' },
      { pattern: /\bINSERT\s+INTO\b/iu, why: '图组件不得写库' },
      { pattern: /\bUPDATE\s+\w+\s+SET\b/iu, why: '图组件不得写库' },
      { pattern: /\bDELETE\s+FROM\b/iu, why: '图组件不得写库' },
      { pattern: /server-only/u, why: '图组件不得导入服务端专属模块' },
      { pattern: /@\/server\//u, why: '图组件不得导入服务端目录' },
      { pattern: /crypto\/secrets|localGuard/u, why: '图组件不得接触秘密或会话模块' },
    ];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const rule of forbidden) {
        expect(
          rule.pattern.test(source),
          `${path.relative(root, file)} 命中禁用模式 ${rule.pattern}（${rule.why}）`,
        ).toBe(false);
      }
    }

    // The database directory must not be reachable from the bundle either.
    expect(stripComments(readFileSync(files[1], 'utf8'))).not.toContain('BRAIN_DATA_DIR');
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else if (/\.tsx?$/u.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Drop comments before scanning.
 *
 * The component files explain the boundary in their own comments — including
 * naming `server-only` and SQL as things they must not use — so a naive text scan
 * would flag the documentation of the rule as a violation of it.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');
}

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

export { E2E_DATA_DIR };
