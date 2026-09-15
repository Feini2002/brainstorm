/**
 * T007 验收用例｜本地请求令牌与来源防护（HTTP 层）
 *
 * 用例规格：docs/05_tests/G0/T007_cases.md。这里不重新实现守卫规则，而是把
 * 规格里的「必须断言 / 必须排除」变成对**真实路由处理函数**的直接断言：被拒绝的
 * 请求既不能写入数据库，也不能把令牌、秘密或内部路径带回响应。
 *
 * 直接调用 App Router 导出的处理函数（见 helpers/http.ts）而不是启动真实 server，
 * 因为被测试的正是守卫、schema 与事务这三段代码路径；真实浏览器路径由 e2e 覆盖，
 * 本文件不做 e2e 结论。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LIMITS } from '@/domain/limits';
import { getDb } from '@/server/db/database';
import { setLogSink } from '@/server/observability/redaction';
import { APP_ORIGIN, APP_HOST, expectedHost, getSessionToken } from '@/server/security/localGuard';
import type { SessionInfo } from '@/domain/api';
import { createTestDatabase, newId, openTestDatabase, type TestDatabase } from '../helpers/db';
import { TEST_HOST, TEST_ORIGIN, callRoute } from './helpers/http';

let harness: TestDatabase;

beforeEach(() => {
  harness = createTestDatabase();
  openTestDatabase(harness.databasePath);
});

afterEach(() => {
  harness.cleanup();
});

function countItems(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM knowledge_items').get() as { n: number };
  return row.n;
}

function captureBody(): Record<string, unknown> {
  return {
    captureRequestId: newId(),
    rawText: 'T007 探针内容',
    sourceType: 'other',
    sourceRef: null,
  };
}

/** Invoke a handler with hand-built headers, bypassing `callRoute`'s fixed ones. */
function rawCall(
  handler: unknown,
  path: string,
  init: { method?: string; headers: Record<string, string>; body?: string },
): Promise<Response> {
  return (handler as (request: Request) => Promise<Response>)(
    new Request(`http://127.0.0.1:3000${path}`, {
      method: init.method ?? 'GET',
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    }),
  );
}

function failureCode(envelope: unknown): string | undefined {
  return (envelope as { ok: false; error: { code: string } }).error?.code;
}

