/**
 * Connection test (T032).
 *
 * The point of this service is that it is *not* a ping endpoint. It uses the
 * same adapter, the same endpoint policy and the same JSON modes a real organize
 * run uses, and it asserts the smallest schema worth asserting. A test that
 * returned a hard-coded success would keep the button green while every real run
 * failed (T032-R01).
 *
 * What it deliberately does not do:
 *   - save anything, or send any user note (T032-R04)
 *   - repair structure or retry (T032-R05): one request, one budget
 *   - claim that a green result means long jobs will work (T032-R06)
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import { AppError, type SafeError } from '@/domain/errors';
import { LIMITS } from '@/domain/limits';
import type { UUID } from '@/domain/knowledge';
import { canonicalJson } from '@/domain/canonicalJson';
import { parseModelJson } from '@/server/llm/protocol';
import { hashSha256 } from '@/server/crypto/hash';
import { OpenAICompatibleAdapter, configSnapshot, type LLMAdapter } from '@/server/llm/adapter';
import { SMOKE_SCHEMA, callSnapshot, smokeMessages } from '@/server/llm/types';
import type { LlmConfig } from '@/domain/knowledge';
import {
  completeRun,
  finishRun,
  incrementAttemptCount,
} from '@/server/repositories/runs';
import { nowIso } from '@/server/repositories/shared';
import { nextStepFor } from '@/server/observability/redaction';
import { registerRun } from './runs/registerRun';

/** Bumped when the smoke instruction changes; recorded on the run (T033-R06). */
export const CONNECTION_TEST_PROMPT_VERSION = 'connection-v1';

export interface ConnectionTestInput {
  requestKey: UUID;
  /** The draft as submitted; `schemaRepairEnabled` is ignored by design. */
  config: LlmConfig;
  apiKey: string;
  /** Settings revision the key and base URL were resolved against. */
  configRevision: number;
  /** Injected in tests; production builds the real adapter. */
  adapter?: LLMAdapter;
}

export interface ConnectionTestResult {
  runId: UUID;
  /** A valid, non-empty completion came back: the transport worked. */
  connected: boolean;
  /** The completion also satisfied the required `{ok:true}` shape. */
  replyAccepted: boolean;
  latencyMs: number;
  model: string;
  message: string;
}

/** `null` when the reply satisfies `{ok:true}`; otherwise a safe description. */
export function checkSmokeReply(content: string): SafeError | null {
  try {
    SMOKE_SCHEMA.parse(parseModelJson(content));
    return null;
  } catch (error) {
    return {
      code: 'STRUCTURED_INVALID',
      message:
        '模型连上了，但返回的不是要求的 {"ok":true}：' +
        `${error instanceof Error ? error.message : '格式不符合'}。` +
        '可以换一个模型，或改用别的结构化档位再试。',
      retryable: false,
    };
  }
}

/**
 * The request fingerprint.
 *
 * Derived from the *draft* (origin, model, modes) rather than the secret itself:
 * the same key reused for a genuinely different draft is a conflict, while the
 * raw key never becomes part of a stored hash. Key presence participates as a
 * boolean — "test with a key" and "test without" are different intents even for
 * the same destination.
 */
export function connectionTestRequestHash(input: {
  baseUrl: string;
  model: string;
  structuredMode: string;
  tokenField: string;
  maxOutputTokens: number;
  hasKey: boolean;
}): string {
  return hashSha256(canonicalJson(input));
}

