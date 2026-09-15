/**
 * T031 验收用例｜OpenAI兼容HTTP适配器
 *
 * 全部请求走可注入 transport：既记录 endpoint、调用次数、body 字段与超时，
 * 又保证测试永远不会真的访问外部域名。
 */
import { describe, expect, it, vi } from 'vitest';

import { AppError } from '@/domain/errors';
import type { LlmConfig } from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import {
  OpenAICompatibleAdapter,
  buildRequestBody,
  configSnapshot,
  type ChatMessage,
  type CompleteRequest,
} from '@/server/llm/adapter';
import {
  EmptyOutputError,
  ProtocolError,
  RefusalError,
  TruncatedError,
} from '@/server/llm/protocol';
import { StructuredModeRejectedError } from '@/server/llm/providerErrors';
import {
  FetchTransport,
  readBoundedBody,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '@/server/llm/transport';
import { callSnapshot, type LlmCallSnapshot } from '@/server/llm/types';

const KEY = 'sk-test-canary-0000000000000000';
const BASE = 'https://api.example.com/v1';

function config(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    adapter: 'openai-compatible',
    baseUrl: BASE,
    model: 'test-model',
    structuredMode: 'prompt_json',
    tokenField: 'none',
    maxOutputTokens: 4096,
    schemaRepairEnabled: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<LlmConfig> = {}): LlmCallSnapshot {
  return callSnapshot(config(overrides), KEY);
}

/** Records every outbound request and returns a scripted response. */
class RecordingTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  calls = 0;
  private readonly handler: (request: TransportRequest) => TransportResponse;

  constructor(handler: (request: TransportRequest) => TransportResponse) {
    this.handler = handler;
  }

  async send(request: TransportRequest): Promise<TransportResponse> {
    this.calls += 1;
    this.requests.push(request);
    return this.handler(request);
  }
}

