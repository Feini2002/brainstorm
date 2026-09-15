/**
 * LLM call types (T031).
 *
 * Two snapshots exist on purpose and must not be fused:
 *
 *   - `LlmCallSnapshot`  — what one request needs, *including* the key. It is a
 *     local value that never leaves the call frame, never reaches the database
 *     and never appears in a DTO.
 *   - `ConfigSnapshot`   — what a run row records: origin, model, mode and
 *     budgets. No secret material can be represented by its shape.
 *
 * Keeping the secret on a type that only the adapter consults is what makes
 * "the key never lands in `ai_runs`" a structural fact rather than a convention.
 */
import 'server-only';

import { z } from 'zod';

import type { LlmConfig, StructuredMode, TokenField } from '@/domain/knowledge';

/** Everything one provider request needs. Never persisted, never serialized. */
export interface LlmCallSnapshot {
  adapter: LlmConfig['adapter'];
  baseUrl: string;
  model: string;
  structuredMode: StructuredMode;
  tokenField: TokenField;
  maxOutputTokens: number;
  /** Present only for the duration of the call. */
  apiKey: string;
}

/** Build the per-call snapshot from stored config plus the in-memory secret. */
export function callSnapshot(config: LlmConfig, apiKey: string): LlmCallSnapshot {
  return {
    adapter: config.adapter,
    baseUrl: config.baseUrl,
    model: config.model,
    structuredMode: config.structuredMode,
    tokenField: config.tokenField,
    maxOutputTokens: config.maxOutputTokens,
    apiKey,
  };
}

/**
 * The smallest schema worth asserting a connection against (T032-R02).
 *
 * One boolean field, required. A provider that answers with prose, with a
 * different shape, or with `true` as the string `"true"` fails this and is
 * reported as a format problem — not as an unreachable network.
 */
export const SMOKE_SCHEMA = z.strictObject({ ok: z.literal(true) });

export const SMOKE_INSTRUCTION =
  '你是连接测试。只输出一个 JSON 对象，不要解释、不要 Markdown 代码围栏。' +
  '对象必须且只能包含一个布尔字段 ok，值为 true。';

export function smokeMessages(): { role: 'system'; content: string }[] {
  return [{ role: 'system', content: SMOKE_INSTRUCTION }];
}
