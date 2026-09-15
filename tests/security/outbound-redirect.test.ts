/**
 * T075-C04｜出站重定向：连接测试遇到 302 必须失败，且 Key 不转发到重定向目标。
 *
 * 用例规格：`docs/05_tests/G6/T075_cases.md`；规则 T075-R04「出站 endpoint 来自设置，
 * 重定向不跟随」。
 *
 * ## 与既有断言的区别（本轮盘点的缺口）
 *
 * `tests/unit/endpoint-policy.test.ts`（T028-R04）与 `tests/unit/llm-transport.test.ts`
 * （T031-R04）已经验证了 `FetchTransport` 给 `fetch` 传了 `redirect: 'error'`。那是有用
 * 的断言，但它是**配置断言**：它证明选项被传进去了，不证明一次真实的 302 会让请求失败，
 * 也不证明 `Location` 指向的主机不会收到凭据。
 *
 * 本文件补的正是那一半，而且不用任何 fetch 替身：
 *
 *  - 起两个**真实**的 loopback HTTP 服务：一个永远回 302，`Location` 指向另一个；
 *  - 用**生产**的 `FetchTransport` 发请求，观察 Node 的真实行为（实测：
 *    `TypeError: fetch failed`，`cause.message === 'unexpected redirect'`）；
 *  - 断言重定向目标收到 **0** 个请求、**0** 个 `Authorization` 头；
 *  - 再把这条链路接到**连接测试**（T032）的服务上，证明它报的是失败而不是「连上了」。
 *
 * ## 为什么不用真实外部域名
 *
 * T075 的公共测试装置明确禁止「测试恶意输入不能真的访问未知外部域名」。两个服务都只
 * 绑 `127.0.0.1` 且用随机端口，`Location` 也指向 `127.0.0.1`——重定向的目标是受控的
 * 本机端点，因此可以断言它「没有收到请求」，而不是只能断言「我们没跟过去」。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import type { LlmConfig } from '@/domain/knowledge';
import { OpenAICompatibleAdapter } from '@/server/llm/adapter';
import {
  FetchTransport,
  setTransport,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '@/server/llm/transport';
import { clearRegisteredSecrets, redactSecrets } from '@/server/observability/redaction';
import { runConnectionTest } from '@/server/services/testConnection';
import { createTestDatabase, newId, openTestDatabase, type TestDatabase } from '../helpers/db';
import {
  startChatServer,
  startRedirectServer,
  type LoopbackServer,
} from '../helpers/loopback';

const STORED_KEY = 'gw-test-REDIRECT-9988776655';

/**
 * A syntactically valid HTTPS public endpoint that cannot be resolved.
 *
 * `endpointPolicy` requires HTTPS and a non-private host, but it deliberately does
 * not resolve DNS (the declared boundary is that a public hostname may still
 * resolve into a private network). The destination is therefore only ever used to
 * *build* the request; the transport below reroutes it to a real loopback server.
 * Nothing here resolves or contacts `example.com`.
 */
const CONFIGURED_BASE_URL = 'https://redirect-probe.example.com/v1';

function config(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    adapter: 'openai-compatible',
    baseUrl: CONFIGURED_BASE_URL,
    model: 'test-model',
    structuredMode: 'prompt_json',
    tokenField: 'none',
    maxOutputTokens: 4096,
    schemaRepairEnabled: false,
    ...overrides,
  };
}

/**
 * A transport that sends the adapter's real request to a real loopback server.
 *
 * `endpointPolicy` will never accept a loopback Base URL, so this is the only way
 * to drive a genuine HTTP redirect through the connection-test path. It replaces
 * the *destination*, not the behaviour: the request is built by the production
 * adapter (including the `Authorization` header) and sent by the production
 * `FetchTransport`, so `redirect: 'error'` and the error classification both run.
 */
class ReroutingTransport implements Transport {
  readonly seen: TransportRequest[] = [];
  constructor(
    private readonly target: LoopbackServer,
    private readonly inner: Transport = new FetchTransport(),
  ) {}

  async send(request: TransportRequest): Promise<TransportResponse> {
    this.seen.push(request);
    return this.inner.send({ ...request, url: `${this.target.origin}/chat/completions` });
  }
}

let redirector: LoopbackServer;
let redirectTarget: LoopbackServer;
let harness: TestDatabase;
let db: DatabaseSync;

beforeEach(async () => {
  clearRegisteredSecrets();
  // The redirect target is where a followed redirect would send the credential.
  // It answers 200 so that a following implementation would look *successful* —
  // a 404 target could make "not forwarded" pass for the wrong reason.
  redirectTarget = await startChatServer();
  redirector = await startRedirectServer(`${redirectTarget.origin}/chat/completions`);
  harness = createTestDatabase();
  db = openTestDatabase(harness.databasePath);
});

