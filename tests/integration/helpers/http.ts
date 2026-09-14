/**
 * HTTP 测试装置：构造带本地令牌的请求并解出统一信封。
 *
 * 直接调用 App Router 的导出函数而不是跑真实 server，省去端口与启动时间，
 * 同时保留守卫、schema 与事务路径 —— 被测试的正是这些。真实浏览器的端到端
 * 路径由 Playwright 用例覆盖。
 */
import { getSessionToken } from '@/server/security/localGuard';
import type { ApiEnvelope } from '@/domain/api';

export const TEST_ORIGIN = 'http://127.0.0.1:3000';
export const TEST_HOST = '127.0.0.1:3000';

/** Headers a same-origin browser tab would send for a mutation. */
export function sessionHeaders(overrides: Record<string, string> = {}): Headers {
  return new Headers({
    host: TEST_HOST,
    origin: TEST_ORIGIN,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    'x-brain-token': getSessionToken(),
    ...overrides,
  });
}

export interface RouteCall {
  method?: string;
  url?: string;
  path?: string;
  body?: unknown;
  /** `null` removes the token (simulates an expired session). */
  token?: string | null;
  contentType?: string;
  headers?: Record<string, string>;
  /** Raw body text, used to exercise malformed JSON. */
  rawBody?: string;
  params?: Record<string, string>;
}

export interface RouteResponse {
  status: number;
  envelope: ApiEnvelope<unknown>;
}

type RouteFunction = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

/**
 * Invoke an App Router handler with a real `Request`.
 *
 * The handler signature accepts `(request, context)`; static routes ignore the
 * second argument, so passing it always keeps a single helper.
 */
export async function callRoute(
  handler: RouteFunction,
  call: RouteCall = {},
): Promise<RouteResponse> {
  const method = call.method ?? 'GET';
  const url = call.url ?? `http://127.0.0.1:3000${call.path ?? '/api/items'}`;

  const headers = new Headers(call.headers ?? {});
  // Host/origin are always set: they are part of the local guard, not a
  // per-test detail. `token: null` deliberately omits only the session token.
  headers.set('host', TEST_HOST);
  headers.set('origin', TEST_ORIGIN);
  headers.set('sec-fetch-site', 'same-origin');
  if (call.token !== null) headers.set('x-brain-token', call.token ?? getSessionToken());
  headers.set('content-type', call.contentType ?? 'application/json');

  const init: RequestInit = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = call.rawBody ?? JSON.stringify(call.body ?? {});
  }

  const request = new Request(url, init);
  const context = { params: Promise.resolve(call.params ?? {}) };

  const response = await (handler as RouteFunction)(request, context);
  const envelope = (await response.json()) as ApiEnvelope<unknown>;
  return { status: response.status, envelope };
}

/**
 * Extract just the params object from a Next.js route context.
 *
 * Next 16 passes `params` as a promise; this keeps dynamic route tests readable.
 */
export async function routeParams(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}
