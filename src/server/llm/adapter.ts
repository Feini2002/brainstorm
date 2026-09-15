/**
 * OpenAI-compatible adapter (T031).
 *
 * The only module in the codebase that talks to a model provider. Business
 * layers depend on `LLMAdapter`, so supporting another vendor later means adding
 * an adapter — not editing Inbox, Library, Graph, Mindmap or Flow.
 *
 * The rules this file exists to hold:
 *   - `temperature` is never sent, and exactly one token field at most, because
 *     compatible services reject parameters they do not implement (T031-R01).
 *   - `response_format` appears only for the explicitly chosen `json_object`
 *     mode, and an unsupported-mode failure is reported, never silently retried
 *     in the other mode (T031-R02).
 *   - the deadline is an absolute instant shared by the controller and the
 *     request, so a retry cannot award itself a fresh timeout (T031-R03).
 *   - the response body is read with a byte cap, and non-2xx / non-JSON bodies
 *     are handled by different branches (T031-R04).
 *   - only `choices[0].message.content` is accepted (T031-R05), and nothing is
 *     executed on the model's behalf (T031-R06).
 */
import 'server-only';

import { AppError } from '@/domain/errors';
import { LIMITS } from '@/domain/limits';
import { requireEndpoint } from './endpointPolicy';
import { parseCompletion, type ParsedCompletion } from './protocol';
import { classifyHttpStatus, parseRetryAfter } from './providerErrors';
import { getTransport, type Transport } from './transport';
import { summarizeProviderText } from '@/server/observability/redaction';
import type { LlmCallSnapshot } from './types';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface CompleteRequest {
  /** Per-call snapshot; carries the key only inside this call frame (T031-R03). */
  config: LlmCallSnapshot;
  messages: ChatMessage[];
  /**
   * Remaining time on the *operation*, not a fresh per-attempt budget. Callers
   * pass the result of `attemptTimeoutMs` (T031-R03, docs/03_contracts/06 §4).
   */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Replaces the process-wide transport in tests. */
  transport?: Transport;
}

export interface LLMAdapter {
  complete(request: CompleteRequest): Promise<ParsedCompletion>;
}

/** Config fields safe to persist in a run snapshot: never the key. */
export interface ConfigSnapshot {
  adapter: LlmCallSnapshot['adapter'];
  baseUrlOrigin: string;
  model: string;
  structuredMode: LlmCallSnapshot['structuredMode'];
  tokenField: LlmCallSnapshot['tokenField'];
  maxOutputTokens: number;
}

/** Project a call snapshot down to the persistable subset. */
export function configSnapshot(config: LlmCallSnapshot): ConfigSnapshot {
  const { origin } = requireEndpoint(config.baseUrl);
  return {
    adapter: config.adapter,
    baseUrlOrigin: origin,
    model: config.model,
    structuredMode: config.structuredMode,
    tokenField: config.tokenField,
    maxOutputTokens: config.maxOutputTokens,
  };
}

export class ModelNotConfiguredError extends AppError {
  constructor(message = '尚未配置模型连接，请到设置页填写') {
    super('MODEL_NOT_CONFIGURED', message);
    this.name = 'ModelNotConfiguredError';
  }
}

export class StructuredModeRejectedError extends AppError {
  constructor(message: string) {
    super('PROVIDER_PROTOCOL', message);
    this.name = 'StructuredModeRejectedError';
  }
}

/** Fail before any network call rather than after a paid one. */
export function assertConfigured(config: LlmCallSnapshot): void {
  if (config.baseUrl.trim().length === 0 || config.model.trim().length === 0) {
    throw new ModelNotConfiguredError('模型配置不完整，请填写 Base URL 与模型名');
  }
  if (config.apiKey.length === 0) {
    throw new ModelNotConfiguredError('尚未保存 API Key');
  }
}

interface RequestBody {
  model: string;
  messages: { role: string; content: string }[];
  stream: false;
  response_format?: { type: 'json_object' };
  max_tokens?: number;
  max_completion_tokens?: number;
}

/**
 * Build the request body.
 *
 * `temperature` is deliberately absent, and only the selected token field is
 * ever emitted: sending both `max_tokens` and `max_completion_tokens` is a 400
 * on most compatible services.
 */
export function buildRequestBody(
  config: LlmCallSnapshot,
  messages: ChatMessage[],
): RequestBody {
  const body: RequestBody = {
    model: config.model,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    stream: false,
  };

  if (config.structuredMode === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  switch (config.tokenField) {
    case 'max_tokens':
      body.max_tokens = config.maxOutputTokens;
      break;
    case 'max_completion_tokens':
      body.max_completion_tokens = config.maxOutputTokens;
      break;
    case 'none':
    default:
      break;
  }

  return body;
}

export class OpenAICompatibleAdapter implements LLMAdapter {
  constructor(private readonly transport: Transport | null = null) {}

  async complete(request: CompleteRequest): Promise<ParsedCompletion> {
    // Cheap local checks first: a missing model name must not cost a request.
    assertConfigured(request.config);
    const { endpoint } = requireEndpoint(request.config.baseUrl);
    const body = buildRequestBody(request.config, request.messages);

    const transport = request.transport ?? this.transport ?? getTransport();

    const response = await transport.send({
      url: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // The credential is attached here and nowhere else.
        Authorization: `Bearer ${request.config.apiKey}`,
      },
      body: JSON.stringify(body),
      // Never trust a caller-supplied number: the hard ceiling is applied here.
      timeoutMs: Math.max(1, Math.min(request.timeoutMs, LIMITS.providerCallTimeoutMs)),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (response.status < 200 || response.status >= 300) {
      throw classifyHttpStatus(response.status, {
        retryAfterSeconds: parseRetryAfter(response.headers['retry-after'] ?? null),
        providerHint: summarizeProviderText(response.bodyText),
        structuredMode: request.config.structuredMode,
      });
    }

    return parseCompletion(response.bodyText, response.headers['x-request-id'] ?? null);
  }
}

export function createAdapter(transport?: Transport): LLMAdapter {
  return new OpenAICompatibleAdapter(transport ?? null);
}
