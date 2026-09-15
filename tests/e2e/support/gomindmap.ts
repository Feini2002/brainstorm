import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, type Page } from '@playwright/test';

import type { LlmConfig, PublicLlmSettings } from '@/domain/knowledge';

import { E2E_ORIGIN, E2E_SCRIPTED_DIR } from './env';
import { authHeaders, uniqueText } from './harness';
import { withSeedDb } from './seedData';

/**
 * Shared helpers for the G4 mindmap closed-loop acceptance (T061).
 *
 * They live here rather than in `gate4.spec.ts` because three of them are the
 * only way a browser-driven case can reach the *production* generation path
 * without a live provider, and each one is a substitution that has to be stated
 * once rather than re-invented per case:
 *
 *  - **The model answer is a file, not a fake route.** `scriptedGeneration` writes
 *    one script and posts to the real `/api/views/mindmap/generate`: the guard,
 *    the schema, the parse, the transaction and the insert all run for real, and
 *    only the outbound HTTP step is replayed (see `src/server/llm/transport.ts`).
 *    A test-only endpoint that returned a fixed tree is what T011-C03 forbids.
 *
 *  - **The connection settings are written the way the product writes them.**
 *    Generation refuses to start without a configured model, so a case that
 *    bypassed the settings route (by seeding a `settings` row) would be proving
 *    that a hand-written config works, not that the product's own save path does.
 *
 *  - **Items are created through the capture endpoint.** Every id a case then
 *    asserts about is a row the real route really inserted, which is what makes
 *    the "each leaf resolves to a real record" loop meaningful.
 *
 * **One suite-level obligation comes with the settings write**: the acceptance
 * suite's shared database is not reset between spec files, and several later
 * specs (`offline-crud`, `save-races`, `mindmap-regeneration`) assert the
 * *unconfigured* behaviour — "没有配置模型时仍然可用". A stored ApiKey would make
 * those cases exercise a different branch. `restoreLlmSettings()` therefore puts
 * the connection back to the suite's starting state and `gate4.spec.ts` calls it
 * from `test.afterAll`; leaving it out would be a real regression, not a
 * cosmetic one.
 */

/** The stand-in credential. It never leaves loopback and never reaches a provider. */
const SCRIPTED_API_KEY = 'sk-e2e-scripted-0000';
/** A syntactically valid HTTPS endpoint on a host that cannot exist. */
const SCRIPTED_BASE_URL = 'https://scripted.invalid/v1';
const SCRIPTED_MODEL = 'e2e-scripted';

/** The suite's own starting state, restored after the file finishes. */
const DEFAULT_CONFIG: LlmConfig = {
  adapter: 'openai-compatible',
  baseUrl: '',
  model: '',
  structuredMode: 'prompt_json',
  tokenField: 'none',
  maxOutputTokens: 4096,
  schemaRepairEnabled: false,
};

function scriptedConfig(input: { baseUrl: string; schemaRepairEnabled: boolean }): LlmConfig {
  return {
    adapter: 'openai-compatible',
    baseUrl: input.baseUrl,
    model: SCRIPTED_MODEL,
    structuredMode: 'prompt_json',
    tokenField: 'none',
    maxOutputTokens: 4096,
    schemaRepairEnabled: input.schemaRepairEnabled,
  };
}

interface SettingsReply {
  ok: boolean;
  data: PublicLlmSettings;
  error?: { code: string; message: string };
}

/**
 * Headers a same-origin browser tab would send, for an arbitrary origin.
 *
 * `harness.authHeaders` hard-codes the suite's port, and T061-C02 has to talk to
 * the restart server on its own port — where the session token is a *different*
 * secret, because it is minted per process. Fetching it here (each call, not once)
 * is what makes "the new process answers" an observable fact rather than an
 * assumption.
 */
