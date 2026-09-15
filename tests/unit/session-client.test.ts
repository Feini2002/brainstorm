/**
 * T007 验收用例｜本地请求令牌与来源防护（客户端引导与令牌生命周期）
 *
 * 用例规格：docs/05_tests/G0/T007_cases.md。HTTP 侧的证据在
 * `tests/integration/security-http.test.ts`；这里覆盖规格里只能在浏览器侧观察的
 * 部分：引导只发生一次、令牌只存在内存、被拒绝后只重取令牌而不重放付费请求。
 *
 * 直接替换 `globalThis.fetch` 并记录调用序列，因此断言的是真实请求次数与顺序，
 * 而不是「代码看起来没有重试」。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionInfo } from '@/domain/api';

const SESSION: SessionInfo = {
  token: 'tok-process-1',
  sessionId: 'sess-1',
  origin: 'http://127.0.0.1:3000',
};

interface FetchRecord {
  method: string;
  url: string;
  authorization?: string;
  headers: Record<string, string>;
}

let calls: FetchRecord[];
let originalFetch: typeof globalThis.fetch;
/** Storage writes recorded so "the token is not persisted" is a real assertion. */
let storageWrites: string[];

function installFetch(handler: (call: FetchRecord, index: number) => Response): void {
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {});
    const record: FetchRecord = {
      method: init?.method ?? 'GET',
      url: String(url),
      headers: Object.fromEntries(headers.entries()),
    };
    calls.push(record);
    return handler(record, calls.length - 1);
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sessionOk(token = SESSION.token): Response {
  return json({ ok: true, data: { ...SESSION, token }, requestId: 'req-session' });
}

function expired(): Response {
  return json(
    {
      ok: false,
      error: { code: 'SESSION_EXPIRED', message: '本地会话已过期，请刷新页面', retryable: false },
      requestId: 'req-expired',
    },
    403,
  );
}

function failed(code: string, status: number, retryable = true): Response {
  return json(
    { ok: false, error: { code, message: '本地服务没有响应', retryable }, requestId: 'req-fail' },
    status,
  );
}

/** Recording stubs for every browser store the token must stay out of. */
function installStorageSpies(): void {
  storageWrites = [];
  const record = (name: string) => ({
    setItem: (key: string, value: string) => void storageWrites.push(`${name}:${key}=${value}`),
    getItem: () => null,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    value: record('localStorage'),
    configurable: true,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: record('sessionStorage'),
    configurable: true,
  });
  const cookieWrites: string[] = [];
  Object.defineProperty(globalThis, 'document', {
    value: {
      get cookie() {
        return '';
      },
      set cookie(value: string) {
        cookieWrites.push(value);
      },
      createElement: () => ({ click: () => undefined, remove: () => undefined }),
      body: { appendChild: () => undefined },
    },
    configurable: true,
  });
  storageWrites.push(`cookieWrites:${cookieWrites.length}`);
}

beforeEach(async () => {
  calls = [];
  originalFetch = globalThis.fetch;
  installStorageSpies();
  const client = await import('@/features/shared/apiClient');
  client.resetSession();
});

afterEach(async () => {
  const client = await import('@/features/shared/apiClient');
  client.resetSession();
  globalThis.fetch = originalFetch;
});