export async function runConnectionTest(
  db: DatabaseSync,
  input: ConnectionTestInput,
): Promise<ConnectionTestResult> {
  const requestHash = connectionTestRequestHash({
    baseUrl: input.config.baseUrl.trim(),
    model: input.config.model.trim(),
    structuredMode: input.config.structuredMode,
    tokenField: input.config.tokenField,
    maxOutputTokens: input.config.maxOutputTokens,
    hasKey: input.apiKey.length > 0,
  });

  // A test never persists the draft, and never enables repair: one request only.
  const callConfig: LlmConfig = { ...input.config, schemaRepairEnabled: false };

  const registered = registerRun(db, {
    requestKey: input.requestKey,
    kind: 'connection_test',
    subjectId: null,
    inputRevision: null,
    inputHash: requestHash,
    configRevision: input.configRevision,
    promptVersion: CONNECTION_TEST_PROMPT_VERSION,
    configSnapshot: configSnapshot(callSnapshot(callConfig, input.apiKey)),
    candidateIds: [],
  });

  if (!registered.shouldExecute) {
    const prior = registered.run;
    if (prior.state === 'running') {
      // The slot is held by this same request (or a lease awaiting recovery);
      // either way no second paid request may start (T035-R02).
      throw new AppError('RUN_BUSY', '这次测试正在运行中，请等待它结束');
    }
    // Same key, same intent, already finished: report the stored outcome and
    // issue no second paid request. This is the double-click case.
    return {
      runId: prior.id,
      connected: prior.state === 'succeeded',
      replyAccepted: prior.state === 'succeeded' && prior.error === null,
      latencyMs: 0,
      model: input.config.model,
      message:
        prior.state === 'succeeded'
          ? '这次测试与上一次完全相同，直接复用结果，没有再次请求。'
          : `上一次测试没有成功：${prior.error?.message ?? '未知原因'}`,
    };
  }

  const runId = registered.run.id;
  const adapter = input.adapter ?? new OpenAICompatibleAdapter();

  // Reserve the single attempt before the network call, never after (T032-R05).
  if (incrementAttemptCount(db, runId) === null) {
    throw new AppError('RUN_BUSY', '这次测试已经结束或超出尝试次数，请重新点击测试');
  }

  const startedAt = Date.now();
  try {
    const completion = await adapter.complete({
      config: callSnapshot(callConfig, input.apiKey),
      messages: smokeMessages(),
      // One request, fifteen seconds, no repair and no retry (T032-R05).
      timeoutMs: LIMITS.connectionTestTimeoutMs,
    });
    const latencyMs = Date.now() - startedAt;

    // A reply that arrived but does not satisfy the contract is a *format*
    // failure, reported as such — never as "the network is down" (T032-C04).
    const formatError = checkSmokeReply(completion.content);
    if (formatError === null) {
      completeRun(db, {
        id: runId,
        inputHash: requestHash,
        resultRef: null,
        usage: completion.usage === null ? null : JSON.stringify(completion.usage),
        finishedAt: nowIso(),
      });
      return {
        runId,
        connected: true,
        replyAccepted: true,
        latencyMs,
        model: input.config.model,
        message: `连接与 JSON 格式都通过，用时 ${latencyMs} ms。`,
      };
    }

    // The provider answered and was paid, so the run is `succeeded` in the
    // ledger while carrying the format problem as its error: "we reached it and
    // did not get what the contract needs" is not the same as "we could not
    // reach it", and the attempt count must not invite another request.
    completeRun(db, {
      id: runId,
      inputHash: requestHash,
      resultRef: null,
      usage: completion.usage === null ? null : JSON.stringify(completion.usage),
      finishedAt: nowIso(),
    });
    db.prepare(
      `UPDATE ai_runs SET error_code = ?, error_message = ?
        WHERE id = ? AND state = 'succeeded'`,
    ).run(formatError.code, formatError.message, runId);

    return {
      runId,
      connected: true,
      replyAccepted: false,
      latencyMs,
      model: input.config.model,
      message: formatError.message,
    };
  } catch (error) {
    const safe: SafeError =
      error instanceof AppError
        ? error.toSafeError()
        : { code: 'INTERNAL', message: '本地服务出现未预期错误', retryable: false };
    finishRun(db, runId, 'failed', safe, nowIso());
    // The message names the next thing to check; it never invents a balance.
    throw new AppError(
      safe.code,
      `${safe.message}。下一步：${nextStepFor(safe.code)}`,
      safe.fieldErrors,
    );
  }
}

export { finishRun };
