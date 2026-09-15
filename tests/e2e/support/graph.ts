import { expect, type Page } from '@playwright/test';

import { E2E_ORIGIN } from './env';
import { authHeaders, captureViaUi, openRoute } from './harness';

/**
 * Shared helpers for the G3 graph specs (T048–T052).
 *
 * These live here rather than in each spec because four specs need the same two
 * capabilities, and a copy per file is how they drift apart:
 *
 *  - **Resolving a captured text to its item id through the API**, not by reading
 *    `data-item-id` off the DOM. The drawer specs already proved the search
 *    endpoint returns the record; asking it directly keeps a case from depending
 *    on which page the card happens to be on.
 *  - **Opening the graph scoped to an exact id list.** The library is shared
 *    across all cases in a run and the canvas caps what it draws (`graphEdges`),
 *    so "everything" is not a fixed baseline. An explicit-selection view is the
 *    only way a case states its own scope (docs/05_tests/G3「每个场景必须从明确
 *    基线开始，不依赖上一场景残留」).
 */

export interface ReadItemResult {
  id: string;
  revision: number;
  rawVersion: number;
  rawText: string;
}

/** Resolve a unique captured text to its item id, searching the real API. */
export async function findItemId(
  page: Page,
  headers: Record<string, string>,
  needle: string,
): Promise<string> {
  const response = await page.request.get(`${E2E_ORIGIN}/api/items`, {
    headers,
    params: { q: needle, limit: 5 },
  });
  expect(response.status(), 'GET /api/items?q= 应返回 200').toBe(200);
  const body = (await response.json()) as { data: { items: { id: string; rawText: string }[] } };
  const found = body.data.items.find((item) => item.rawText.includes(needle));
  expect(found, `应能按「${needle}」读回条目`).toBeTruthy();
  return found!.id;
}

/** Read one item's versioned state, for before/after comparisons. */
export async function readItem(
  page: Page,
  headers: Record<string, string>,
  id: string,
  origin = E2E_ORIGIN,
): Promise<ReadItemResult> {
  const response = await page.request.get(`${origin}/api/items/${id}`, { headers });
  expect(response.status(), `GET /api/items/${id} 应返回 200`).toBe(200);
  const body = (await response.json()) as { data: ReadItemResult };
  return body.data;
}

/** Capture two records and return both texts with their ids, in creation order. */
export async function capturePair(
  page: Page,
  prefix: string,
): Promise<{ left: string; right: string; leftId: string; rightId: string; headers: Record<string, string> }> {
  const left = `${prefix}-甲-${uid()}`;
  const right = `${prefix}-乙-${uid()}`;
  await captureViaUi(page, left);
  await captureViaUi(page, right);
  const headers = await authHeaders(page);
  const leftId = await findItemId(page, headers, left);
  const rightId = await findItemId(page, headers, right);
  return { left, right, leftId, rightId, headers };
}

/** Unique suffix, so cases in one accumulated database never collide. */
export function uid(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export interface SaveViewInput {
  name: string;
  itemIds?: string[];
  /** A filter scope instead of an id list; the two are mutually exclusive. */
  filter?: Record<string, unknown>;
  positions?: Record<string, { x: number; y: number }>;
  direction?: 'TB' | 'LR';
}

/** Create a graph View through the real endpoint and return its id. */
export async function saveGraphView(
  page: Page,
  headers: Record<string, string>,
  input: SaveViewInput,
): Promise<string> {
  // A filter scope goes through the same endpoint as an explicit one, so the
  // snapshot the view depends on is built by the product rather than by the spec.
  // Hand-writing a View row would let a fixture skip snapshot construction and
  // produce a row no real code path could have created.
  const selection =
    input.filter !== undefined
      ? { mode: 'filter', filter: input.filter }
      : { mode: 'explicit', itemIds: input.itemIds ?? [] };

  const created = await page.request.post(`${E2E_ORIGIN}/api/views`, {
    headers,
    data: {
      name: input.name,
      selection,
      positions: input.positions ?? {},
      direction: input.direction ?? 'TB',
    },
  });
  expect(created.status(), '创建关系图视图应返回 201').toBe(201);
  const body = (await created.json()) as { data: { id: string } };
  return body.data.id;
}

/**
 * Open `/graph` and select one view, so the read is pinned to a known id list.
 *
 * Selecting explicitly rather than trusting the default restore order also
 * exercises the scope picker, which is the control that makes a narrowed read
 * escapable.
 */
export async function openScopedGraph(
  page: Page,
  viewId: string,
  expectedNodes?: number,
): Promise<void> {
  await openRoute(page, '/graph');
  await expect(page.getByTestId('graph-canvas')).toBeVisible();
  await page.getByTestId('graph-view-select').selectOption(viewId);
  if (expectedNodes !== undefined) {
    await expect(page.getByTestId('graph-node')).toHaveCount(expectedNodes);
  }
}

/** The rendered transform of one node, which is where a stored coordinate lands. */
export async function nodeTransform(page: Page, itemId: string): Promise<string> {
  const value = await page
    .locator(`[data-testid="graph-node"][data-item-id="${itemId}"]`)
    .evaluate((element) => element.parentElement?.style.transform ?? '');
  return String(value);
}

export interface StoredView {
  id: string;
  revision: number;
  content: { positions: Record<string, { x: number; y: number }>; direction?: string };
}

/**
 * Read a saved view's stored content through the API.
 *
 * Used when a case has to prove a *write* happened — the page's own render is
 * the same draft either way, so only the persisted row distinguishes "saved"
 * from "still on screen unsaved".
 */
export async function readStoredView(
  page: Page,
  headers: Record<string, string>,
  viewId: string,
): Promise<StoredView> {
  const response = await page.request.get(`${E2E_ORIGIN}/api/views/${viewId}`, { headers });
  expect(response.status(), 'GET /api/views/:id 应返回 200').toBe(200);
  const body = (await response.json()) as { data: StoredView };
  return body.data;
}

/**
 * Drag one node on the canvas by a screen-space delta, and report the before and
 * after transforms.
 *
 * A node can sit below the browser fold while still having a geometric
 * `boundingBox()` — Playwright reports the box either way, but a mouse event at a
 * y beyond the viewport height is delivered to nothing and the drag silently does
 * nothing. Scrolling the node into view first, and asserting it is genuinely
 * inside the viewport, is what stops this from becoming a passing-looking test
 * that proves nothing.
 */
export async function dragNode(
  page: Page,
  itemId: string,
  delta: { dx: number; dy: number },
  steps = 10,
): Promise<{ before: string; after: string }> {
  const node = page.locator(`[data-testid="graph-node"][data-item-id="${itemId}"]`);
  await node.scrollIntoViewIfNeeded();
  const before = await nodeTransform(page, itemId);
  const box = await node.boundingBox();
  expect(box, '节点应有可拖动的几何位置').toBeTruthy();

  const viewport = page.viewportSize();
  if (viewport) {
    expect(
      box!.y + box!.height <= viewport.height,
      '拖动前节点必须完整落在视口内，否则鼠标事件不会命中',
    ).toBe(true);
  }

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box!.x + box!.width / 2 + delta.dx,
    box!.y + box!.height / 2 + delta.dy,
    { steps },
  );
  await page.mouse.up();
  return { before, after: await nodeTransform(page, itemId) };
}