afterEach(async () => {
  setTransport(null);
  harness.cleanup();
  clearRegisteredSecrets();
  await redirector.close();
  await redirectTarget.close();
});

describe('T075-C04 生产传输面对真实 302', () => {
  it('T075-C04 FetchTransport 对真实 302 抛错，且重定向目标收不到任何请求', async () => {
    const transport = new FetchTransport();

    const caught = (await transport
      .send({
        url: `${redirector.origin}/chat/completions`,
        method: 'POST',
        headers: { Authorization: `Bearer ${STORED_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        timeoutMs: 5000,
      })
      .catch((error: unknown) => error)) as AppError;

    // ① 失败，而不是把 3xx 当成一个正常响应返回给上层。
    expect(caught, '真实 302 必须让传输失败').toBeInstanceOf(AppError);

    // ② 302 确实到达了配置的目标，而且凭据只到了那里。
    expect(redirector.requests).toHaveLength(1);
    expect(redirector.requests[0].authorization).toBe(`Bearer ${STORED_KEY}`);

    // ③ 关键断言：重定向目标一个请求、一个凭据都没收到。
    expect(
      redirectTarget.requests,
      '重定向目标不得收到任何请求（否则凭据已经转发出去）',
    ).toEqual([]);
  });

  it('T075-C04 302 的响应体与 Location 都不会被当作结果交给上层', async () => {
    const transport = new FetchTransport();

    const caught = (await transport
      .send({
        url: `${redirector.origin}/chat/completions`,
        method: 'POST',
        headers: { Authorization: `Bearer ${STORED_KEY}` },
        body: '{}',
        timeoutMs: 5000,
      })
      .catch((error: unknown) => error)) as AppError;

    // 没有解析、没有把 Location 回显给用户：错误消息里不含目标地址。
    const message = (caught as Error).message;
    expect(message).not.toContain(redirectTarget.origin);
    expect(message).not.toContain(STORED_KEY);
  });

  it('T075-C04 302 链不被跟随：即使目标也是 302，也只发出一次请求', async () => {
    // 一个「永远重定向」的服务：跟随式实现会在这里循环或走很多跳。
    const loop = await startRedirectServer(`${redirector.origin}/again`);

    try {
      const transport = new FetchTransport();
      await transport
        .send({
          url: `${loop.origin}/chat/completions`,
          method: 'POST',
          headers: { Authorization: `Bearer ${STORED_KEY}` },
          body: '{}',
          timeoutMs: 5000,
        })
        .catch(() => undefined);

      expect(loop.requests, '循环重定向下也只应发出一次请求').toHaveLength(1);
      expect(redirector.requests, '不得跳到相邻的一跳').toEqual([]);
    } finally {
      await loop.close();
    }
  });

  it('T075-C04 错误码把重定向与「网络连不上」区分开', async () => {
    // 这条断言的是**诊断质量**，而它曾经是错的：`fetch` 在 `redirect: 'error'` 下抛的是
    // `TypeError('fetch failed')`，真正的原因在 `error.cause.message === 'unexpected
    // redirect'`。只看 `error.message` 的实现会把它归成 PROVIDER_NETWORK，
    // 于是用户在「服务商返回了重定向」时被指去检查本机网络与防火墙。
    //
    // 安全后果没有差别（两种码都失败关闭、都不转发凭据），但给出的下一步是错的，
    // 而且 `mayHaveBeenBilled(PROVIDER_NETWORK)` 为真，会声称本次请求「可能已经计费」。
    const transport = new FetchTransport();

    const caught = (await transport
      .send({
        url: `${redirector.origin}/chat/completions`,
        method: 'POST',
        headers: { Authorization: `Bearer ${STORED_KEY}` },
        body: '{}',
        timeoutMs: 5000,
      })
      .catch((error: unknown) => error)) as AppError;

    expect(caught.code).toBe('PROVIDER_ENDPOINT');
    expect((caught as Error).message).toContain('重定向');
  });

  it('T075-C04 修好归类后不把「域名里带 redirect」的网络故障误判成重定向', async () => {
    // 上一条修的是一个**误报**：真实 302 被说成网络故障。这条防的是反向误报：
    // 只要消息里出现 "redirect" 就算重定向的写法，会把主机名恰好含 redirect 的
    // DNS 故障也报成重定向。真实条件：解析失败时 cause.message 里带的是主机名。
    const transport = new FetchTransport();

    const caught = (await transport
      .send({
        url: 'http://redirect-probe.invalid/chat/completions',
        method: 'POST',
        headers: { Authorization: `Bearer ${STORED_KEY}` },
        body: '{}',
        timeoutMs: 10_000,
      })
      .catch((error: unknown) => error)) as AppError;

    expect(caught).toBeInstanceOf(AppError);
    expect(caught.code, 'DNS 失败不是重定向').toBe('PROVIDER_NETWORK');
    expect(caught.code).not.toBe('PROVIDER_ENDPOINT');
  });

  it('T075-C04 连接被拒绝归为网络故障，且不声称已计费之外的信息', async () => {
    // 关闭端口上的真实 ECONNREFUSED：请求根本没离开本机。
    const port = redirector.port;
    await redirector.close();

    const transport = new FetchTransport();
    const caught = (await transport
      .send({
        url: `http://127.0.0.1:${port}/chat/completions`,
        method: 'POST',
        headers: { Authorization: `Bearer ${STORED_KEY}` },
        body: '{}',
        timeoutMs: 5000,
      })
      .catch((error: unknown) => error)) as AppError;

    expect(caught.code).toBe('PROVIDER_NETWORK');
    // 连接被拒绝是本机就结束的，绝不可能是重定向。
    expect(caught.code).not.toBe('PROVIDER_ENDPOINT');
  });
});

describe('T075-C04 连接测试路径（T032）端到端', () => {
  it('T075-C04 302 让连接测试失败，Run 记为 failed，且 Key 只到达配置的目标', async () => {
    const reroute = new ReroutingTransport(redirector);

    const caught = (await runConnectionTest(db, {
      requestKey: newId(),
      config: config(),
      apiKey: STORED_KEY,
      configRevision: 0,
      adapter: new OpenAICompatibleAdapter(reroute),
    }).catch((error: unknown) => error)) as AppError;

    // ① 连接测试以失败告终，绝不能报成「连上了」。
    expect(caught).toBeInstanceOf(AppError);
    expect(caught.code).toBe('PROVIDER_ENDPOINT');

    // ② 请求确实发出过，且带着凭据——它去的是用户配置的那个地址。
    expect(reroute.seen).toHaveLength(1);
    expect(reroute.seen[0].headers.Authorization).toBe(`Bearer ${STORED_KEY}`);
    expect(redirector.requests).toHaveLength(1);

    // ③ 重定向目标没有收到请求，因此也没有收到 Key。
    expect(redirectTarget.requests).toEqual([]);

    // ④ Run 的终态是可追溯的失败，而不是留在 running。
    const run = db
      .prepare('SELECT state, error_code, error_message FROM ai_runs ORDER BY started_at DESC LIMIT 1')
      .get() as { state: string; error_code: string | null; error_message: string | null };
    expect(run.state).toBe('failed');
    expect(run.error_code).toBe('PROVIDER_ENDPOINT');
    expect(run.error_message, '落库消息不得出现明文 Key').not.toContain(STORED_KEY);

    // ⑤ 抛给浏览器/调用方的消息同样不含 Key，也不含重定向目标地址。
    expect(caught.message).not.toContain(STORED_KEY);
    expect(caught.message).not.toContain(redirectTarget.origin);
  });

  it('T075-C04 重定向失败后，脱敏层仍认得这把 Key（文档引用它时会被移除）', async () => {
    // 接线检查：适配器在发请求前调用 `registerSecret`，所以即使这一次调用失败，
    // 后续任何引用该 Key 的自由文本（例如用户复制诊断说明）仍会被移除。
    const reroute = new ReroutingTransport(redirector);

    await runConnectionTest(db, {
      requestKey: newId(),
      config: config(),
      apiKey: STORED_KEY,
      configRevision: 0,
      adapter: new OpenAICompatibleAdapter(reroute),
    }).catch(() => undefined);

    expect(redactSecrets(`错误说明里引用了 ${STORED_KEY}`)).not.toContain(STORED_KEY);
  });

  it('T075-C04 换一个干净的 200 目标时连接测试通过（证明上一条不是恒真失败）', async () => {
    const clean = await startChatServer('{"ok":true}');

    try {
      const reroute = new ReroutingTransport(clean);
      const result = await runConnectionTest(db, {
        requestKey: newId(),
        config: config(),
        apiKey: STORED_KEY,
        configRevision: 0,
        adapter: new OpenAICompatibleAdapter(reroute),
      });

      expect(result.connected).toBe(true);
      expect(result.replyAccepted).toBe(true);
      expect(clean.requests).toHaveLength(1);
    } finally {
      await clean.close();
    }
  });
});