function jsonResponse(body: unknown, status = 200): TransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    bodyText: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function completion(content: string, finishReason = 'stop') {
  return {
    choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];

function request(transport: Transport, overrides: Partial<CompleteRequest> = {}): CompleteRequest {
  return {
    config: snapshot(),
    messages: MESSAGES,
    timeoutMs: 15_000,
    transport,
    ...overrides,
  };
}

describe('T031 适配器', () => {
  it('T031-C01 基础请求只带 model、messages、stream，且不带 temperature', async () => {
    const transport = new RecordingTransport(() => jsonResponse(completion('ok')));
    const adapter = new OpenAICompatibleAdapter();

    const result = await adapter.complete(request(transport));

    expect(transport.calls).toBe(1);
    const body = JSON.parse(transport.requests[0].body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['messages', 'model', 'stream']);
    expect(body.stream).toBe(false);
    expect(body.model).toBe('test-model');
    // 关键否定断言：兼容接口最容易因为多余参数直接 400。
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('response_format');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(result.content).toBe('ok');
    expect(result.usage?.totalTokens).toBe(15);
  });

  it('T031-R01 json_object 才发送 response_format，且只发一个 token 字段', async () => {
    const transport = new RecordingTransport(() => jsonResponse(completion('{"ok":true}')));
    const adapter = new OpenAICompatibleAdapter();

    await adapter.complete(
      request(transport, {
        config: snapshot({ structuredMode: 'json_object', tokenField: 'max_tokens' }),
      }),
    );

    const body = JSON.parse(transport.requests[0].body) as Record<string, unknown>;
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_tokens).toBe(4096);
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('temperature');
  });

  it('T031-C02 服务商拒绝 response_format 时明确报错且不自动重发', async () => {
    const transport = new RecordingTransport(() =>
      jsonResponse(
        { error: { message: "Unsupported parameter: 'response_format' is not supported" } },
        400,
      ),
    );
    const adapter = new OpenAICompatibleAdapter();

    const caught = await adapter
      .complete(request(transport, { config: snapshot({ structuredMode: 'json_object' }) }))
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(StructuredModeRejectedError);
    expect((caught as Error).message).toContain('提示词');
    // 没有第二次付费请求，也没有偷偷换档位。
    expect(transport.calls).toBe(1);
  });

  it('T031-C03 finish_reason=length 标记不完整，不把残片当结果', async () => {
    const transport = new RecordingTransport(() =>
      jsonResponse(completion('{"title":"半截', 'length')),
    );
    const adapter = new OpenAICompatibleAdapter();

    const caught = await adapter.complete(request(transport)).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(TruncatedError);
  });

  it('T031-C04 content 为 null 或空串时返回 EMPTY_MODEL_OUTPUT', async () => {
    for (const content of [null, '', '   ']) {
      const transport = new RecordingTransport(() =>
        jsonResponse({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }),
      );
      const adapter = new OpenAICompatibleAdapter();
      const caught = await adapter.complete(request(transport)).catch((error: unknown) => error);
      expect(caught, `content=${JSON.stringify(content)}`).toBeInstanceOf(EmptyOutputError);
      expect((caught as EmptyOutputError).code).toBe('EMPTY_MODEL_OUTPUT');
    }
  });

  it('T031-C05 响应超过字节预算时立即中止', async () => {
    const oversize = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 40; index += 1) {
          controller.enqueue(new Uint8Array(1024).fill(120));
        }
        controller.close();
      },
    });

    const caught = await readBoundedBody(oversize, 4096).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('4096');
  });

  it('T031-C06 模型要求执行工具时拒绝，不执行任何动作', async () => {
    const transport = new RecordingTransport(() =>
      jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'rm', arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    const adapter = new OpenAICompatibleAdapter();

    const caught = await adapter.complete(request(transport)).catch((error: unknown) => error);
    // tool_calls 不是可应用文本；执行它才是本版本明确禁止的事。
    expect(caught).toBeInstanceOf(ProtocolError);
    expect((caught as ProtocolError).code).toBe('PROVIDER_PROTOCOL');
  });

  it('T031-R05 显式拒绝文本与 content_filter 都算拒绝', async () => {
    const refusalTransport = new RecordingTransport(() =>
      jsonResponse(completion('I cannot help with that request.')),
    );
    const adapter = new OpenAICompatibleAdapter();
    await expect(adapter.complete(request(refusalTransport))).rejects.toBeInstanceOf(RefusalError);

    const filtered = new RecordingTransport(() =>
      jsonResponse({
        choices: [{ message: { content: 'xxx' }, finish_reason: 'content_filter' }],
      }),
    );
    await expect(adapter.complete(request(filtered))).rejects.toBeInstanceOf(RefusalError);
  });

  it('T031-R06 不使用 reasoning_content，也不拼接多个 choices', async () => {
    const reasoningOnly = new RecordingTransport(() =>
      jsonResponse({
        choices: [
          {
            message: { role: 'assistant', content: null, reasoning_content: '我想到的答案…' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    const adapter = new OpenAICompatibleAdapter();
    const caught = await adapter
      .complete(request(reasoningOnly))
      .catch((error: unknown) => error);
    // reasoning 内容不会被当作最终结果。
    expect(caught).toBeInstanceOf(EmptyOutputError);

    const multiChoice = new RecordingTransport(() =>
      jsonResponse({
        choices: [
          { message: { content: 'a' }, finish_reason: 'stop' },
          { message: { content: 'b' }, finish_reason: 'stop' },
        ],
      }),
    );
    const multi = await adapter.complete(request(multiChoice)).catch((error: unknown) => error);
    expect(multi).toBeInstanceOf(ProtocolError);
  });

  it('T031-R03 Key 只出现在 Authorization，不进入 body 或 messages', async () => {
    const transport = new RecordingTransport(() => jsonResponse(completion('ok')));
    const adapter = new OpenAICompatibleAdapter();

    await adapter.complete(
      request(transport, {
        messages: [{ role: 'user', content: '这是我的私人笔记内容。' }],
      }),
    );

    const sent = transport.requests[0];
    expect(sent.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(sent.body).not.toContain(KEY);
    expect(sent.url).toBe(`${BASE}/chat/completions`);
  });

  it('T031-R03 单次调用超时不超过服务商上限', async () => {
    const transport = new RecordingTransport(() => jsonResponse(completion('ok')));
    const adapter = new OpenAICompatibleAdapter();

    await adapter.complete(request(transport, { timeoutMs: 10 * 60 * 1000 }));
    expect(transport.requests[0].timeoutMs).toBe(LIMITS.providerCallTimeoutMs);

    const shortTransport = new RecordingTransport(() => jsonResponse(completion('ok')));
    await adapter.complete(request(shortTransport, { timeoutMs: 900 }));
    expect(shortTransport.requests[0].timeoutMs).toBe(900);
  });

  it('T031-R04 非 JSON 的成功响应按协议错误处理，而不是伪装成功', async () => {
    const transport = new RecordingTransport(() => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      bodyText: '<html><body>502 Bad Gateway</body></html>',
    }));
    const adapter = new OpenAICompatibleAdapter();

    const caught = await adapter.complete(request(transport)).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ProtocolError);
  });

  it('T031-R04 错误状态与错误正文都不泄漏 Key', async () => {
    const transport = new RecordingTransport(() =>
      jsonResponse({ error: { message: `Invalid API key: ${KEY}` } }, 401),
    );
    const adapter = new OpenAICompatibleAdapter();

    const caught = (await adapter.complete(request(transport)).catch((error: unknown) => error)) as Error;
    expect(caught.message).not.toContain(KEY);
    // 401 必须映射为鉴权错误，用户才知道要先修哪一项。
    expect((caught as { code?: string }).code).toBe('PROVIDER_AUTH');
  });

  it('T031-R03 未配置完整时在发请求前就失败，不产生调用', async () => {
    const transport = new RecordingTransport(() => jsonResponse(completion('ok')));
    const adapter = new OpenAICompatibleAdapter();

    const caught = await adapter
      .complete(request(transport, { config: callSnapshot(config({ model: '' }), KEY) }))
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('MODEL_NOT_CONFIGURED');
    expect(transport.calls).toBe(0);
  });

  it('T031-R04 FetchTransport 拒绝跟随重定向', async () => {
    const init: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
      init.push(options);
      return new Response('{"choices":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const transport = new FetchTransport();
      await transport.send({
        url: `${BASE}/chat/completions`,
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}` },
        body: '{}',
        timeoutMs: 1000,
      });

      expect(init).toHaveLength(1);
      expect(init[0].redirect).toBe('error');
      expect(init[0].cache).toBe('no-store');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('T031-R02 buildRequestBody 的档位矩阵互斥', () => {
    const promptJson = buildRequestBody(snapshot(), MESSAGES);
    expect(promptJson).not.toHaveProperty('response_format');

    const withCompletion = buildRequestBody(
      snapshot({ tokenField: 'max_completion_tokens' }),
      MESSAGES,
    );
    expect(withCompletion.max_completion_tokens).toBe(4096);
    expect(withCompletion).not.toHaveProperty('max_tokens');

    const noToken = buildRequestBody(snapshot({ tokenField: 'none' }), MESSAGES);
    expect(noToken).not.toHaveProperty('max_tokens');
    expect(noToken).not.toHaveProperty('max_completion_tokens');
  });

  it('T031-R03 configSnapshot 只含可持久化字段，形状上放不下 Key', () => {
    const persisted = configSnapshot(snapshot());
    const blob = JSON.stringify(persisted);
    expect(blob).not.toContain(KEY);
    expect(persisted.baseUrlOrigin).toBe('https://api.example.com');
    expect(Object.keys(persisted).sort()).toEqual([
      'adapter',
      'baseUrlOrigin',
      'maxOutputTokens',
      'model',
      'structuredMode',
      'tokenField',
    ]);
  });
});