export async function headersAt(origin: string): Promise<Record<string, string>> {
  const host = new URL(origin).host;
  const response = await fetch(`${origin}/api/session`, { headers: { host, origin } });
  expect(response.ok, `GET ${origin}/api/session 必须成功`).toBe(true);
  const envelope = (await response.json()) as { ok: boolean; data: { token: string } };
  return {
    origin,
    host,
    'content-type': 'application/json',
    'x-brain-token': envelope.data.token,
  };
}

/** Read the connection settings through the real read route. */
async function readLlmSettings(headers: Record<string, string>): Promise<PublicLlmSettings> {
  const response = await fetch(`${E2E_ORIGIN}/api/settings/llm`, { headers });
  // `status` is a property on the platform `Response`, not a method: this is the
  // global fetch in the test process, not Playwright's `APIResponse`.
  expect(response.status, 'GET /api/settings/llm 应返回 200').toBe(200);
  const envelope = (await response.json()) as SettingsReply;
  return envelope.data;
}

/** Write the connection settings through the real mutation route. */
async function writeLlmSettings(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<PublicLlmSettings> {
  const response = await fetch(`${E2E_ORIGIN}/api/settings/llm`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });
  expect(response.status, `PUT /api/settings/llm 应返回 200，实际 ${response.status}`).toBe(200);
  const envelope = (await response.json()) as SettingsReply;
  return envelope.data;
}

/** True once this worker has configured the connection, so the write happens once. */
let connectionConfigured = false;
/** Last `schemaRepairEnabled` written, so repeated cases do not rewrite it. */
let schemaRepairEnabled = true;

/**
 * Ensure a model connection exists, using the two-step write the schema requires.
 *
 * `saveLlmSettingsSchema` is a discriminated union on `keyAction`: a `replace`
 * carries the key, and a `keep` may not. The destination is therefore set by a
 * second call, which is also the only order that keeps the key-transfer rule
 * honest — moving an existing key to a new origin needs an explicit confirmation,
 * and starting from an empty Base URL keeps that rule out of the way instead of
 * silently exercising it.
 *
 * The empty Base URL in the first call is deliberate and safe: `resolveEndpoint`
 * is only consulted when a request is actually sent (`configSnapshot` at
 * registration, and the adapter at send time), and both calls below are followed
 * by a second write that supplies the real address.
 */
async function ensureLlmConfigured(headers: Record<string, string>): Promise<void> {
  if (connectionConfigured) return;

  const current = await readLlmSettings(headers);
  if (
    current.apiKeyConfigured &&
    current.config.baseUrl.trim().length > 0 &&
    current.config.model.trim().length > 0
  ) {
    connectionConfigured = true;
    schemaRepairEnabled = current.config.schemaRepairEnabled;
    return;
  }

  const withKey = await writeLlmSettings(headers, {
    keyAction: 'replace',
    apiKey: SCRIPTED_API_KEY,
    expectedRevision: current.revision,
    config: scriptedConfig({ baseUrl: '', schemaRepairEnabled: true }),
  });

  await writeLlmSettings(headers, {
    keyAction: 'keep',
    expectedRevision: withKey.revision,
    config: scriptedConfig({ baseUrl: SCRIPTED_BASE_URL, schemaRepairEnabled: true }),
  });

  connectionConfigured = true;
  schemaRepairEnabled = true;
}

/** Turn the one repair attempt off, so a malformed answer costs exactly one call. */
async function setSchemaRepairEnabled(
  headers: Record<string, string>,
  enabled: boolean,
): Promise<void> {
  if (schemaRepairEnabled === enabled) return;
  const current = await readLlmSettings(headers);
  await writeLlmSettings(headers, {
    keyAction: 'keep',
    expectedRevision: current.revision,
    config: { ...current.config, schemaRepairEnabled: enabled },
  });
  schemaRepairEnabled = enabled;
}

/**
 * Put the connection back to the suite's starting state.
 *
 * Called from `gate4.spec.ts`'s `test.afterAll`. Without it the stored ApiKey
 * survives into the specs that assert the offline path, and "点击保存并整理会解释
 * 缺少模型配置" would have to run a real (paid-shaped) generation instead.
 */