/**
 * The layout box of a node, in CSS pixels.
 *
 * `boundingBox()` is measured in *screen* space, so React Flow's `fitView` zoom
 * scales it: a 208px card read 216px at zoom 1.04, which looks like a node that
 * grew with its title. `offsetWidth`/`offsetHeight` are the pre-transform
 * layout size, which is the number Dagre was told and the one that must match.
 */
export async function nodeLayoutSize(
  page: Page,
  itemId: string,
): Promise<{ width: number; height: number }> {
  return page
    .locator(`[data-testid="graph-node"][data-item-id="${itemId}"]`)
    .evaluate((element) => {
      // The locator can resolve to an `SVGElement` in principle, which has no
      // `offsetWidth`; the node is a `div`, and the guard states that rather than
      // casting it away.
      if (!(element instanceof HTMLElement)) {
        throw new Error('关系图节点应渲染为 HTMLElement');
      }
      return { width: element.offsetWidth, height: element.offsetHeight };
    });
}

/**
 * Click a node on the canvas to open its drawer.
 *
 * React Flow owns the pointer gesture on its own wrapper and runs a `fitView`
 * animation after a scope change, so a plain `click()` intermittently fails the
 * hit-target check against the node's ancestor or the pane. `force` still
 * dispatches a real click at the element's centre, which then bubbles to the
 * wrapper that carries `onNodeClick` — the same path a user's click takes.
 */
export async function openNodeFromCanvas(page: Page, itemId: string): Promise<void> {
  await page.locator(`[data-testid="graph-node"][data-item-id="${itemId}"]`).click({ force: true });
  await expect(page.getByTestId('knowledge-drawer')).toBeVisible();
}

/** Select an edge by clicking its label in the accessible relation list. */
export async function selectEdgeInList(page: Page, relationId: string): Promise<void> {
  const list = page.getByTestId('graph-relation-list');
  // The list is a `<details>`, so it must be open before its buttons are
  // reachable — but clicking the summary again would *close* it, which broke the
  // second selection in a case that picks two edges in a row.
  const open = await list.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!open) await list.locator('summary').click();
  await expect(list).toHaveAttribute('open', '');

  await page
    .locator(`[data-testid="graph-relation-list-item"][data-relation-id="${relationId}"]`)
    .click();
}

/**
 * Create a relation between two records through the drawer's own editor.
 *
 * Going through the UI is deliberate: the point of T049-C01 is that the drawer
 * is the single editing surface, so a spec that wrote the relation through the
 * API would not be exercising the path it is meant to check.
 */
export async function relateViaDrawer(
  page: Page,
  sourceText: string,
  targetId: string,
  reason: string,
): Promise<void> {
  await page
    .getByTestId('knowledge-card')
    .filter({ hasText: sourceText })
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByTestId('knowledge-drawer')).toBeVisible();
  const editor = page.getByTestId('relation-editor');
  // Selecting by value (the id) rather than label: the editor renders a shortened
  // label, so a long CJK title does not match the typed text.
  await editor.getByTestId('relation-target').selectOption(targetId);
  await editor.getByTestId('relation-type').selectOption('related_to');
  await editor.getByTestId('relation-reason').fill(reason);
  await editor.getByTestId('relation-submit').click();
  await expect(editor.getByText('关系已保存')).toBeVisible();
}
