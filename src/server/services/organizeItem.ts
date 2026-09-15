/**
 * Organize orchestration (T036) with structured parsing (T037) and application
 * (T038/T039).
 *
 * The transaction boundaries are the design, so they are stated up front:
 *
 *   1. **register** (short transaction) — request key check, lease recovery, slot
 *      occupancy, snapshot of the input revision and candidates;
 *   2. **provider call** (no transaction) — the item's own row is not locked, so
 *      saving another note, editing another item or rendering a page all keep
 *      working while a paid call is in flight (T036-R02). A provider call inside
 *      a transaction would freeze the whole local app;
 *   3. **commit** (short transaction) — re-read the item, re-check `revision`,
 *      confirm the run is still `running`, then write metadata, tags, relations,
 *      item status, dataset revision and the run's terminal state together
 *      (T036-R04). Any failure here rolls the whole thing back and the raw text
 *      is untouched (T036-R01).
 *
 * A late response finds the run no longer `running` (recovery or a conflicting
 * run got there first) and is discarded — the terminal state never revives
 * (T040-R03).
 */
import 'server-only';

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { AppError, type SafeError } from '@/domain/errors';
import { LIMITS } from '@/domain/limits';
import type { ItemDTO, UUID } from '@/domain/knowledge';
import { ORGANIZE_PROMPT_VERSION } from '@/domain/view';
import { attemptTimeoutMs, canStartAttempt } from '@/domain/run';
import { canonicalJson } from '@/domain/canonicalJson';
import { hashSha256 } from '@/server/crypto/hash';
import { bumpDatasetRevision, withTransaction } from '@/server/db/database';
import { OpenAICompatibleAdapter, assertConfigured, configSnapshot, type LLMAdapter } from '@/server/llm/adapter';
import { buildRepairMessages, parseStructured } from '@/server/llm/parseStructured';
import { buildOrganizeMessages } from '@/server/llm/prompts/organize';
import { REPAIR_INSTRUCTION } from '@/domain/schemas/organize';
import type { LlmCallSnapshot } from '@/server/llm/types';
import {
  completeRun,
  finishRun,
  getRun,
  getRunInputHash,
  incrementAttemptCount,
} from '@/server/repositories/runs';
import { findItemRow, getItem, rowToItem } from '@/server/repositories/items';
import { nowIso } from '@/server/repositories/shared';
import { logSafe } from '@/server/observability/redaction';
import { applyOrganizeMetadata } from './applyOrganizeMetadata';
import { applyRelationSuggestions } from './applyRelationSuggestions';
import { findCandidates } from './findCandidates';
import { findReplayRun, registerRun, runRequestHash } from './runs/registerRun';
import { syncItemStatus } from './status';

export interface OrganizeInput {
  requestKey: UUID;
  itemId: UUID;
  expectedRevision: number;
  config: LlmCallSnapshot;
  configRevision: number;
  /**
   * Whether one format repair may be attempted. This is an operation policy, not
   * part of a single request, which is why it is not on `LlmCallSnapshot`.
   */
  schemaRepairEnabled: boolean;
  /** Injected in tests; production builds the real adapter. */
  adapter?: LLMAdapter;
}

export interface OrganizeResult {
  runId: UUID;
  itemId: UUID;
  state: 'succeeded' | 'conflict' | 'failed';
  item: ItemDTO | null;
  applied: string[];
  skipped: string[];
  warnings: string[];
  relationsCreated: number;
  /** Replay-only: the stored outcome, with no new provider request. */
  replayed: boolean;
}

/**
 * Identity of what the model will be shown.
 *
 * Deliberately built from *content* (`rawVersion`) and not from the item's
 * `revision`. `revision` is the optimistic-concurrency token, and an organize run
 * bumps it as part of committing, so including it here would make every intended
 * replay of the same request key look like a different intent. The concurrency
 * token is still recorded separately as the run's `input_revision`, where it
 * belongs (docs/03_contracts/06_llm_pipeline.md §2).
 */