export async function restoreLlmSettings(): Promise<void> {
  const headers = await headersAt(E2E_ORIGIN);
  const current = await readLlmSettings(headers);
  if (!current.apiKeyConfigured && current.config.baseUrl.trim().length === 0) return;
  await writeLlmSettings(headers, {
    keyAction: 'delete',
    expectedRevision: current.revision,
    config: { ...DEFAULT_CONFIG },
  });
  connectionConfigured = false;
  schemaRepairEnabled = false;
}

/** Sequence number, so two scripts written in one millisecond still order. */
let scriptSequence = 0;

/**
 * Write one uniquely named script for the next provider call.
 *
 * Uniqueness is not cosmetic. The transport replays `replies` in order and resets
 * its index when the file's *content* changes, and the suite's server is one
 * process serving every case — so a file that reused both its name and its content
 * would continue the previous case's reply sequence. The `token` field below makes
 * two scripts with the same answer still differ as content, and the timestamp plus
 * sequence keeps the name ordering the directory's "newest" rule relies on.
 */
function writeScript(content: string): string {
  mkdirSync(E2E_SCRIPTED_DIR, { recursive: true });
  scriptSequence += 1;
  const name = `script-${Date.now()}-${String(scriptSequence).padStart(4, '0')}-${randomUUID().slice(0, 8)}.json`;
  const file = path.join(E2E_SCRIPTED_DIR, name);
  writeFileSync(
    file,
    JSON.stringify({ token: name, replies: [{ content }] }, null, 2),
    'utf8',
  );
  return file;
}

export interface CaptureResult {
  id: string;
  /** The full raw text that was stored, so a case can assert on *this* record. */
  text: string;
}

/** Create one record through the real capture endpoint (T061-C01「材料」). */
export async function captureNote(page: Page, prefix: string): Promise<CaptureResult> {
  const text = uniqueText(prefix);
  const response = await page.request.post(`${E2E_ORIGIN}/api/items`, {
    headers: await authHeaders(page),
    data: {
      captureRequestId: randomUUID(),
      rawText: text,
      sourceType: 'other',
      sourceRef: null,
    },
  });
  expect(response.status(), `POST /api/items 应返回 201，实际 ${response.status()}`).toBe(201);
  const envelope = (await response.json()) as { ok: boolean; data: { item: { id: string } } };
  return { id: envelope.data.item.id, text };
}

/** The same capture, against an arbitrary origin (T061-C02's own process). */
export async function seedItemAt(
  page: Page,
  origin: string,
  headers: Record<string, string>,
  rawText: string,
): Promise<string> {
  const response = await page.request.post(`${origin}/api/items`, {
    headers,
    data: {
      captureRequestId: randomUUID(),
      rawText,
      sourceType: 'other',
      sourceRef: null,
    },
  });
  expect(response.status(), `POST ${origin}/api/items 应返回 201`).toBe(201);
  const envelope = (await response.json()) as { ok: boolean; data: { item: { id: string } } };
  return envelope.data.item.id;
}

export interface ScriptedGenerationOptions {
  /** Exactly the records the request selects; the server re-reads them itself. */
  itemIds: string[];
  /** The model answer, verbatim. */
  body: string;
  /** `false` disables the one repair attempt (T061-C03). */
  schemaRepairEnabled?: boolean;
}

export interface GenerationOutcome {
  status: number;
  success: boolean;
  runId: string;
  viewId: string | null;
  state: string;
  warnings: string[];
  errorCode: string | null;
}

/**
 * The run registered by one request key.
 *
 * A rejected answer returns the contract's failure envelope, which by contract
 * carries `{code,message}` and **no** run id — but the run row exists and is the
 * authority on what happened (docs/03_contracts/02, Run 状态). Reading it back
 * from the suite's own database is what lets a case assert on the run that
 * actually failed instead of inferring a failure from a status code.
 */