describe('T007 本地请求令牌与来源防护', () => {
  it('T007-C01 跨站写入被 403 拒绝，且数据库没有新增记录', async () => {
    const { POST } = await import('@/app/api/items/route');
    const before = countItems();

    const response = await rawCall(POST, '/api/items', {
      method: 'POST',
      // 合法令牌也救不了跨站来源：来源与令牌是两道独立的检查。
      headers: {
        host: TEST_HOST,
        origin: 'https://evil.test',
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
        [LIMITS.tokenRequestHeader]: getSessionToken(),
      },
      body: JSON.stringify(captureBody()),
    });

    const envelope = (await response.json()) as unknown;
    expect(response.status).toBe(403);
    expect(failureCode(envelope)).toBe('LOCAL_ORIGIN_REJECTED');
    // 「必须排除：恶意页面可以改资料」——被拒绝的请求不能留下任何写入。
    expect(countItems()).toBe(before);
  });

  it('T007-C01 跨站请求在整理接口上同样被拒绝，且不产生 Run', async () => {
    const { POST: capture } = await import('@/app/api/items/route');
    const created = await callRoute(capture, { method: 'POST', body: captureBody() });
    const itemId = (created.envelope as { data: { item: { id: string } } }).data.item.id;

    const { POST: organize } = await import('@/app/api/items/[id]/organize/route');
    const response = await rawCall(organize, `/api/items/${itemId}/organize`, {
      method: 'POST',
      headers: {
        host: TEST_HOST,
        origin: 'https://evil.test',
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
        [LIMITS.tokenRequestHeader]: getSessionToken(),
      },
      body: JSON.stringify({ requestKey: newId(), expectedRevision: 1 }),
    });

    expect(response.status).toBe(403);
    // 「必须排除：恶意页面可能利用本地服务器代付费」——拒绝的请求不能建 Run 行。
    const runs = getDb().prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
    expect(runs.n).toBe(0);
  });

  it('T007-C02 Host 伪装被拒绝，而不是按 IP 连得上就放行', async () => {
    const { GET } = await import('@/app/api/session/route');

    const response = await rawCall(GET, '/api/session', {
      headers: {
        // 回环地址配错域名：DNS 重绑定会绕过「只检查网络地址」的想法。
        host: 'rebound.attacker.test',
        origin: 'http://rebound.attacker.test',
        'sec-fetch-site': 'same-origin',
      },
    });

    const envelope = (await response.json()) as unknown;
    expect(response.status).toBe(403);
    expect(failureCode(envelope)).toBe('LOCAL_ORIGIN_REJECTED');
    expect(JSON.stringify(envelope)).not.toContain(getSessionToken());
  });

  it('T007-C02 X-Forwarded-Host 不参与判定：伪造它既不放行也不误拒', async () => {
    const { GET } = await import('@/app/api/items/route');
    const token = getSessionToken();

    // 真实 Host 合法 + 伪造的 X-Forwarded-Host：必须按真实 Host 放行，
    // 证明判据是配置的回环地址而不是任意转发头（代理部署不在范围）。
    const accepted = await rawCall(GET, '/api/items', {
      headers: {
        host: TEST_HOST,
        'x-forwarded-host': 'attacker.test',
        origin: TEST_ORIGIN,
        'sec-fetch-site': 'same-origin',
        [LIMITS.tokenRequestHeader]: token,
      },
    });
    expect(accepted.status).toBe(200);

    // 真实 Host 非法 + 伪造 `X-Forwarded-Host` 指向合法值：仍然必须拒绝。
    const rejected = await rawCall(GET, '/api/items', {
      headers: {
        host: 'attacker.test',
        'x-forwarded-host': TEST_HOST,
        origin: TEST_ORIGIN,
        'sec-fetch-site': 'same-origin',
        [LIMITS.tokenRequestHeader]: token,
      },
    });
    expect(rejected.status).toBe(403);
  });

  it('T007-C03 缺失令牌的私人 GET 返回受控拒绝，且读取不触发写入', async () => {
    const { GET } = await import('@/app/api/items/route');
    const before = getDb()
      .prepare("SELECT value FROM app_meta WHERE key = 'dataset_revision'")
      .get() as { value: string };

    const response = await callRoute(GET, { method: 'GET', token: null });

    expect(response.status).toBe(403);
    // 「必须排除：私人读取不应比写入更容易旁路」——读取同样要令牌。
    expect(failureCode(response.envelope)).toBe('SESSION_EXPIRED');
    const after = getDb()
      .prepare("SELECT value FROM app_meta WHERE key = 'dataset_revision'")
      .get() as { value: string };
    expect(after.value).toBe(before.value);
  });

  it('T007-C03 引导流程本身可匿名读取，且返回的令牌可解锁私人 GET', async () => {
    const session = await import('@/app/api/session/route');
    const bootstrap = await callRoute(session.GET, { method: 'GET', path: '/api/session' });

    // 引导是一次「受控拒绝之后」的可恢复路径，而不是碰巧某条路由没加守卫。
    expect(bootstrap.status).toBe(200);
    const info = (bootstrap.envelope as { ok: true; data: SessionInfo }).data;
    expect(info.token).toBe(getSessionToken());

    const { GET } = await import('@/app/api/items/route');
    const unlocked = await callRoute(GET, { method: 'GET', token: info.token });
    expect(unlocked.status).toBe(200);
  });

  it('T007-C04 令牌不匹配时按 SESSION_EXPIRED 拒绝，且不回放写入', async () => {
    const { POST } = await import('@/app/api/items/route');
    const before = countItems();

    const response = await callRoute(POST, {
      method: 'POST',
      token: 'stale-token-from-a-previous-process',
      body: captureBody(),
    });

    expect(response.status).toBe(403);
    // 重启后旧进程令牌必须被拒绝；客户端重新引导，但不自动重放这次付费动作。
    expect(failureCode(response.envelope)).toBe('SESSION_EXPIRED');
    expect(countItems()).toBe(before);
  });

  it('T007-C05 来源端口不一致时明确拒绝并提示配置不一致', async () => {
    const { POST } = await import('@/app/api/items/route');
    const before = countItems();

    const response = await rawCall(POST, '/api/items', {
      method: 'POST',
      headers: {
        // APP_ORIGIN 是 3000，请求自称来自 3001。
        host: '127.0.0.1:3001',
        origin: 'http://127.0.0.1:3001',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        [LIMITS.tokenRequestHeader]: getSessionToken(),
      },
      body: JSON.stringify(captureBody()),
    });

    const envelope = (await response.json()) as { ok: false; error: { code: string; message: string } };
    expect(response.status).toBe(403);
    expect(envelope.error.code).toBe('LOCAL_ORIGIN_REJECTED');
    // 「必须排除：端口误配置不能靠放宽全部 Origin 解决」——必须点出是地址不匹配。
    expect(envelope.error.message).toMatch(/回环地址|受信来源/u);
    expect(countItems()).toBe(before);
  });

  it('T007-C05 配置的回环地址与端口是唯一判据', async () => {
    // 守卫的判据来自 APP_ORIGIN，不是硬编码字符串：这里确认两者一致，
    // 这样「换端口要同时改 APP_PORT 与 APP_ORIGIN」的契约才有落点。
    expect(expectedHost()).toBe(new URL(APP_ORIGIN).host);
    expect(new URL(APP_ORIGIN).hostname).toBe(APP_HOST);
    expect(new URL(APP_ORIGIN).hostname).toBe('127.0.0.1');
  });

  it('T007-C06 session 响应只含随机令牌，没有 Key 或笔记内容', async () => {
    const session = await import('@/app/api/session/route');
    const response = await callRoute(session.GET, { method: 'GET', path: '/api/session' });

    expect(response.status).toBe(200);
    const data = (response.envelope as { ok: true; data: Record<string, unknown> }).data;
    // 「必须排除：本地保护令牌不应成为读取秘密的快捷入口」——字段是封闭集合。
    expect(Object.keys(data).sort()).toEqual(['origin', 'sessionId', 'token']);

    const serialized = JSON.stringify(response.envelope);
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('sk-');
    // 令牌本身是随机字节的 base64url，不是可猜测的序号或时间戳。
    expect(data.token).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    expect(String(data.token)).not.toBe(String(data.sessionId));
  });

  it('T007-C06 session 不开放 CORS，被拒绝时也不回显秘密', async () => {
    const session = await import('@/app/api/session/route');

    const ok = await rawCall(session.GET, '/api/session', {
      headers: { host: TEST_HOST, origin: TEST_ORIGIN, 'sec-fetch-site': 'same-origin' },
    });
    expect(ok.headers.get('access-control-allow-origin')).toBeNull();
    expect(ok.headers.get('cache-control')).toBe('no-store');

    const rejected = await rawCall(session.GET, '/api/session', {
      headers: { host: 'attacker.test', origin: 'https://evil.test' },
    });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('T007-C06 令牌不出现在任何日志行里', async () => {
    const lines: string[] = [];
    setLogSink((_record, line) => lines.push(line));
    try {
      const { POST } = await import('@/app/api/items/route');
      // 造一次被拒绝的请求，强制走一遍失败日志路径。
      await rawCall(POST, '/api/items', {
        method: 'POST',
        headers: {
          host: TEST_HOST,
          origin: 'https://evil.test',
          'sec-fetch-site': 'cross-site',
          'content-type': 'application/json',
        },
        body: JSON.stringify(captureBody()),
      });
      // 再造一次成功请求，确认成功路径也不记令牌。
      await callRoute(POST, { method: 'POST', body: captureBody() });
    } finally {
      setLogSink(null);
    }

    expect(lines.length).toBeGreaterThan(0);
    const blob = lines.join('\n');
    expect(blob).not.toContain(getSessionToken());
    // 日志只允许安全码与关联 ID：不出现笔记内容。
    expect(blob).not.toContain('T007 探针内容');
  });

  it('T007-R04 无浏览器元数据的本机自动化可用显式 Origin 通过', async () => {
    const { GET } = await import('@/app/api/items/route');
    // 手工构造：没有 Sec-Fetch-Site（curl 类客户端），但显式给出 Host/Origin/Token。
    const response = await rawCall(GET, '/api/items', {
      headers: {
        host: TEST_HOST,
        origin: TEST_ORIGIN,
        [LIMITS.tokenRequestHeader]: getSessionToken(),
      },
    });
    expect(response.status).toBe(200);
  });

  it('T007-R03 mutation 拒绝非 JSON 正文类型', async () => {
    const { POST } = await import('@/app/api/items/route');
    const before = countItems();

    const response = await callRoute(POST, {
      method: 'POST',
      contentType: 'text/plain',
      rawBody: JSON.stringify(captureBody()),
    });

    expect(response.status).toBe(400);
    expect(failureCode(response.envelope)).toBe('VALIDATION');
    expect(countItems()).toBe(before);
  });

  it('T007-C02 Host 判据是「回环地址 + 端口」精确匹配，缺端口与伪装域名同样被拒', async () => {
    const session = await import('@/app/api/session/route');
    const { GET } = await import('@/app/api/items/route');
    const token = getSessionToken();

    // `127.0.0.1`（无端口）也在列：只比对主机名会让「端口不同＝另一个来源」漏过去。
    // `127.0.0.1.nip.io` 代表解析到回环地址的公开域名，即 T007-C02 要排除的
    // 「按 IP 连上了就放行」思路。
    for (const host of ['localhost:3000', '127.0.0.1', '127.0.0.1.nip.io:3000']) {
      const bootstrap = await rawCall(session.GET, '/api/session', {
        headers: { host, origin: TEST_ORIGIN, 'sec-fetch-site': 'same-origin' },
      });
      expect(bootstrap.status, `Host=${host} 的引导请求应被拒绝`).toBe(403);
      // 「拒绝」不能变成换个方式发令牌：被拒响应体里不许出现进程令牌。
      expect(await bootstrap.text(), `Host=${host} 的拒绝响应不应含令牌`).not.toContain(token);

      const read = await rawCall(GET, '/api/items', {
        headers: {
          host,
          origin: TEST_ORIGIN,
          'sec-fetch-site': 'same-origin',
          [LIMITS.tokenRequestHeader]: token,
        },
      });
      expect(read.status, `Host=${host} 的私人读取应被拒绝`).toBe(403);
    }

    // 判据来自配置而不是硬编码字符串，所以「换端口要同时改 APP_PORT 与 APP_ORIGIN」
    // 才有落点；下面的 403 断言正是这条配置在生效。
    expect(APP_HOST).toBe('127.0.0.1');
    expect(new URL(APP_ORIGIN).port).toBe('3000');
  });

  it('T007-C01 mutation 拒绝显式跨站的浏览器元数据，即使 Origin 与令牌都合法', async () => {
    const { POST } = await import('@/app/api/items/route');
    const before = countItems();

    // 攻击者若能在受害者页面里凑出正确的 Origin 与令牌，Sec-Fetch-Site 就是最后
    // 一道元数据判据。它必须是独立错误码，而不是被笼统的 Origin 失败顺手挡下——
    // 否则将来放宽 Origin 比对时这道防线会静默消失。
    const response = await rawCall(POST, '/api/items', {
      method: 'POST',
      headers: {
        host: TEST_HOST,
        origin: TEST_ORIGIN,
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
        [LIMITS.tokenRequestHeader]: getSessionToken(),
      },
      body: JSON.stringify(captureBody()),
    });

    const envelope = (await response.json()) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(response.status).toBe(403);
    expect(envelope.error.code).toBe('LOCAL_ORIGIN_REJECTED');
    expect(envelope.error.message).toBe('拒绝跨站请求');
    expect(countItems()).toBe(before);
  });

  it('T007-R03 私人 GET 不要求 Origin，但令牌始终必需（表单/图片式旁路被挡住）', async () => {
    const { GET } = await import('@/app/api/items/route');
    const created = await callRoute(await import('@/app/api/items/route').then((m) => m.POST), {
      method: 'POST',
      body: captureBody(),
    });
    const itemId = (created.envelope as { data: { item: { id: string } } }).data.item.id;

    // 表单/图片式请求没有 Origin 可伪造，所以「允许缺 Origin」是 T007-R03 的显式
    // 契约；补它的代价就是令牌必须始终必需，否则旁路立刻成立。
    const noOriginNoToken = await rawCall(GET, '/api/items', {
      headers: { host: TEST_HOST, 'sec-fetch-site': 'none' },
    });
    expect(noOriginNoToken.status).toBe(403);
    expect(failureCode(await noOriginNoToken.json())).toBe('SESSION_EXPIRED');

    const noOriginWithToken = await rawCall(GET, '/api/items', {
      headers: { host: TEST_HOST, 'sec-fetch-site': 'none', [LIMITS.tokenRequestHeader]: getSessionToken() },
    });
    expect(noOriginWithToken.status).toBe(200);
    const page = (await noOriginWithToken.json()) as { data: { items: { id: string }[] } };
    expect(page.data.items.map((item) => item.id)).toContain(itemId);

    // 反面同样成立：Origin 一旦出现，读取路径没有第二次匹配机会。
    const foreignOrigin = await rawCall(GET, '/api/items', {
      headers: {
        host: TEST_HOST,
        origin: 'https://evil.test',
        'sec-fetch-site': 'same-origin',
        [LIMITS.tokenRequestHeader]: getSessionToken(),
      },
    });
    expect(foreignOrigin.status).toBe(403);
    expect(await foreignOrigin.text()).not.toContain('"items"');
  });

  it('T007-C05 请求正文不会被读两次：正确请求放行，二次编码的正文被 400 拒绝', async () => {
    const { POST } = await import('@/app/api/items/route');

    // 先证明正文读取路径本身没被破坏：若同一次请求的字节流被消费两次，这一条会直接 400。
    const captured = await callRoute(POST, { method: 'POST', body: captureBody() });
    expect(captured.status).toBe(201);

    // 二次编码的正文：一次 JSON.parse 得到的仍是字符串。它必须被 schema 明确拒绝，
    // 而不是靠「再解析一次碰运气」——那种写法会把未校验的原始字节交给处理器。
    const doubleEncoded = await rawCall(POST, '/api/items', {
      method: 'POST',
      headers: {
        host: TEST_HOST,
        origin: TEST_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        [LIMITS.tokenRequestHeader]: getSessionToken(),
      },
      body: JSON.stringify(JSON.stringify(captureBody())),
    });
    expect(doubleEncoded.status).toBe(400);
    expect(failureCode(await doubleEncoded.json())).toBe('VALIDATION');
  });
});