export function organizeInputHash(input: {
  targetId: UUID;
  rawVersion: number;
  candidateIds: readonly UUID[];
  promptVersion: string;
  structuredMode: string;
  model: string;
}): string {
  return hashSha256(canonicalJson(input));
}

export async function organizeItem(
  db: DatabaseSync,
  input: OrganizeInput,
): Promise<OrganizeResult> {
  /**
   * Configuration completeness is checked before anything else, because it is
   * the one failure that must cost *nothing*: no run row, no slot, no request.
   * It is also checked before `configSnapshot`, which needs a parseable endpoint
   * and would otherwise report an unconfigured model as a bad URL.
   */
  assertConfigured(input.config);

  const target = getItem(db, input.itemId);
  const candidates = findCandidates(db, target.id);

  const inputHash = organizeInputHash({
    targetId: target.id,
    rawVersion: target.rawVersion,
    candidateIds: candidates.candidateIds,
    promptVersion: ORGANIZE_PROMPT_VERSION,
    structuredMode: input.config.structuredMode,
    model: input.config.model,
  });

  const fingerprint = {
    kind: 'organize' as const,
    subjectId: target.id,
    inputRevision: input.expectedRevision,
    inputHash,
    configRevision: input.configRevision,
    promptVersion: ORGANIZE_PROMPT_VERSION,
  };

  /**
   * A replay is resolved *before* the revision check.
   *
   * This ordering is the contract's, and it is not cosmetic: the previous run
   * committed a new revision, so validating `expectedRevision` first would reject
   * the very request the user is re-sending (docs/03_contracts/06 §2 — "相同键…
   * 不重新检查已经可能改变的Item版本").
   */
  const replay = findReplayRun(db, {
    requestKey: input.requestKey,
    requestHash: runRequestHash(fingerprint),
  });
  if (replay) return replayOutcome(db, replay.id);

  if (target.revision !== input.expectedRevision) {
    throw new AppError('REVISION_CONFLICT', '该记录已被更新，请重新载入后再整理');
  }

  // ---- Step 1: register (short transaction; no network inside) -------------
  const registered = registerRun(db, {
    ...fingerprint,
    requestKey: input.requestKey,
    configSnapshot: configSnapshot(input.config),
    candidateIds: candidates.candidateIds,
  });

  // `registerRun` repeats the replay lookup inside its transaction, so this is
  // the "already finished, same intent" case arriving from a fresh page load.
  if (!registered.shouldExecute) {
    return replayOutcome(db, registered.run.id);
  }

  const runId = registered.run.id;

  // ---- Step 2: provider call (no transaction held) -------------------------
  let content: string;
  let usageJson: string | null;
  try {
    const attempt = runAttempt(db, runId, registered.run.startedAt);
    const first = await callModel(db, input, target, candidates, attempt);
    content = first.content;
    usageJson = first.usageJson;
  } catch (error) {
    throw terminalizeFailure(db, runId, error);
  }

  let outcome = parseStructured({
    content,
    context: { targetId: target.id, candidateIds: candidates.candidateIds },
  });

  // One repair, only for a complete-but-malformed answer, only with time left.
  if (!outcome.ok && outcome.repairable && input.schemaRepairEnabled) {
    const repair = await attemptRepair(db, runId, input, content, outcome.detail ?? '');
    if (repair !== null) {
      content = repair.content;
      usageJson = mergeUsage(usageJson, repair.usageJson);
      outcome = parseStructured({
        content,
        context: { targetId: target.id, candidateIds: candidates.candidateIds },
      });
    }
  }

  if (!outcome.ok || !outcome.value) {
    throw terminalizeFailure(db, runId, new AppError(
      outcome.error?.code ?? 'STRUCTURED_INVALID',
      outcome.error?.message ?? '模型返回的内容无法使用',
    ));
  }

  // ---- Step 3: commit (one short transaction) -----------------------------
  return commitOrganize(db, {
    runId,
    inputHash,
    target,
    expectedRevision: input.expectedRevision,
    organized: outcome.value,
    candidateIds: candidates.candidateIds,
    candidates: candidates.candidates,
    usageJson,
    retrievalNotes: candidates.notes,
  });
}