function findRunByRequestKey(requestKey: string): { id: string; state: string } | null {
  return withSeedDb((db) => {
    const row = db
      .prepare('SELECT id, state FROM ai_runs WHERE request_key = ?')
      .get(requestKey) as { id: string; state: string } | undefined;
    return row ?? null;
  });
}

/**
 * Run one real generation whose model answer is a fixed script.
 *
 * Nothing about the request is special: the selection is re-read from the
 * database, the answer travels the real adapter and parser, and the outcome is
 * reported exactly as the route reports it — including the failures, which are
 * *not* smoothed into an empty success.
 */
export async function scriptedGeneration(
  page: Page,
  headers: Record<string, string>,
  options: ScriptedGenerationOptions,
): Promise<GenerationOutcome> {
  await ensureLlmConfigured(headers);
  if (options.schemaRepairEnabled === false) await setSchemaRepairEnabled(headers, false);
  else await setSchemaRepairEnabled(headers, true);

  writeScript(options.body);

  const requestKey = randomUUID();
  const response = await page.request.post(`${E2E_ORIGIN}/api/views/mindmap/generate`, {
    headers,
    data: {
      requestKey,
      selection: { mode: 'explicit', itemIds: options.itemIds },
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
    };
  }

  const run = findRunByRequestKey(requestKey);
  if (run === null) {
    // A refusal that never became a run (no configuration, empty selection, busy
    // slot) is not what any case here expects; say so instead of reporting an
    // empty run id that would fail later as a confusing 404.
    throw new Error(
      `生成请求以 ${envelope.error?.code ?? status} 失败，但库中没有对应的运行记录：${envelope.error?.message ?? ''}`,
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
  };
}

/**
 * Zoom the rendered map with a real wheel gesture.
 *
 * d3-zoom scales on a wheel only while the modifier is held, so the Control key is
 * what makes this a zoom rather than a pan — the same mechanism a trackpad pinch
 * produces. The scale only ever moves through `handleZoom`, so an increase here is
 * evidence that the renderer is still interactive after a restart.
 */
export async function zoomWheel(page: Page, steps = 6): Promise<void> {
  const canvas = page.getByTestId('mindmap-svg');
  const box = await canvas.boundingBox();
  expect(box, '脑图画布应有可缩放区域').toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.keyboard.down('Control');
  for (let index = 0; index < steps; index += 1) {
    await page.mouse.wheel(0, -120);
  }
  await page.keyboard.up('Control');
  await page.waitForTimeout(300);
}

/** The ids of every saved view of one kind, sorted, so "nothing was added" is exact. */
export async function listViewIds(
  page: Page,
  headers: Record<string, string>,
  kind: 'graph' | 'mindmap' | 'flow',
): Promise<string[]> {
  const response = await page.request.get(`${E2E_ORIGIN}/api/views`, {
    headers,
    params: { kind, limit: 100 },
  });
  expect(response.status(), 'GET /api/views 应返回 200').toBe(200);
  const envelope = (await response.json()) as { ok: boolean; data: { views: { id: string }[] } };
  return envelope.data.views.map((view) => view.id).sort();
}

export interface RunRead {
  id: string;
  state: string;
  error: { code: string; message: string } | null;
}

/** Read one run's stored outcome (T040's read-only status route). */
export async function readRun(
  page: Page,
  headers: Record<string, string>,
  runId: string,
): Promise<RunRead> {
  const response = await page.request.get(`${E2E_ORIGIN}/api/runs/${runId}`, { headers });
  expect(response.status(), `GET /api/runs/${runId} 应返回 200`).toBe(200);
  const envelope = (await response.json()) as { ok: boolean; data: RunRead };
  return envelope.data;
}

export interface ExportFile {
  status: number;
  body: string;
  contentType: string;
  disposition: string | null;
}

/** Download one export exactly as the app does, returning the raw response. */
export async function fetchExport(
  page: Page,
  headers: Record<string, string>,
  viewId: string,
  format: 'markdown' | 'json',
): Promise<ExportFile> {
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
