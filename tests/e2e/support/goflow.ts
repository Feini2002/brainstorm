import { expect, type Locator, type Page } from '@playwright/test';

import { E2E_ORIGIN } from './env';
import { authHeaders } from './harness';
import {
  ensureLlmConfigured,
  setSchemaRepairEnabled,
  writeScript,
} from './gomindmap';
import { seedView, withSeedDb } from './seedData';

/**
 * Shared helpers for the G5 flow acceptance (T069) and the G5 per-task specs.
 *
 * They live here rather than inside one spec because three of them are the only
 * way a browser-driven case can reach the *production* generation path without a
 * live provider, and each is a substitution that has to be stated once:
 *
 *  - **The model answer is a script file, not a fake route.** `scriptedFlowGeneration`
 *    writes one script and posts to the real `/api/views/mermaid/generate`: the
 *    guard, the strict schema, the domain evidence gate, the compiler check, the
 *    run registration and the insert all run for real. Only the outbound HTTP step
 *    is replayed (`src/server/llm/transport.ts`, `BRAIN_SCRIPTED_PROVIDER`). A
 *    test-only endpoint returning a fixed diagram is what T011-C03 forbids.
 *
 *  - **The connection is written the way the product writes it.** Generation
 *    refuses to start without a configured model, so bypassing
 *    `PUT /api/settings/llm` (by seeding a `settings` row) would prove that a
 *    hand-written config works, not that the product's own save path does.
 *
 *  - **Items and relations are created through real routes or the suite's own
 *    throwaway database.** `seedAiRelation` is used for the one relation shape the
 *    UI cannot produce without a model: an *accepted `causes`* edge, which is the
 *    justification a `causal` flow edge needs. A relation the case accepted through
 *    the UI would be `manual`, and `validateFlow` only honours `causes` +
 *    `accepted` regardless of origin, so seeding is the honest way to reach the
 *    "with evidence" branch without a paid model call.
 *
 * **One suite-level obligation comes with the settings write**: the acceptance
 * suite's database is shared between spec files and is not reset per file, and
 * several later specs (`offline-crud`, `save-races`, `mindmap-regeneration`)
 * assert the *unconfigured* behaviour. `restoreLlmSettings()` therefore puts the
 * connection back to the suite's starting state, and every G5 spec that configures
 * a connection calls it from `test.afterAll`.
 */

/** The formats the export route serves for a flow. SVG is browser-side only. */
export type FlowServerExportFormat = 'json' | 'mermaid';

/** Look up the run a request key registered, so a refusal is still attributable. */
function findRunByRequestKey(requestKey: string): { id: string; state: string } | null {
  return withSeedDb((db) => {
    const row = db
      .prepare('SELECT id, state FROM ai_runs WHERE request_key = ?')
      .get(requestKey) as { id: string; state: string } | undefined;
    return row ?? null;
  });
}

export interface FlowExportFile {
  status: number;
  body: string;
  contentType: string;
  disposition: string | null;
}