interface AttemptInfo {
  startedAt: string;
  deadlineAt: string;
  attemptCount: number;
}

function runAttempt(db: DatabaseSync, runId: UUID, startedAt: string): AttemptInfo {
  const run = getRun(db, runId);
  const count = incrementAttemptCount(db, runId);
  if (count === null) {
    // Either the run already terminalized or its attempt budget is spent; in
    // both cases issuing another paid request is forbidden.
    throw new AppError('RUN_INTERRUPTED', '这次整理已经结束或超出尝试次数，请重新发起');
  }
  return { startedAt, deadlineAt: run.deadlineAt, attemptCount: count };
}

async function callModel(
  db: DatabaseSync,
  input: OrganizeInput,
  target: ItemDTO,
  candidates: ReturnType<typeof findCandidates>,
  attempt: AttemptInfo,
): Promise<{ content: string; usageJson: string | null }> {
  const adapter = input.adapter ?? new OpenAICompatibleAdapter();

  const prompt = buildOrganizeMessages({
    targetId: target.id,
    rawText: target.rawText,
    title: target.title,
    keywords: target.keywords,
    tags: target.tags,
    knownTags: knownTagLabels(db),
    candidates: candidates.candidates.map((brief) => ({
      id: brief.id,
      title: brief.title,
      summary: brief.summary,
      tags: brief.tags,
      evidence: brief.evidenceSnippets.map((snippet) => snippet.text),
    })),
    noCandidatesReason:
      candidates.candidates.length === 0 && candidates.notes.length > 0
        ? candidates.notes.join('；')
        : undefined,
  });

  // The budget is what is left of the operation, not a fresh 45 seconds.
  const timeoutMs = attemptTimeoutMs(
    LIMITS.providerCallTimeoutMs,
    attempt.startedAt,
    LIMITS.operationDeadlineMs,
    Date.now(),
  );
  if (timeoutMs <= 0) {
    throw new AppError('PROVIDER_TIMEOUT', '本次操作已经没有剩余时间');
  }

  const completion = await adapter.complete({
    config: input.config,
    messages: prompt.messages,
    timeoutMs,
  });

  return {
    content: completion.content,
    usageJson: completion.usage === null ? null : JSON.stringify(completion.usage),
  };
}

async function attemptRepair(
  db: DatabaseSync,
  runId: UUID,
  input: OrganizeInput,
  previousContent: string,
  detail: string,
): Promise<{ content: string; usageJson: string | null } | null> {
  const run = getRun(db, runId);
  const decision = canStartAttempt({
    attemptCount: run.attemptCount,
    maxAttempts: LIMITS.maxAttemptCount,
    operationStartedAt: run.startedAt,
    operationDeadlineMs: LIMITS.operationDeadlineMs,
    now: Date.now(),
  });
  if (!decision.allowed) return null;

  const count = incrementAttemptCount(db, runId);
  if (count === null) return null;

  try {
    const adapter = input.adapter ?? new OpenAICompatibleAdapter();
    const timeoutMs = attemptTimeoutMs(
      LIMITS.providerCallTimeoutMs,
      run.startedAt,
      LIMITS.operationDeadlineMs,
      Date.now(),
    );
    if (timeoutMs <= 0) return null;

    const completion = await adapter.complete({
      config: input.config,
      messages: buildRepairMessages(REPAIR_INSTRUCTION, previousContent, detail),
      timeoutMs,
    });
    return {
      content: completion.content,
      usageJson: completion.usage === null ? null : JSON.stringify(completion.usage),
    };
  } catch (error) {
    // A failed repair is not a new failure class: the original parse failure
    // stands, and the run keeps the first error classification.
    logSafe({ level: 'warn', message: 'organize.repair_failed', runId, code: safeCode(error) });
    return null;
  }
}

