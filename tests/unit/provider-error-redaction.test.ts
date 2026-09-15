/**
 * T030 验收用例｜服务商错误链路上的脱敏（非 `sk-` 形态）
 *
 * 这一组刻意**不使用** `sk-` 前缀的 canary。`sk-` 会被 `SECRET_PATTERNS`
 * 的模式表挡下，所以用它能写出一条永远绿的断言，却证明不了"字面值层真的接上
 * 了线"——那正是这个缺陷此前被藏住的原因。
 *
 * 这里用的四种形态（Azure 32 位 hex、Google `AIzaSy…`、自建网关 `gw_live_…`、
 * 普通随机长串）都没有任何可匹配的前缀，只有 `registerSecret` 登记后的字面值
 * 层能移除它们。因此这些断言在"接线被移除"时会真的失败。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { AppError } from '@/domain/errors';
import type { LlmConfig } from '@/domain/knowledge';
import {
  OpenAICompatibleAdapter,
  type CompleteRequest,
} from '@/server/llm/adapter';
import { classifyHttpStatus, sanitizeHint } from '@/server/llm/providerErrors';
import type { Transport, TransportRequest, TransportResponse } from '@/server/llm/transport';
import { callSnapshot } from '@/server/llm/types';
import {
  REDACTED,
  clearRegisteredSecrets,
  registerSecret,
} from '@/server/observability/redaction';

/** Azure 风格：32 位 hex，没有任何前缀可匹配。 */
const AZURE_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
/** Google Gemini 风格。 */
const GOOGLE_KEY = 'AIzaSyB7xYq2Kd9Rt4Vw1Np0Lm8Zc3Hs5Ef6Gh';
/** 自建网关风格。 */
const GATEWAY_KEY = 'gw_live_9f8e7d6c5b4a3210ffeeddcc';
/** 普通随机长串：连"看起来像凭据"都算不上。 */
const OPAQUE_KEY = 'Zx9Qw2Er5Ty8Ui3Op6As4Df7Gh1Jk0Lm';

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

class RecordingTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  calls = 0;

  constructor(private readonly respond: (request: TransportRequest) => TransportResponse) {}

  async send(request: TransportRequest): Promise<TransportResponse> {
    this.calls += 1;
    this.requests.push(request);
    return this.respond(request);
  }
}

function jsonResponse(body: unknown, status = 200): TransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    bodyText: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function request(
  transport: Transport,
  key: string,
  overrides: Partial<CompleteRequest> = {},
): CompleteRequest {
  return {
    config: callSnapshot(config(), key),
    messages: [{ role: 'user', content: 'hi' }],
    timeoutMs: 15_000,
    transport,
    ...overrides,
  };
}

afterEach(() => {
  clearRegisteredSecrets();
});

