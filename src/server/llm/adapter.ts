/**
 * OpenAI-compatible adapter.
 *
 * The only module that talks to a model provider. Business layers depend on
 * this interface, so adding another vendor later means adding an adapter, not
 * editing Inbox/Library/Graph/Mindmap/Flow.
 */
import 'server-only';

import type { LlmConfig } from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import { AppError } from '@/domain/errors';
import { getTransport, type Transport } from './transport';
import { requireEndpoint } from './endpointPolicy';
import { classifyHttpStatus, parseRetryAfter } from './providerErrors';
import { parseCompletion, type ParsedCompletion } from './protocol';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface CompleteRequest {
  /** Config snapshot captured at run registration; never the live settings row. */
  config: LlmConfig;
  /** Present only for the duration of this call; never logged or serialized. */
  apiKey: string;
  messages: ChatMessage[];
  /** Absolute deadline for this single provider request. */
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
  adapter: LlmConfig['adapter'];
  baseUrlOrigin: string;
  model: string;
  structuredMode: LlmConfig['structuredMode'];
  tokenField: LlmConfig['tokenField'];
  maxOutputTokens: number;
  schemaRepairEnabled: boolean;
}

export function configSnapshot(config: LlmConfig): ConfigSnapshot {
  const endpoint = requireEndpoint(config.baseUrl);
  return {
    adapter: config.adapter,
    baseUrlOrigin: endpoint.origin,
    model: config.model,
    structuredMode: config.structuredMode,
    tokenField: config.tokenField,
    maxOutputTokens: config.maxOutputTokens,
    schemaRepairEnabled: config.schemaRepairEnabled,
  };
}

export class ModelNotConfiguredError extends AppError {
  constructor(message = '尚未配置模型连接，请到设置页填写') {
    super('MODEL_NOT_CONFIGURED', message);
    this.name = 'ModelNotConfiguredError';
  }
}

export function assertConfigured(config: LlmConfig, apiKey: string | null): void {
  if (config.baseUrl.trim().length === 0 || config.model.trim().length === 0) {
    throw new ModelNotConfiguredError('模型配置不完整，请填写 Base URL 与模型名');
  }
  if (apiKey === null || apiKey.length === 0) {
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
 * `temperature` is deliberately omitted (models reject parameters they do not
 * support), only one token-limit field is ever sent, and `response_format` is
 * only added when the user explicitly selected JSON mode.
 */
export function buildRequestBody(config: LlmConfig, messages: ChatMessage[]): RequestBody {
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
    const { endpoint } = requireEndpoint(request.config.baseUrl);
    const body = buildRequestBody(request.config, request.messages);

    const transport = request.transport ?? this.transport ?? getTransport();

    const response = await transport.send({
      url: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify(body),
      timeoutMs: Math.max(1, Math.min(request.timeoutMs, LIMITS.providerCallTimeoutMs)),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (response.status < 200 || response.status >= 300) {
      throw classifyHttpStatus(response.status, {
        retryAfterSeconds: parseRetryAfter(response.headers['retry-after'] ?? null),
        providerHint: extractProviderHint(response.bodyText),
      });
    }

    return parseCompletion(response.bodyText, response.headers['x-request-id'] ?? null);
  }
}

/** Short provider message for the user; never the entire response body. */
function extractProviderHint(bodyText: string): string | undefined {
  if (bodyText.length === 0) return undefined;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === 'string' && message.length > 0) return message;
  } catch {
    // Non-JSON error bodies are summarized as a plain truncated string.
    return bodyText.slice(0, 200);
  }
  return undefined;
}

export function createAdapter(transport?: Transport): LLMAdapter {
  return new OpenAICompatibleAdapter(transport ?? null);
}