interface CommitInput {
  runId: UUID;
  inputHash: string;
  target: ItemDTO;
  expectedRevision: number;
  organized: NonNullable<ReturnType<typeof parseStructured>['value']>;
  candidateIds: readonly UUID[];
  candidates: ReturnType<typeof findCandidates>['candidates'];
  usageJson: string | null;
  retrievalNotes: string[];
}

function commitOrganize(db: DatabaseSync, input: CommitInput): OrganizeResult {
  const now = nowIso();
  const warnings: string[] = [];

  try {
    const result = withTransaction(db, () => {
      // Late responses are discarded: if recovery already interrupted this run,
      // or another organizer took over, this response must not write anything.
      const run = getRun(db, input.runId);
      const liveHash = getRunInputHash(db, input.runId);
      if (run.state !== 'running' || liveHash !== input.inputHash) {
        return { kind: 'discarded' as const };
      }

      const row = findItemRow(db, input.target.id);
      if (!row) {
        // The user deleted the item while the model was working. The decision is
        // respected: no item is re-inserted, and no field is written.
        finishRun(
          db,
          input.runId,
          'conflict',
          {
            code: 'SOURCE_CHANGED',
            message: '整理期间这条记录已被删除，结果没有写入',
            retryable: false,
          },
          now,
        );
        return { kind: 'deleted' as const };
      }

      const live = rowToItem(row);
      if (live.revision !== input.expectedRevision || live.rawVersion !== input.target.rawVersion) {
        // The user edited the item while the model was working. A whole-run
        // conflict — never a per-field merge.
        finishRun(
          db,
          input.runId,
          'conflict',
          {
            code: 'SOURCE_CHANGED',
            message: '整理期间这条记录被修改，旧结果没有覆盖你的新版本',
            retryable: true,
          },
          now,
        );
        return { kind: 'changed' as const };
      }

      const applied = applyOrganizeMetadata({
        db,
        current: live,
        organized: input.organized,
        expectedRevision: input.expectedRevision,
        // The text version the model actually read, not the row's current one.
        expectedRawVersion: input.target.rawVersion,
        now,
      });

      const relationResult = applyRelationSuggestions({
        db,
        runId: input.runId,
        target: { id: live.id, rawText: live.rawText, rawVersion: live.rawVersion },
        candidates: input.candidates.map((brief) => ({ id: brief.id })),
        suggestions: input.organized.relations,
        now,
      });

      completeRun(db, {
        id: input.runId,
        inputHash: input.inputHash,
        resultRef: live.id,
        usage: input.usageJson,
        finishedAt: now,
      });

      bumpDatasetRevision(db);
      syncItemStatus(db, live.id, Date.parse(now));

      return { kind: 'committed' as const, applied, relationResult };
    });

    if (result.kind === 'discarded') {
      return {
        runId: input.runId,
        itemId: input.target.id,
        state: 'conflict',
        item: null,
        applied: [],
        skipped: [],
        warnings: ['这次响应到达时运行已经结束，结果被丢弃，没有写入任何内容'],
        relationsCreated: 0,
        replayed: false,
      };
    }

    if (result.kind === 'deleted') {
      return {
        runId: input.runId,
        itemId: input.target.id,
        state: 'conflict',
        item: null,
        applied: [],
        skipped: [],
        warnings: ['这条记录已被删除，整理结果没有写回'],
        relationsCreated: 0,
        replayed: false,
      };
    }

    if (result.kind === 'changed') {
      return {
        runId: input.runId,
        itemId: input.target.id,
        state: 'conflict',
        item: getItem(db, input.target.id),
        applied: [],
        skipped: [],
        warnings: ['整理期间记录被修改，本次没有覆盖任何字段'],
        relationsCreated: 0,
        replayed: false,
      };
    }

    if (result.applied.nothingApplied) {
      warnings.push('所有整理字段都由你手动维护，本次没有覆盖任何字段');
    }
    for (const note of input.retrievalNotes) warnings.push(note);
    if (result.relationResult.droppedReasons.length > 0) {
      warnings.push(
        `模型给出 ${input.organized.relations.length} 条关系建议，实际采纳 ${result.relationResult.created.length + result.relationResult.updated.length} 条`,
      );
    }

    return {
      runId: input.runId,
      itemId: input.target.id,
      state: 'succeeded',
      item: getItem(db, input.target.id),
      applied: result.applied.applied,
      skipped: result.applied.skipped,
      warnings,
      relationsCreated: result.relationResult.created.length,
      replayed: false,
    };
  } catch (error) {
    // The transaction rolled back: no partial organize can be observed. The run
    // is then failed in its own short transaction so the ledger stays truthful.
    const safe = safeError(error);
    finishRun(db, input.runId, 'failed', safe, nowIso());
    throw new AppError(safe.code, safe.message);
  }
}

