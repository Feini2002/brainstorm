import { expect, type Page, type Request, type TestInfo } from '@playwright/test';

import { E2E_HOST, E2E_ORIGIN, E2E_PORT } from './env';

/**
 * Shared e2e harness (T024-R05, T024-R06, T026-R05).
 *
 * The rules this file exists to enforce, so no individual spec can quietly
 * weaken them:
 *
 * - **"Offline" is not "no network".** Every case asserts that 127.0.0.1 stays
 *   reachable while *external* traffic is blocked. A test that simply turned the
 *   browser offline would prove nothing about the local-first claim and, worse,
 *   would still pass if the app secretly phoned home.
 *
 * - **Traffic is recorded, not assumed.** `observeTraffic` captures every request
 *   the page makes and offers `externalRequests()`; a separate `wasBlocked`
 *   record keeps blocked attempts visible. A passing "no external call" assertion
 *   is therefore backed by an actual list, not by absence of evidence
 *   (docs/05_tests/00_test_strategy.md 证据分级).
 *
 * - **Real UI drives the data.** Helpers that could reach into the database
 *   instead go through the endpoints the browser uses, so the seed and the app
 *   cannot disagree about the same record.
 */

/** Loopback prefixes that are legitimately part of the app under test. */
const LOCAL_HOSTS = new Set([E2E_HOST, '127.0.0.1', 'localhost', '::1']);

export interface TrafficRecord {
  url: string;
  method: string;
  resourceType: string;
  /** Host of the request, lowercased, or null when the URL was unparseable. */
  host: string | null;
  /** True when the request was aborted because it targeted an external host. */
  blocked: boolean;
}

export interface TrafficObserver {
  records: TrafficRecord[];
  /** Requests to hosts other than the app itself, whether blocked or not. */
  externalRequests: () => TrafficRecord[];
  /** Requests that actually went out and were not served from the local app. */
  blockedRequests: () => TrafficRecord[];
  /** App API calls, in order; useful to prove which endpoints a flow used. */
  apiRequests: () => TrafficRecord[];
  reset: () => void;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isLocalUrl(url: string): boolean {
  const host = hostOf(url);
  if (host === null) return false;
  return LOCAL_HOSTS.has(host);
}

/**
 * Record every request and block any that leaves loopback.
 *
 * Blocking is done with `route.abort` rather than the browser's offline mode
 * (T024-R05): offline mode also breaks 127.0.0.1, which is exactly the thing
 * these cases need to keep working.
 */
export async function observeTraffic(page: Page): Promise<TrafficObserver> {
  const records: TrafficRecord[] = [];

  await page.route('**/*', async (route) => {
    const request: Request = route.request();
    const url = request.url();
    const local = isLocalUrl(url);

    records.push({
      url,
      method: request.method(),
      resourceType: request.resourceType(),
      host: hostOf(url),
      blocked: !local,
    });

    if (local) {
      await route.continue();
      return;
    }
    // External hosts are unreachable in this environment. `abort` produces a
    // real network failure in the page, which is the condition T024-C02/C06 test.
    await route.abort('internetdisconnected');
  });

  return {
    records,
    externalRequests: () => records.filter((entry) => !isLocalUrl(entry.url)),
    blockedRequests: () => records.filter((entry) => entry.blocked),
    apiRequests: () => records.filter((entry) => entry.url.includes('/api/')),
    reset: () => {
      records.length = 0;
    },
  };
}

/**
 * Seed a knowledge record through the real capture endpoint.
 *
 * Returns the created item id so a case can assert on *that* record rather than
 * on "a" record, which is what makes restart and delete checks meaningful.
 */
export async function seedItemViaApi(
  page: Page,
  input: { rawText: string; sourceType?: string; sourceRef?: string | null },
): Promise<string> {
  const response = await page.request.post(`${E2E_ORIGIN}/api/items`, {
    headers: await authHeaders(page),
    data: {
      captureRequestId: crypto.randomUUID(),
      rawText: input.rawText,
      sourceType: input.sourceType ?? 'other',
      sourceRef: input.sourceRef ?? null,
    },
  });
  expect(response.status(), `seedItemViaApi 应返回 201，实际 ${response.status()}`).toBe(201);
  const envelope = (await response.json()) as { ok: boolean; data: { item: { id: string } } };
  return envelope.data.item.id;
}

/**
 * Headers a same-origin browser tab would send.
 *
 * The token is fetched from `/api/session` the same way the app does, so a spec
 * never hard-codes a secret and the guard is genuinely exercised.
 */
export async function authHeaders(page: Page): Promise<Record<string, string>> {
  const session = await page.request.get(`${E2E_ORIGIN}/api/session`, {
    headers: { origin: E2E_ORIGIN, host: `${E2E_HOST}:${E2E_PORT}` },
  });
  expect(session.ok(), 'GET /api/session 必须成功').toBe(true);
  const envelope = (await session.json()) as { ok: boolean; data: { token: string } };
  return {
    origin: E2E_ORIGIN,
    host: `${E2E_HOST}:${E2E_PORT}`,
    'content-type': 'application/json',
    'x-brain-token': envelope.data.token,
  };
}

/** Navigate to a workspace route and wait for the shell rather than a fixed delay. */
export async function openRoute(page: Page, route: string): Promise<void> {
  await page.goto(route);
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
}

/** Collect a screenshot into the Playwright report and return its path. */
export async function captureEvidence(page: Page, testInfo: TestInfo, name: string): Promise<string> {
  const file = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
  return file;
}

/** The six workspace routes, so a "browse all pages" case cannot miss one. */
export const WORKSPACE_ROUTES = [
  '/inbox',
  '/library',
  '/graph',
  '/mindmap',
  '/flow',
  '/settings',
] as const;

/**
 * Create one record through the capture box, exactly as a user would.
 *
 * Returns the text used, which every case then searches for by name. Asserting
 * on *this* text rather than on "a card is visible" is what makes an accumulated
 * shared database safe: cases stay independent without needing a clean DB.
 */
export async function captureViaUi(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('capture-input');
  await input.fill(text);
  await page.getByTestId('capture-save').click();
  // "已保存" is only rendered from the create response (T025-R01).
  await expect(page.getByTestId('save-phase')).toContainText('已保存');
  await expect(input).toHaveValue('');
}

/** Text unique to one run, so parallel-ish accumulation can never collide. */
export function uniqueText(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}
