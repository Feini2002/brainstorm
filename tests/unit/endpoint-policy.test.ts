/**
 * T028 验收用例｜Base URL 规范化与出站信任边界
 *
 * 这一层是纯函数与传输缝的验证。浏览器的“测试连接”可见行为是 T032 的事，
 * 这里证明的是：最终 endpoint 怎么算、哪些地址被拒绝、以及在传输层是否真的
 * 关掉了重定向跟随。
 */
import { describe, expect, it } from 'vitest';

import { LIMITS } from '@/domain/limits';
import { AppError } from '@/domain/errors';
import {
  CHAT_COMPLETIONS_PATH,
  EndpointRejectedError,
  displayEndpointHost,
  requireEndpoint,
  requiresKeyTransferConfirmation,
  resolveEndpoint,
} from '@/server/llm/endpointPolicy';
import { FetchTransport, ResponseTooLargeError, readBoundedBody } from '@/server/llm/transport';

describe('T028 Base URL 规范化', () => {
  it('T028-R02 拒绝嵌入凭据、query 与 fragment 的地址', () => {
    const cases: [string, string][] = [
      ['https://user:pass@api.example.com/v1', '不能包含用户名或密码'],
      ['https://user@api.example.com/v1', '不能包含用户名或密码'],
      ['https://api.example.com/v1?token=abc', '不能包含查询参数'],
      ['https://api.example.com/v1#section', '不能包含片段标识'],
    ];
    for (const [input, fragment] of cases) {
      const decision = resolveEndpoint(input);
      expect(decision.ok, `${input} 应被拒绝`).toBe(false);
      expect(decision.reason).toContain(fragment);
    }
  });

  it('T028-R02 粘贴完整 /chat/completions 时提示填根地址，不拼接两次', () => {
    const decision = resolveEndpoint('https://api.example.com/v1/chat/completions');
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain('/chat/completions');
    expect(decision.endpoint).toBeUndefined();
  });

  it('T028-R02 拒绝反斜杠混淆与非法地址', () => {
    expect(resolveEndpoint('https://api.example.com\\v1').ok).toBe(false);
    expect(resolveEndpoint('not a url').reason).toContain('不是合法地址');
    expect(resolveEndpoint('').reason).toContain('请填写');
  });

  it('T028-R02 超过长度上限的地址被拒绝', () => {
    const long = `https://api.example.com/${'a'.repeat(LIMITS.baseUrlCodePoints)}`;
    expect(resolveEndpoint(long).ok).toBe(false);
  });

  it('T028-R01 只接受 https，http 一律拒绝', () => {
    const decision = resolveEndpoint('http://api.example.com/v1');
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain('HTTPS');
  });

  it('T028-C06 拒绝 loopback 与私网字面 IP，并说明是本版本不支持', () => {
    const rejected = [
      'https://localhost/v1',
      'https://api.localhost/v1',
      'https://127.0.0.1/v1',
      'https://10.1.2.3/v1',
      'https://172.16.0.1/v1',
      'https://192.168.1.1/v1',
      'https://169.254.1.1/v1',
      'https://100.64.0.1/v1',
      'https://198.18.0.1/v1',
      'https://0.0.0.0/v1',
      'https://[::1]/v1',
      'https://[fd00::1]/v1',
      'https://[fe80::1]/v1',
    ];
    for (const input of rejected) {
      const decision = resolveEndpoint(input);
      expect(decision.ok, `${input} 应被拒绝`).toBe(false);
      expect(decision.reason).toBeTruthy();
    }
    expect(resolveEndpoint('https://localhost/v1').reason).toContain('localhost');
    expect(resolveEndpoint('https://10.1.2.3/v1').reason).toContain('内网');
  });

  it('T028-C01 保留网关前缀，只追加一次 /chat/completions', () => {
    const decision = resolveEndpoint('https://gateway.example.com/api/openai/v1');
    expect(decision.ok).toBe(true);
    expect(decision.endpoint).toBe(
      `https://gateway.example.com/api/openai/v1${CHAT_COMPLETIONS_PATH}`,
    );
    // 前缀没有被当成相对路径丢掉。
    expect(decision.endpoint).toContain('/api/openai/v1/chat/completions');
  });

  it('T028-R03 不去掉合法版本前缀，末尾斜杠被规范化', () => {
    expect(resolveEndpoint('https://api.example.com/v1/').endpoint).toBe(
      `https://api.example.com/v1${CHAT_COMPLETIONS_PATH}`,
    );
    expect(resolveEndpoint('https://api.example.com/v1///').endpoint).toBe(
      `https://api.example.com/v1${CHAT_COMPLETIONS_PATH}`,
    );
    // 不带 /v1 的地址保持原样：不给所有地址自动加 /v1。
    expect(resolveEndpoint('https://api.example.com').endpoint).toBe(
      `https://api.example.com${CHAT_COMPLETIONS_PATH}`,
    );
  });

  it('T028-R03 大小写与默认端口不产生多余差异', () => {
    expect(resolveEndpoint('HTTPS://API.example.com/V1').ok).toBe(true);
    expect(resolveEndpoint('https://api.example.com:443/v1').origin).toBe(
      'https://api.example.com',
    );
  });

  it('requireEndpoint 对非法地址抛 EndpointRejectedError', () => {
    expect(() => requireEndpoint('http://api.example.com')).toThrow(EndpointRejectedError);
    expect(() => requireEndpoint('https://127.0.0.1')).toThrow(AppError);
  });

  it('T028-R06 凭据转移只在 origin 变化时要求确认', () => {
    expect(
      requiresKeyTransferConfirmation('https://api.example.com/v1', 'https://api.example.com/v2'),
    ).toBe(false);
    expect(
      requiresKeyTransferConfirmation('https://api.example.com/v1', 'https://other.example.com/v1'),
    ).toBe(true);
    // 非法地址不产生“需要确认”的误导结论：无法比较时不要求。
    expect(requiresKeyTransferConfirmation('http://api.example.com', 'https://other.com')).toBe(
      false,
    );
  });

  it('诊断展示只给 host，不泄露带租户信息的路径', () => {
    expect(displayEndpointHost('https://api.example.com/tenant/secret-path/v1')).toBe(
      'api.example.com',
    );
    expect(displayEndpointHost('http://127.0.0.1:8080')).toBe('(未配置)');
  });
});

