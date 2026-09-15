/**
 * T006 验收（浏览器侧）：统一响应与前端请求器。
 *
 * 用例规格：docs/05_tests/G0/T006_cases.md。审计结论是「`src/domain/api.ts` 与
 * `src/features/shared/apiClient.ts` 无任何测试导入；C04 断网、C05 缓存回放没有断言」。
 *
 * `apiClient` 属于浏览器侧代码，但它对响应的处理是纯函数式的：替换
 * `globalThis.fetch` 就能在 node 环境断言「非 JSON 响应」「无效 JSON」「服务端异常」
 * 「断网」这几种失败被映射成哪一种 `ApiClientError`，以及有没有偷偷重发请求。
 * 渲染层的部分（未知完成提示长什么样）与 React 组件耦合，本文件不假装能测，
 * 那部分仍由 e2e 覆盖。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionInfo } from '@/domain/api';

const SESSION: SessionInfo = {
  token: 'tok-envelope-1',
  sessionId: 'sess-envelope',
  origin: 'http://127.0.0.1:3000',
};

interface FetchRecord {
  method: string;
  url: string;
  cache: string | undefined;
  headers: Record<string, string>;
}

let calls: FetchRecord[];
let originalFetch: typeof globalThis.fetch;

function installFetch(handler: (call: FetchRecord, index: number) => Response | Promise<Response>): void {
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {});
    const record: FetchRecord = {
      method: init?.method ?? 'GET',
      url: String(url),
      cache: init?.cache,
      headers: Object.fromEntries(headers.entries()),
    };
    calls.push(record);
    return handler(record, calls.length - 1);
  }) as typeof fetch;
}

/** A fetch that answers the session bootstrap and delegates everything else. */
function installFetchWithSession(
  handler: (call: FetchRecord, index: number) => Response | Promise<Response>,
): void {
  installFetch((call, index) => {
    if (call.url.includes('/api/session')) {
      return json({ ok: true, data: SESSION, requestId: 'req-session' });
    }
    return handler(call, index);
  });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function html(body = '<html><body>502 Bad Gateway</body></html>'): Response {
  return new Response(body, { status: 502, headers: { 'content-type': 'text/html' } });
}

async function client() {
  return import('@/features/shared/apiClient');
}

beforeEach(async () => {
  calls = [];
  originalFetch = globalThis.fetch;
  const { resetSession } = await client();
  resetSession();
});

afterEach(async () => {
  const { resetSession } = await client();
  resetSession();
  globalThis.fetch = originalFetch;
});

describe('T006-C01 非 JSON 响应', () => {
  it('T006-C01 开发代理返回 HTML 错误页时给出可读协议错误，而不是 JSON 解析堆栈', async () => {
    installFetchWithSession(() => html());

    const { apiRequest, ApiClientError } = await client();
    let raised: unknown = null;
    try {
      await apiRequest('/api/items');
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(ApiClientError);
    const error = raised as InstanceType<typeof ApiClientError>;
    expect(error.code).toBe('INTERNAL');
    // 文案要说明「非 JSON」，用户才知道这不是自己的数据坏了。
    expect(error.message).toContain('非 JSON');
    expect(error.message).toContain('502');
    // HTTP 状态被保留，调用方不必再解析一次字符串。
    expect(error.httpStatus).toBe(502);
    // HTML 正文没有被当成业务数据返回。
    expect(error.retryable).toBe(false);
  });

  it('T006-C01 application/json 但正文不是合法 JSON 时也不抛 SyntaxError', async () => {
    installFetchWithSession(
      () =>
        new Response('{ not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const { apiRequest, ApiClientError } = await client();
    const raised = await apiRequest('/api/items').catch((error: unknown) => error);

    expect(raised).toBeInstanceOf(ApiClientError);
    expect((raised as InstanceType<typeof ApiClientError>).code).toBe('INTERNAL');
    expect((raised as InstanceType<typeof ApiClientError>).message).toContain('无效 JSON');
  });

  it('T006-C01 非 JSON 的失败响应仍然被读成安全错误，不是把正文当消息', async () => {
    installFetchWithSession(
      () =>
        new Response('<html>绝对路径 C:\\Users\\someone\\.data\\brain.db 打不开</html>', {
          status: 500,
          headers: { 'content-type': 'text/html', 'x-request-id': 'req-header' },
        }),
    );

    const { apiRequest, ApiClientError } = await client();
    void ApiClientError;
    const raised = (await apiRequest('/api/items').catch((error: unknown) => error)) as InstanceType<
      typeof ApiClientError
    >;

    // 用的是本地映射文案，绝不把对端 HTML 正文当成 message 交给界面。
    expect(raised.message).not.toContain('C:\\Users');
    expect(raised.message).toContain('非 JSON');
    // 无法识别正文时仍要带上 requestId，用户报问题时能对上一条日志。
    expect(raised.requestId).toBe('req-header');
  });
});

describe('T006-C02 字段校验', () => {
  it('T006-C02 400 的信封被解成稳定错误码与逐字段定位', async () => {
    installFetchWithSession(() =>
      json(
        {
          ok: false,
          error: {
            code: 'VALIDATION',
            message: '输入不合法',
            retryable: false,
            fieldErrors: { title: ['标题不能超过 100 个字符'] },
          },
          requestId: 'req-validation',
        },
        400,
      ),
    );

    const { apiRequest, ApiClientError } = await client();
    void ApiClientError;
    const raised = (await apiRequest('/api/items/x', { method: 'PATCH', body: {} }).catch(
      (error: unknown) => error,
    )) as InstanceType<typeof ApiClientError>;

    // 每页各自解析字符串错误会脆弱，所以这里断言结构化字段真的被保留下来。
    expect(raised.code).toBe('VALIDATION');
    expect(raised.fieldErrors).toEqual({ title: ['标题不能超过 100 个字符'] });
    expect(raised.httpStatus).toBe(400);
    expect(raised.requestId).toBe('req-validation');
  });
});

describe('T006-C03 服务器异常', () => {
  it('T006-C03 服务端内部错误只回安全文案，堆栈与路径都不进入浏览器', async () => {
    installFetchWithSession(() =>
      json(
        {
          ok: false,
          error: { code: 'INTERNAL', message: '本地服务出现未预期错误', retryable: false },
          requestId: 'req-internal',
        },
        500,
      ),
    );

    const { apiRequest, ApiClientError } = await client();
    void ApiClientError;
    const raised = (await apiRequest('/api/items').catch((error: unknown) => error)) as InstanceType<
      typeof ApiClientError
    >;

    expect(raised.code).toBe('INTERNAL');
    expect(raised.message).not.toMatch(/\.ts:\d+|at \w+ \(/u);
    expect(raised.message).not.toContain('C:');
    // 503/500 这类内部错误不可自动重试。
    expect(raised.retryable).toBe(false);
  });
});

describe('T006-C04 网络断开', () => {
  it('T006-C04 fetch 抛错时映射成可读的网络错误，且绝不自动重发', async () => {
    installFetchWithSession(() => {
      throw new TypeError('Failed to fetch');
    });

    const { apiRequest, ApiClientError } = await client();
    const raised = (await apiRequest('/api/items', {
      method: 'POST',
      body: { captureRequestId: 'fixed-key', rawText: 'x', sourceType: 'other', sourceRef: null },
    }).catch((error: unknown) => error)) as InstanceType<typeof ApiClientError>;

    expect(raised).toBeInstanceOf(ApiClientError);
    expect(raised.code).toBe('PROVIDER_NETWORK');
    expect(raised.message).toContain('本地服务没有响应');
    // retryable 是「可以用同一个幂等键重试」的信号，不是「已经重试过」。
    expect(raised.retryable).toBe(true);

    // 一次引导 + 一次业务请求，没有第三次：自动重试会造成重复保存或双重费用。
    const business = calls.filter((call) => call.url.includes('/api/items'));
    expect(business).toHaveLength(1);
    expect(business[0]?.method).toBe('POST');
  });

  it('T006-C04 响应在读到一半断开时同样不重发，也不把半截内容当成功', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":true,"data":'));
        controller.error(new TypeError('terminated'));
      },
    });
    installFetchWithSession(
      () => new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const { apiRequest, ApiClientError } = await client();
    const raised = await apiRequest('/api/items').catch((error: unknown) => error);

    expect(raised).toBeInstanceOf(ApiClientError);
    expect(calls.filter((call) => call.url.includes('/api/items'))).toHaveLength(1);
  });

  it('T006-C04 AbortError 原样抛出，不被伪装成网络故障', async () => {
    installFetchWithSession(() => {
      throw new DOMException('aborted', 'AbortError');
    });

    const { apiRequest } = await client();
    const raised = await apiRequest('/api/items').catch((error: unknown) => error);

    // 用户主动取消导航不是「本地服务没响应」，把它降级成网络错误会误导用户去重启应用。
    expect((raised as Error).name).toBe('AbortError');
  });
});

describe('T006-C05 缓存回放', () => {
  it('T006-C05 每次请求都带 cache: no-store，界面不会读到旧 revision', async () => {
    installFetchWithSession(() => json({ ok: true, data: { items: [] }, requestId: 'r' }));

    const { apiRequest } = await client();
    await apiRequest('/api/items');
    await apiRequest('/api/items/x');

    const business = calls.filter((call) => call.url.includes('/api/items'));
    expect(business).toHaveLength(2);
    for (const call of business) {
      expect(call.cache).toBe('no-store');
    }
  });

  it('T006-C05 同一路径的第二次读取返回新数据，不被上一次响应粘住', async () => {
    let revision = 1;
    installFetchWithSession(() =>
      json({ ok: true, data: { revision }, requestId: 'r' }),
    );

    const { apiRequest } = await client();
    const before = await apiRequest<{ revision: number }>('/api/items/x');
    revision = 2;
    const after = await apiRequest<{ revision: number }>('/api/items/x');

    expect(before.revision).toBe(1);
    expect(after.revision).toBe(2);
    expect(calls.filter((call) => call.url.includes('/api/items/x'))).toHaveLength(2);
  });

  it('T006-C05 下载同样不使用共享缓存，失败时判成错误而不是存成文件', async () => {
    installFetchWithSession(() =>
      json({ ok: false, error: { code: 'NOT_FOUND', message: '视图不存在', retryable: false }, requestId: 'r' }, 404),
    );

    const { apiDownload, ApiClientError } = await client();
    const raised = (await apiDownload('/api/views/x/export').catch(
      (error: unknown) => error,
    )) as InstanceType<typeof ApiClientError>;

    expect(raised).toBeInstanceOf(ApiClientError);
    expect(raised.code).toBe('NOT_FOUND');
    const download = calls.find((call) => call.url.includes('/export'));
    expect(download?.cache).toBe('no-store');
  });
});

describe('T006-C06 统一契约', () => {
  it('T006-C06 成功与失败共用同一解析器：ok 判别决定返回值还是抛错', async () => {
    installFetchWithSession((call) =>
      call.url.includes('/api/two')
        ? json(
            {
              ok: false,
              error: { code: 'NOT_FOUND', message: '没有这条记录', retryable: false },
              requestId: 'r2',
            },
            404,
          )
        : json({ ok: true, data: { a: 1 }, requestId: 'r1' }),
    );

    const { apiRequest, ApiClientError } = await client();
    const ok = await apiRequest<{ a: number }>('/api/one');
    expect(ok).toEqual({ a: 1 });

    const failed = await apiRequest('/api/two').catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ApiClientError);
    expect((failed as InstanceType<typeof ApiClientError>).code).toBe('NOT_FOUND');
  });

  it('T006-C06 ok 缺失或形状不对时被判成协议错误，不当作成功也不抛裸 TypeError', async () => {
    installFetchWithSession(() => json({ data: { items: [] } }));

    const { apiRequest, ApiClientError } = await client();
    const raised = await apiRequest('/api/items').catch((error: unknown) => error);

    expect(raised).toBeInstanceOf(ApiClientError);
    expect((raised as InstanceType<typeof ApiClientError>).message).toContain('无法识别的响应');
  });

  it('T006-C06 ok:false 但缺 error 对象时同样是可读的协议错误', async () => {
    installFetchWithSession(() => json({ ok: false, error: '服务坏了', requestId: 'r' }, 500));

    const { apiRequest, ApiClientError } = await client();
    const raised = (await apiRequest('/api/items').catch((error: unknown) => error)) as InstanceType<
      typeof ApiClientError
    >;

    expect(raised).toBeInstanceOf(ApiClientError);
    expect(raised.code).toBe('INTERNAL');
    expect(raised.message).toContain('无法识别的响应');
  });

  it('T006-C06 requestId 随失败一起暴露，成功则直接返回 data', async () => {
    installFetchWithSession(() =>
      json({ ok: true, data: { items: [], nextCursor: null, totalMatched: 0 }, requestId: 'req-ok' }),
    );

    const { apiRequest } = await client();
    const data = await apiRequest<{ totalMatched: number }>('/api/items');
    // 成功路径不把信封再包一层：调用方拿到的就是 data。
    expect(data).toEqual({ items: [], nextCursor: null, totalMatched: 0 });
    expect(data).not.toHaveProperty('ok');
  });
});

describe('T006 查询参数序列化', () => {
  it('T006-R03 数组值序列化为重复参数，undefined 被省略', async () => {
    installFetchWithSession(() => json({ ok: true, data: {}, requestId: 'r' }));

    const { apiRequest } = await client();
    await apiRequest('/api/selection', {
      query: { itemId: ['a', 'b'], filterTagId: undefined, limit: 3 },
    });

    const call = calls.find((entry) => entry.url.includes('/api/selection'));
    expect(call?.url).toContain('itemId=a&itemId=b');
    expect(call?.url).toContain('limit=3');
    expect(call?.url).not.toContain('filterTagId');
  });
});