export interface FlowGenerationOutcome {
  status: number;
  success: boolean;
  runId: string;
  viewId: string | null;
  state: string;
  warnings: string[];
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Run one real flow generation whose model answer is a fixed script.
 *
 * Nothing about the request is special: the selection is re-read from the
 * database, the answer travels the real adapter, schema, evidence gate and
 * transaction, and the outcome is reported exactly as the route reports it —
 * including failures, which are *not* smoothed into an empty success.
 *
 * `repair: false` is the default because a malformed sample that got repaired
 * would be answered by a *second* scripted reply (the repair request), and a
 * scripted provider with one reply would then fail for a reason unrelated to the
 * rule under test.
 */
export async function scriptedFlowGeneration(
  page: Page,
  headers: Record<string, string>,
  options: {
    itemIds: string[];
    body: string;
    intent?: string;
    direction?: 'LR' | 'TB';
    schemaRepairEnabled?: boolean;
  },
): Promise<FlowGenerationOutcome> {
  await ensureLlmConfigured(headers);
  await setSchemaRepairEnabled(headers, options.schemaRepairEnabled ?? false);

  writeScript(options.body);

  const requestKey = crypto.randomUUID();
  const response = await page.request.post(`${E2E_ORIGIN}/api/views/mermaid/generate`, {
    headers,
    data: {
      requestKey,
      selection: { mode: 'explicit', itemIds: options.itemIds },
      intent: options.intent ?? '这些材料里哪些步骤有先后顺序，哪些是前提、哪些是结果？',
      direction: options.direction ?? 'LR',
    },
  });
  const status = response.status();
  const envelope = (await response.json()) as {
    ok: boolean;
    data?: { runId: string; viewId?: string; state: string; warnings?: string[] };
    error?: { code: string; message: string };
  };

  if (envelope.ok && envelope.data) {
    return {
      status,
      success: true,
      runId: envelope.data.runId,
      viewId: envelope.data.viewId ?? null,
      state: envelope.data.state,
      warnings: envelope.data.warnings ?? [],
      errorCode: null,
      errorMessage: null,
    };
  }

  const run = findRunByRequestKey(requestKey);
  if (run === null) {
    throw new Error(
      `流程生成请求以 ${envelope.error?.code ?? status} 失败，但库中没有对应的运行记录：${envelope.error?.message ?? ''}`,
    );
  }

  return {
    status,
    success: false,
    runId: run.id,
    viewId: null,
    state: run.state,
    warnings: [],
    errorCode: envelope.error?.code ?? null,
    // The route's own message, which is what a case asserts names the broken rule.
    errorMessage: envelope.error?.message ?? null,
  };
}

/**
 * Read one run's stored outcome (T040's read-only status route).
 *
 * Needed because the failure envelope deliberately carries no run id: the run row
 * is the authority on what happened, so a case that wants to assert *why* an
 * answer was refused reads it back rather than inferring from a status code.
 */
export async function readFlowRun(
  page: Page,
  headers: Record<string, string>,
  runId: string,
): Promise<{ id: string; state: string; error: { code: string; message: string } | null }> {
  const response = await page.request.get(`${E2E_ORIGIN}/api/runs/${runId}`, { headers });
  expect(response.status(), `GET /api/runs/${runId} 应返回 200`).toBe(200);
  const envelope = (await response.json()) as {
    ok: boolean;
    data: { id: string; state: string; error: { code: string; message: string } | null };
  };
  return envelope.data;
}

/** Download one flow export exactly as the app does, returning the raw response. */
export async function fetchFlowExport(
  page: Page,
  headers: Record<string, string>,
  viewId: string,
  format: string,
): Promise<FlowExportFile> {
  const response = await page.request.get(
    `${E2E_ORIGIN}/api/views/${viewId}/export?format=${format}`,
    { headers },
  );
  return {
    status: response.status(),
    body: await response.text(),
    contentType: response.headers()['content-type'] ?? '',
    disposition: response.headers()['content-disposition'] ?? null,
  };
}

/** The ids of every saved flow, sorted, so "nothing was added" is exact. */
export async function listFlowViewIds(
  page: Page,
  headers: Record<string, string>,
): Promise<string[]> {
  const response = await page.request.get(`${E2E_ORIGIN}/api/views`, {
    headers,
    params: { kind: 'flow', limit: 100 },
  });
  expect(response.status(), 'GET /api/views?kind=flow 应返回 200').toBe(200);
  const envelope = (await response.json()) as { ok: boolean; data: { views: { id: string }[] } };
  return envelope.data.views.map((view) => view.id).sort();
}

/** Create one record through the real capture endpoint, returning its id and text. */
export async function captureFlowSource(
  page: Page,
  prefix: string,
): Promise<{ id: string; text: string }> {
  const text = `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const response = await page.request.post(`${E2E_ORIGIN}/api/items`, {
    headers: await authHeaders(page),
    data: {
      captureRequestId: crypto.randomUUID(),
      rawText: text,
      sourceType: 'other',
      sourceRef: null,
    },
  });
  expect(response.status(), `POST /api/items 应返回 201，实际 ${response.status()}`).toBe(201);
  const envelope = (await response.json()) as { ok: boolean; data: { item: { id: string } } };
  return { id: envelope.data.item.id, text };
}

/** Open `/flow` with one saved view selected, so the read is a known id list. */
export async function openSavedFlow(
  page: Page,
  viewId: string,
  origin = E2E_ORIGIN,
): Promise<void> {
  await page.goto(`${origin}/flow`);
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  const select = page.getByTestId('flow-view-select');
  await expect(select.locator(`option[value="${viewId}"]`)).toHaveCount(1);
  await select.selectOption(viewId);
  await expect(page.getByTestId('flow-renderer')).toBeVisible();
}

/* -------------------------------------------------------------------------- */
/* Stored content seeding                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The one edge shape the G5 specs reuse: two nodes joined by a single edge.
 *
 * Written here rather than in each spec because four of them seed "a flow that
 * already exists" — the property under test is about reading, drawing, ageing or
 * exporting a stored row, and none of those become true or false depending on how
 * the row was created. The cases that *are* about the creation path go through
 * `scriptedFlowGeneration` instead.
 */
export interface FlowSeedSpec {
  title: string;
  /** Node label pairs: `[id, label]`, each citing `itemIds` in order. */
  nodes: [string, string][];
  /** `[source, target, kind, label]`, citing the two endpoints' sources. */
  edges?: [string, string, string, string][];
  direction?: 'LR' | 'TB';
}

/**
 * Seed one flow view into the suite's own throwaway database.
 *
 * `itemIds` is the set the nodes cite (cycled across nodes and used for the
 * snapshot), so a case can assert on a *known* source list rather than on what a
 * generation happened to produce.
 */
export function seedFlowContent(
  itemIds: string[],
  spec: FlowSeedSpec,
): { title: string; direction: 'LR' | 'TB'; nodes: unknown[]; edges: unknown[] } {
  const cite = (index: number): string[] =>
    itemIds.length === 0 ? [] : [itemIds[index % itemIds.length]!];
  return {
    title: spec.title,
    direction: spec.direction ?? 'LR',
    nodes: spec.nodes.map(([id, label], index) => ({ id, label, itemIds: cite(index) })),
    edges: (spec.edges ?? []).map(([source, target, kind, label], index) => ({
      source,
      target,
      kind,
      label,
      itemIds: cite(index),
      relationIds: [],
    })),
  };
}

/** Seed a stored flow with the given canonical content. */
export function seedFlowView(
  name: string,
  itemIds: string[],
  content: unknown,
): string {
  return withSeedDb((db) => seedView(db, { name, kind: 'flow', itemIds, content }));
}

/**
 * The same seed, into a *named* data directory.
 *
 * T069-C04's subject is that a saved flow survives a process restart, and the
 * restart server answers only for `restartDataDir()`. A row seeded into the shared
 * `.data` would simply not exist on the process being asked about, so the case
 * would fail for a reason that has nothing to do with persistence — the same
 * distinction `gate4.spec.ts` records for its own restart case.
 */
export function seedFlowViewIn(
  dataDir: string,
  name: string,
  itemIds: string[],
  content: unknown,
): string {
  return withSeedDb((db) => seedView(db, { name, kind: 'flow', itemIds, content }), dataDir);
}

/* -------------------------------------------------------------------------- */
/* Rendering / drawing                                                        */
/* -------------------------------------------------------------------------- */

/** A node label this case created, so a label match cannot hit another spec's flow. */
export function uniqueLabel(text: string): string {
  return `${text}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Wait until Mermaid really drew a diagram, and return the drawn `<svg>`.
 *
 * "Drawn" is asserted on real renderer output rather than on the container: the
 * canvas element exists even while a render is pending or failed (it is kept in
 * the DOM and hidden), so a case that waited for the container would assert against
 * an empty canvas.
 */
export async function waitForDrawnSvg(page: Page): Promise<Locator> {
  const svg = page.getByTestId('flow-svg').locator('svg');
  await expect(svg).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('flow-canvas')).toHaveAttribute('data-phase', 'ready');
  await expect(svg.locator('g.node').first()).toBeVisible({ timeout: 30_000 });
  return svg;
}

/** The text Mermaid actually drew, over every node and edge label. */
export async function drawnTexts(page: Page): Promise<string[]> {
  return page
    .getByTestId('flow-svg')
    .evaluate((host) =>
      Array.from(host.querySelectorAll('svg text')).map((node) => node.textContent ?? ''),
    );
}

/**
 * Every DOM id inside the rendered SVG, so "two diagrams do not collide" is exact.
 *
 * Duplicate ids are the failure T065-C03 is about: `url(#…)` references inside one
 * SVG resolve against the *document*, so two diagrams sharing an id can borrow each
 * other's marker or clip path and draw the wrong arrowhead.
 */
export async function svgDomIds(page: Page): Promise<string[]> {
  return page
    .getByTestId('flow-svg')
    .evaluate((host) =>
      Array.from(host.querySelectorAll('svg [id]')).map((node) => node.getAttribute('id') ?? ''),
    );
}

/** Inline scripts, images or handlers that survived into the on-screen picture. */
export async function unsafeMarkupInCanvas(page: Page): Promise<string[]> {
  return page.getByTestId('flow-svg').evaluate((host) =>
    Array.from(host.querySelectorAll('svg *'))
      .flatMap((element) => {
        const problems: string[] = [];
        const tag = element.tagName.toLowerCase();
        if (['script', 'foreignobject', 'iframe', 'object', 'embed', 'img'].includes(tag)) {
          problems.push(`<${tag}>`);
        }
        if (tag === 'a' && element.hasAttribute('href')) problems.push('<a href>');
        for (const attribute of Array.from(element.attributes)) {
          if (attribute.name.toLowerCase().startsWith('on')) {
            problems.push(`${tag}[${attribute.name}]`);
          }
          if (/^\s*(?:javascript|data):/iu.test(attribute.value) && attribute.name !== 'href') {
            problems.push(`${tag}[${attribute.name}=协议]`);
          }
        }
        return problems;
      })
      .filter((entry, index, all) => all.indexOf(entry) === index),
  );
}