/** Report a stored run without issuing a new provider request. */
function replayOutcome(db: DatabaseSync, runId: UUID): OrganizeResult {
  const run = getRun(db, runId);
  if (run.state === 'running') {
    throw new AppError('RUN_BUSY', '这次整理还在进行中，请等待它结束');
  }

  const item = run.subjectId === null ? null : getItem(db, run.subjectId);
  const succeeded = run.state === 'succeeded';

  return {
    runId,
    itemId: run.subjectId ?? '',
    state: succeeded ? 'succeeded' : run.state === 'conflict' ? 'conflict' : 'failed',
    item: succeeded ? item : null,
    applied: [],
    skipped: [],
    warnings: [
      succeeded
        ? '这次整理与上一次请求完全相同，直接复用已有结果，没有重新请求模型'
        : `上一次整理没有成功：${run.error?.message ?? '未知原因'}`,
    ],
    relationsCreated: 0,
    replayed: true,
  };
}

/** Terminalize a run and rethrow a user-facing error that keeps the raw text. */
function terminalizeFailure(db: DatabaseSync, runId: UUID, error: unknown): AppError {
  const safe = safeError(error);
  finishRun(db, runId, 'failed', safe, nowIso());
  return new AppError(safe.code, safe.message);
}

function safeError(error: unknown): SafeError {
  if (error instanceof AppError) return error.toSafeError();
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : '本地服务出现未预期错误',
    retryable: false,
  };
}

function safeCode(error: unknown): string {
  return error instanceof AppError ? error.code : 'INTERNAL';
}

/** Merge usage from the first attempt and the repair attempt, summing tokens. */
function mergeUsage(first: string | null, second: string | null): string | null {
  if (first === null) return second;
  if (second === null) return first;
  const a = JSON.parse(first) as Record<string, number | null>;
  const b = JSON.parse(second) as Record<string, number | null>;
  const add = (key: string): number | null => {
    const left = a[key];
    const right = b[key];
    if (typeof left !== 'number' && typeof right !== 'number') return null;
    return (typeof left === 'number' ? left : 0) + (typeof right === 'number' ? right : 0);
  };
  return JSON.stringify({
    inputTokens: add('inputTokens'),
    outputTokens: add('outputTokens'),
    totalTokens: add('totalTokens'),
  });
}

/**
 * A bounded slice of the existing tag dictionary. Enough for the model to reuse
 * spelling, and small enough that it cannot become a growing prompt (T033-R04).
 */
function knownTagLabels(db: DatabaseSync): string[] {
  const rows = db
    .prepare('SELECT label FROM tags ORDER BY label ASC LIMIT ?')
    .all(60) as { label: string }[];
  return rows.map((row) => row.label);
}

export { randomUUID };