describe('T007 会话引导与令牌生命周期', () => {
  it('T007-C03 引导流程只请求一次 session，并把令牌用于后续私人请求', async () => {
    installFetch((call) => {
      if (call.url.includes('/api/session')) return sessionOk();
      return json({ ok: true, data: { items: [] }, requestId: 'req-1' });
    });

    const client = await import('@/features/shared/apiClient');
    // 并发调用共享同一个引导 Promise，页面同时打开多个视图也只取一次令牌。
    const [first, second] = await Promise.all([
      client.apiRequest('/api/items'),
      client.apiRequest('/api/items'),
    ]);

    expect(first).toEqual({ items: [] });
    expect(second).toEqual({ items: [] });
    const sessionCalls = calls.filter((call) => call.url.includes('/api/session'));
    expect(sessionCalls).toHaveLength(1);
    expect(sessionCalls[0]?.method).toBe('GET');

    // 私人请求携带令牌，且用的是契约规定的头名。
    const itemCalls = calls.filter((call) => call.url.includes('/api/items'));
    expect(itemCalls).toHaveLength(2);
    for (const call of itemCalls) {
      expect(call.headers['x-brain-token']).toBe(SESSION.token);
    }
  });

  it('T007-R02 令牌只存在内存：不写 localStorage、sessionStorage 或 cookie', async () => {
    installFetch((call) => (call.url.includes('/api/session') ? sessionOk() : json({ ok: true, data: {}, requestId: 'r' })));

    const client = await import('@/features/shared/apiClient');
    await client.apiRequest('/api/items');

    const session = await client.loadSession();
    expect(session.token).toBe(SESSION.token);
    // 令牌存在内存单例里；任何持久化副本都会比签发它的进程活得更久。
    expect(storageWrites.join('|')).not.toContain(SESSION.token);
    expect(storageWrites.join('|')).toBe('cookieWrites:0');
  });

  it('T007-C04 令牌过期后只重取 session，不自动重放已发出的付费请求', async () => {
    installFetch((call, index) => {
      if (call.url.includes('/api/session')) return sessionOk(`tok-${index}`);
      return expired();
    });

    const client = await import('@/features/shared/apiClient');
    let raised: unknown = null;
    try {
      // 用 POST 代表「可能已经付费」的动作：它绝不能被自动重放。
      await client.apiRequest('/api/items', { method: 'POST', body: { rawText: 'x' } });
    } catch (error) {
      raised = error;
    }

    expect((raised as { code?: string }).code).toBe('SESSION_EXPIRED');
    // 恰好两次调用：一次引导、一次失败的动作。没有第三次（自动重试）。
    expect(calls).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);

    // 过期后缓存的令牌被丢弃，下一次调用重新引导（这是允许的恢复路径）……
    installFetch((call, index) => (call.url.includes('/api/session') ? sessionOk(`tok-${index}`) : json({ ok: true, data: {}, requestId: 'r' })));
    calls = [];
    await client.apiRequest('/api/items');
    expect(calls[0]?.url).toContain('/api/session');
    // ……但仍然没有重放刚才那个 POST。
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('T007-C04 引导失败不会被记成答案：下一次调用重新引导', async () => {
    let attempt = 0;
    installFetch((call) => {
      if (call.url.includes('/api/session')) {
        attempt += 1;
        return attempt === 1 ? failed('PROVIDER_NETWORK', 502) : sessionOk();
      }
      return json({ ok: true, data: {}, requestId: 'r' });
    });

    const client = await import('@/features/shared/apiClient');
    let raised: unknown = null;
    try {
      await client.apiRequest('/api/items');
    } catch (error) {
      raised = error;
    }
    expect((raised as { code?: string }).code).toBe('PROVIDER_NETWORK');

    // 失败被缓存会让整个页面永久不可用，所以缓存必须被清掉。
    await client.apiRequest('/api/items');
    expect(attempt).toBe(2);
    expect(calls.filter((call) => call.url.includes('/api/session'))).toHaveLength(2);
  });

  it('T007-C06 引导响应里没有 Key，令牌也不冒充业务数据', async () => {
    installFetch((call) =>
      call.url.includes('/api/session')
        ? sessionOk()
        : json({ ok: true, data: { secretSentinel: 'sk-test-SENTINEL' }, requestId: 'r' }),
    );

    const client = await import('@/features/shared/apiClient');
    const session = await client.loadSession();
    expect(Object.keys(session).sort()).toEqual(['origin', 'sessionId', 'token']);
    // 令牌不是笔记内容，也不含供应商秘密的形状。
    expect(session.token).not.toMatch(/^sk-/u);
  });

  it('T007-R05 引导标记为匿名请求，且不依赖共享缓存', async () => {
    installFetch(() => sessionOk());

    const client = await import('@/features/shared/apiClient');
    await client.loadSession();

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.method).toBe('GET');
    // 引导是唯一允许不带令牌的读取；它必须在任何已有会话之前可达。
    expect(call?.headers['x-brain-token']).toBeUndefined();
  });
});
