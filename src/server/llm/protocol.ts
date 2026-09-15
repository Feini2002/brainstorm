/**
 * Chat completions protocol handling.
 *
 * Minimal acceptance requirements (docs/03_contracts/06_llm_pipeline.md §5):
 * `choices[0].message.content` must be a non-empty string and `finish_reason`
 * must not be `length`. Tool calls, refusals, multi-choice concatenation and
 * `reasoning_content` are all rejected rather than guessed at.
 */
import 'server-only';

import { AppError } from '@/domain/errors';
import type { RunUsage } from '@/domain/knowledge';

export interface ParsedCompletion {
  content: string;
  finishReason: string;
  usage: RunUsage | null;
  providerRequestId: string | null;
}

export class ProtocolError extends AppError {
  constructor(message: string) {
    super('PROVIDER_PROTOCOL', message);
    this.name = 'ProtocolError';
  }
}

export class TruncatedError extends AppError {
  constructor(message = '模型输出不完整，请缩小材料范围或提高输出上限') {
    super('PROVIDER_TRUNCATED', message);
    this.name = 'TruncatedError';
  }
}

export class RefusalError extends AppError {
  constructor(message = '模型拒绝生成该内容') {
    super('PROVIDER_REFUSAL', message);
    this.name = 'RefusalError';
  }
}

/**
 * The provider answered 2xx but carried no usable text.
 *
 * Its own code rather than a generic protocol error because the user-facing
 * consequence is different: the request was accepted and very likely billed, yet
 * there is nothing to apply. Reported, never wrapped into a successful empty
 * organize (T031-C04).
 */
export class EmptyOutputError extends AppError {
  constructor(message = '模型返回了空内容，本次没有可用的整理结果') {
    super('EMPTY_MODEL_OUTPUT', message);
    this.name = 'EmptyOutputError';
  }
}

const REFUSAL_PATTERNS = [
  /^\s*i (cannot|can't|won't|will not|am unable to)/iu,
  /^\s*i'm sorry,? but/iu,
  /^\s*(抱歉|对不起)[，,]?\s*(我)?(无法|不能|不便)/u,
  /^\s*我无法(满足|完成|提供)/u,
];

/** Parse a successful HTTP body into a validated completion. */
export function parseCompletion(bodyText: string, providerRequestId: string | null): ParsedCompletion {
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new ProtocolError('服务商返回的内容不是合法 JSON');
  }

  if (payload === null || typeof payload !== 'object') {
    throw new ProtocolError('服务商返回结构不符合 chat completions 协议');
  }

  const record = payload as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProtocolError('服务商返回缺少 choices');
  }
  if (choices.length > 1) {
    // The MVP never concatenates multiple choices; that would invent content.
    throw new ProtocolError('服务商返回了多个 choices，本版本只接受单一结果');
  }

  const choice = choices[0];
  if (choice === null || typeof choice !== 'object') {
    throw new ProtocolError('服务商返回的 choice 结构不合法');
  }
  const choiceRecord = choice as Record<string, unknown>;

  const finishReason = typeof choiceRecord.finish_reason === 'string' ? choiceRecord.finish_reason : '';

  const message = choiceRecord.message;
  if (message === null || typeof message !== 'object') {
    throw new ProtocolError('服务商返回缺少 message');
  }
  const messageRecord = message as Record<string, unknown>;

  if (messageRecord.refusal !== undefined && messageRecord.refusal !== null) {
    throw new RefusalError();
  }
  if (messageRecord.tool_calls !== undefined || messageRecord.function_call !== undefined) {
    throw new ProtocolError('服务商返回了工具调用，本版本不支持');
  }

  const content = messageRecord.content;
  if (typeof content !== 'string') {
    // `null` content is what a provider returns for a pure tool-call or a
    // reasoning-only reply; both are empty results for this application.
    throw new EmptyOutputError('服务商返回的 content 不是字符串');
  }
  if (content.trim().length === 0) {
    throw new EmptyOutputError();
  }

  if (finishReason === 'length') {
    throw new TruncatedError();
  }
  if (finishReason === 'content_filter') {
    throw new RefusalError('模型因内容策略拒绝生成');
  }

  if (REFUSAL_PATTERNS.some((pattern) => pattern.test(content))) {
    throw new RefusalError();
  }

  return {
    content,
    finishReason,
    usage: parseUsage(record.usage),
    providerRequestId,
  };
}

/** Only provider-reported, format-valid token counts; never a derived estimate. */
function parseUsage(raw: unknown): RunUsage | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const read = (key: string): number | null => {
    const value = record[key];
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  };
  const usage: RunUsage = {
    inputTokens: read('prompt_tokens'),
    outputTokens: read('completion_tokens'),
    totalTokens: read('total_tokens'),
  };
  if (usage.inputTokens === null && usage.outputTokens === null && usage.totalTokens === null) {
    return null;
  }
  return usage;
}

/**
 * Strip exactly one fence that wraps the whole content in ```json ... ```.
 *
 * Deliberately not a greedy "find the first brace" scan: text that merely
 * contains a JSON object inside prose must fail parsing rather than have a
 * fragment extracted from it.
 */
export function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/iu.exec(trimmed);
  if (match) return match[1].trim();
  return trimmed;
}

/** Guard against pathological nested structures before schema parsing. */
export function assertBoundedJsonShape(value: unknown, maxDepth = 12, maxNodes = 5000): void {
  let nodes = 0;
  const walk = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > maxNodes) throw new ProtocolError('模型输出结构过于庞大');
    if (depth > maxDepth) throw new ProtocolError('模型输出嵌套层级过深');
    if (Array.isArray(current)) {
      for (const entry of current) walk(entry, depth + 1);
      return;
    }
    if (current !== null && typeof current === 'object') {
      for (const entry of Object.values(current as Record<string, unknown>)) {
        walk(entry, depth + 1);
      }
    }
  };
  walk(value, 0);
}

/**
 * Parse model content into JSON.
 *
 * Only JSON.parse is used — never eval or a YAML/JS evaluation path, so a
 * response carrying executable content cannot run.
 */
export function parseModelJson(content: string): unknown {
  const stripped = stripCodeFence(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (error) {
    throw new StructuredParseError(
      `模型输出不是合法 JSON：${error instanceof Error ? error.message : '解析失败'}`,
    );
  }
  assertBoundedJsonShape(parsed);
  return parsed;
}

export class StructuredParseError extends AppError {
  constructor(message: string) {
    super('STRUCTURED_INVALID', message);
    this.name = 'StructuredParseError';
  }
}