describe('T030-C02 服务商错误链路上的脱敏', () => {
  it('sanitizeHint 与 redactSecrets 共用同一套规则：Google 形态也被移除', () => {
    registerSecret(GOOGLE_KEY);

    const hint = sanitizeHint(`Invalid API key provided: ${GOOGLE_KEY}. Fix your account.`);
    expect(hint).not.toContain(GOOGLE_KEY);
    expect(hint).toContain(REDACTED);
    // 旧实现自带的 Bearer/sk- 表认不出 AIzaSy… 形态，这里必须由字面值层接住。
    expect(hint).toContain('Invalid API key provided');
  });

  it('sanitizeHint 仍保持单行与限长职责，没有把所有内容丢掉', () => {
    const long = `first line\n\n${'x'.repeat(500)}`;
    const hint = sanitizeHint(long);
    expect(hint).not.toContain('\n');
    expect(hint.length).toBeLessThanOrEqual(201);
    expect(hint.startsWith('first line')).toBe(true);
    expect(hint.endsWith('…')).toBe(true);
    // 兜底文案职责未被破坏：空值与 undefined 都返回空串。
    expect(sanitizeHint(undefined)).toBe('');
    expect(sanitizeHint('   ')).toBe('');
  });

  it('classifyHttpStatus 的 401 提示里不含被回显的 Azure hex Key', () => {
    registerSecret(AZURE_KEY);

    const error = classifyHttpStatus(401, {
      providerHint: `Incorrect API key provided: ${AZURE_KEY}`,
    });
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('PROVIDER_AUTH');
    expect(error.message).not.toContain(AZURE_KEY);
    expect(error.message).toContain(REDACTED);
  });

  it('适配器主链路：401 正文回显自建网关 Key 时，AppError 里不留明文', async () => {
    const transport = new RecordingTransport(() =>
      jsonResponse({ error: { message: `Incorrect API key provided: ${GATEWAY_KEY}` } }, 401),
    );
    const adapter = new OpenAICompatibleAdapter(transport);

    const caught = (await adapter
      .complete(request(transport, GATEWAY_KEY))
      .catch((error: unknown) => error)) as AppError;

    expect(caught).toBeInstanceOf(AppError);
    expect(caught.code).toBe('PROVIDER_AUTH');
    // 这是完整链路：adapter → summarizeProviderText → sanitizeHint → AppError.message。
    expect(caught.message).not.toContain(GATEWAY_KEY);
    expect(caught.message).toContain(REDACTED);
    expect(transport.calls).toBe(1);
  });

  it('适配器主链路：普通随机长串 Key 与 Google Key 同样被移除', async () => {
    for (const key of [OPAQUE_KEY, GOOGLE_KEY]) {
      const transport = new RecordingTransport(() =>
        jsonResponse({ error: { message: `bad credential ${key} rejected` } }, 401),
      );
      const adapter = new OpenAICompatibleAdapter(transport);

      const caught = (await adapter
        .complete(request(transport, key))
        .catch((error: unknown) => error)) as AppError;

      expect(caught.message, key).not.toContain(key);
      expect(caught.message, key).toContain('credential');
    }
  });

  it('适配器主链路：正文不是 JSON 时，纯文本回显也被移除', async () => {
    const transport = new RecordingTransport(() =>
      jsonResponse(`Unauthorized: key ${AZURE_KEY} is disabled`, 403),
    );
    const adapter = new OpenAICompatibleAdapter(transport);

    const caught = (await adapter
      .complete(request(transport, AZURE_KEY))
      .catch((error: unknown) => error)) as AppError;

    expect(caught.code).toBe('PROVIDER_AUTH');
    expect(caught.message).not.toContain(AZURE_KEY);
  });

  it('适配器主链路：Key 只进 Authorization，不因登记而进入 body', async () => {
    const transport = new RecordingTransport(() => jsonResponse({ error: { message: 'nope' } }, 500));
    const adapter = new OpenAICompatibleAdapter(transport);

    await adapter.complete(request(transport, GATEWAY_KEY)).catch(() => undefined);

    const sent = transport.requests[0];
    expect(sent.headers.Authorization).toBe(`Bearer ${GATEWAY_KEY}`);
    expect(sent.body).not.toContain(GATEWAY_KEY);
  });

  it('适配器主链路：不相关失败仍然按原有错误码分类，不被脱敏改味', async () => {
    const transport = new RecordingTransport(() =>
      jsonResponse({ error: { message: 'unsupported parameter' } }, 400),
    );
    const adapter = new OpenAICompatibleAdapter(transport);

    const caught = (await adapter
      .complete(request(transport, GATEWAY_KEY))
      .catch((error: unknown) => error)) as AppError;

    // 400 仍然落到 PROVIDER_PROTOCOL，不因脱敏改动而换码或改文案。
    expect(caught).toBeInstanceOf(AppError);
    expect(caught.code).toBe('PROVIDER_PROTOCOL');
    expect(caught.message).toContain('服务商拒绝了请求参数');
  });
});