describe('T028 传输层边界', () => {
  it('T028-R04 生产传输固定 redirect: error，不跟随 301/302', async () => {
    const calls: RequestInit[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const transport = new FetchTransport();
      await transport.send({
        url: `https://api.example.com/v1${CHAT_COMPLETIONS_PATH}`,
        method: 'POST',
        headers: { Authorization: 'Bearer test' },
        body: '{}',
        timeoutMs: 1000,
      });
      expect(calls).toHaveLength(1);
      // 这是本任务的核心断言：凭据不会因为一次 3xx 被带到另一个域名。
      expect(calls[0].redirect).toBe('error');
      expect(calls[0].cache).toBe('no-store');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('T028-R04 一次请求只发一次，不自动重试', async () => {
    let count = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      count += 1;
      return new Response('redirected', { status: 302, headers: { location: 'https://evil.test/' } });
    }) as typeof fetch;

    try {
      const transport = new FetchTransport();
      // 302 是响应，不是异常：函数会把状态原样交给上层分类，不自行再发一次。
      const response = await transport.send({
        url: `https://api.example.com/v1${CHAT_COMPLETIONS_PATH}`,
        method: 'POST',
        headers: { Authorization: 'Bearer test' },
        body: '{}',
        timeoutMs: 1000,
      });
      expect(response.status).toBe(302);
      expect(count).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('响应体读取有硬上限，超限即中止', async () => {
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64));
        controller.enqueue(new Uint8Array(64));
        controller.close();
      },
    });
    await expect(readBoundedBody(oversized, 100)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('空响应体读成空字符串，不抛错', async () => {
    expect(await readBoundedBody(null)).toBe('');
  });
});
