/**
 * Run ledger repository.
 *
 * Concurrency rests on two partial unique indexes, not on process variables:
 *   - idx_one_global_running      : at most one external call at a time
 *   - idx_one_active_organize     : at most one running organize per item
 *
 * Terminal writes are conditional on `state = 'running'` and on the input hash,
 * so a late provider response can never overwrite a run that recovery already
 * marked interrupted.
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import { AppError, type SafeError } from '@/domain/errors';
import type { RunDTO, RunKind, RunState, UUID } from '@/domain/knowledge';
import { RUN_COLUMNS, decodeRunRow } from './mappers';

export interface RegisterRunInput {
  id: UUID;
  requestKey: UUID;
  requestHash: string;
  kind: RunKind;
  subjectId: UUID | null;
  inputRevision: number | null;
  inputHash: string;
  configRevision: number;
  configSnapshotJson: string;
  candidateIds: UUID[];
  promptVersion: string;
  startedAt: string;
  deadlineAt: string;
  requestIntentHash: string;
  intentHashVersion: number;
}

export class RunBusyError extends AppError {
  constructor(message = '已有模型操作正在进行中，请等待完成') {
    super('RUN_BUSY', message);
    this.name = 'RunBusyError';
  }
}

export class RunKeyConflictError extends AppError {
  constructor(message = '同一个请求键已用于不同的操作内容') {
    super('RUN_KEY_CONFLICT', message);
    this.name = 'RunKeyConflictError';
  }
}

export function findRunByRequestKey(db: DatabaseSync, requestKey: UUID): RunDTO | null {
  const row = db
    .prepare(`SELECT ${RUN_COLUMNS} FROM ai_runs WHERE request_key = ?`)
    .get(requestKey) as Record<string, unknown> | undefined;
  return row ? decodeRunRow(row) : null;
}

export function findRunById(db: DatabaseSync, id: UUID): RunDTO | null {
  const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM ai_runs WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? decodeRunRow(row) : null;
}

export function getRun(db: DatabaseSync, id: UUID): RunDTO {
  const run = findRunById(db, id);
  if (!run) throw new AppError('NOT_FOUND', '运行记录不存在');
  return run;
}

/** Read the stored request hash for idempotent replay comparison. */
export function getRunRequestHash(db: DatabaseSync, requestKey: UUID): string | null {
  const row = db
    .prepare('SELECT request_hash FROM ai_runs WHERE request_key = ?')
    .get(requestKey) as { request_hash: string } | undefined;
  return row?.request_hash ?? null;
}

/** Request identity hash. Null on rows created before migration 002. */
export function getRunRequestIntentHash(db: DatabaseSync, requestKey: UUID): string | null {
  const row = db
    .prepare('SELECT request_intent_hash FROM ai_runs WHERE request_key = ?')
    .get(requestKey) as { request_intent_hash: string | null } | undefined;
  return row?.request_intent_hash ?? null;
}

/**
 * Read the stored *input* hash for a run id.
 *
 * Separate from `getRunRequestHash` (which is keyed by request key) and from the
 * `RunDTO` (which deliberately omits both hashes, since they are internal
 * bookkeeping rather than something the browser needs). Late-response handling
 * compares this value to prove the arriving response belongs to the input the row
 * was opened with.
 */
export function getRunInputHash(db: DatabaseSync, id: UUID): string | null {
  const row = db
    .prepare('SELECT input_hash FROM ai_runs WHERE id = ?')
    .get(id) as { input_hash: string } | undefined;
  return row?.input_hash ?? null;
}

/**
 * Raw diagnostics source for one run (T041).
 *
 * Returns the *untrusted* stored columns rather than a `RunDTO`: the diagnostics
 * view needs the recorded config snapshot, candidate ids and request count, none
 * of which belong on the browser-facing DTO. Reading them here keeps the SQL in
 * the repository layer so the service stays a pure transformation, and the
 * allow-listing happens in `src/domain/runDto.ts` where it can be unit tested
 * without a database.
 */
export interface RunDiagnosticsRow {
  id: string;
  kind: string;
  state: string;
  subjectId: string | null;
  promptVersion: string;
  attemptCount: number;
  resultRef: string | null;
  startedAt: string;
  finishedAt: string | null;
  configSnapshotJson: string | null;
  candidateIdsJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  usageJson: string | null;
}

export function findRunDiagnosticsRow(
  db: DatabaseSync,
  id: UUID,
): RunDiagnosticsRow | null {
  const row = db
    .prepare(
      `SELECT id, kind, state, subject_id, prompt_version, attempt_count, result_ref,
              started_at, finished_at, config_snapshot_json, candidate_ids_json,
              error_code, error_message, usage_json
         FROM ai_runs WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    kind: String(row.kind),
    state: String(row.state),
    subjectId: row.subject_id === null || row.subject_id === undefined ? null : String(row.subject_id),
    promptVersion: String(row.prompt_version),
    attemptCount: Number(row.attempt_count ?? 0),
    resultRef: row.result_ref === null || row.result_ref === undefined ? null : String(row.result_ref),
    startedAt: String(row.started_at),
    finishedAt:
      row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
    configSnapshotJson: optionalText(row.config_snapshot_json),
    candidateIdsJson: optionalText(row.candidate_ids_json),
    errorCode: optionalText(row.error_code),
    errorMessage: optionalText(row.error_message),
    usageJson: optionalText(row.usage_json),
  };
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Insert a running run. A UNIQUE violation means another external call is in
 * flight; it is mapped to RUN_BUSY, never to a 500.
 */
export function insertRunningRun(db: DatabaseSync, input: RegisterRunInput): void {
  try {
    db.prepare(
      `INSERT INTO ai_runs (
         id, request_key, request_hash, kind, subject_id, input_revision, input_hash,
         state, config_revision, config_snapshot_json, candidate_ids_json,
         result_ref, error_code, error_message, usage_json, prompt_version,
         attempt_count, started_at, deadline_at, finished_at,
         request_intent_hash, intent_hash_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, NULL, NULL, NULL, NULL, ?, 0, ?, ?, NULL, ?, ?)`,
    ).run(
      input.id,
      input.requestKey,
      input.requestHash,
      input.kind,
      input.subjectId,
      input.inputRevision,
      input.inputHash,
      input.configRevision,
      input.configSnapshotJson,
      JSON.stringify(input.candidateIds),
      input.promptVersion,
      input.startedAt,
      input.deadlineAt,
      input.requestIntentHash,
      input.intentHashVersion,
    );
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/u.test(error.message)) {
      throw new RunBusyError();
    }
    throw error;
  }
}

/**
 * Atomically reserve one attempt before issuing a provider request.
 * Returns the new attempt count, or null when the row is no longer running or
 * the attempt budget is exhausted.
 */
export function incrementAttemptCount(db: DatabaseSync, id: UUID): number | null {
  const result = db
    .prepare(
      `UPDATE ai_runs SET attempt_count = attempt_count + 1
        WHERE id = ? AND state = 'running' AND attempt_count < 2`,
    )
    .run(id);
  if (Number(result.changes) === 0) return null;
  const row = db.prepare('SELECT attempt_count FROM ai_runs WHERE id = ?').get(id) as
    | { attempt_count: number }
    | undefined;
  return row ? Number(row.attempt_count) : null;
}

export interface CompleteRunInput {
  id: UUID;
  inputHash: string;
  resultRef: UUID | null;
  usage: string | null;
  finishedAt: string;
}

/**
 * Commit a successful run. Conditional on state=running AND input hash, so a
 * recovered (interrupted) or conflicting run keeps its terminal state.
 */
export function completeRun(db: DatabaseSync, input: CompleteRunInput): number {
  const result = db
    .prepare(
      `UPDATE ai_runs
          SET state = 'succeeded', result_ref = ?, usage_json = ?, finished_at = ?,
              error_code = NULL, error_message = NULL
        WHERE id = ? AND state = 'running' AND input_hash = ?`,
    )
    .run(input.resultRef, input.usage, input.finishedAt, input.id, input.inputHash);
  return Number(result.changes);
}

/** Terminalize a run with a failure-like state, keeping its error for the user. */
export function finishRun(
  db: DatabaseSync,
  id: UUID,
  state: Extract<RunState, 'failed' | 'interrupted' | 'conflict'>,
  error: SafeError | null,
  finishedAt: string,
): number {
  const result = db
    .prepare(
      `UPDATE ai_runs
          SET state = ?, error_code = ?, error_message = ?, finished_at = ?
        WHERE id = ? AND state = 'running'`,
    )
    .run(state, error?.code ?? null, error?.message ?? null, finishedAt, id);
  return Number(result.changes);
}

/** Mark a run succeeded only when it is still running (replay of stored result). */
export function markSucceeded(
  db: DatabaseSync,
  id: UUID,
  resultRef: UUID | null,
  finishedAt: string,
): number {
  const result = db
    .prepare(
      `UPDATE ai_runs SET state = 'succeeded', result_ref = ?, finished_at = ?
        WHERE id = ? AND state = 'running'`,
    )
    .run(resultRef, finishedAt, id);
  return Number(result.changes);
}

/** Find runs that exceeded their lease and are still marked running. */
export function findExpiredRunningRuns(db: DatabaseSync, nowIso: string): RunDTO[] {
  const rows = db
    .prepare(`SELECT ${RUN_COLUMNS} FROM ai_runs WHERE state = 'running' AND deadline_at <= ?`)
    .all(nowIso) as Record<string, unknown>[];
  return rows.map(decodeRunRow);
}

/** Recover one expired run; only applies while it is still running. */
export function markInterrupted(db: DatabaseSync, id: UUID, finishedAt: string): number {
  const result = db
    .prepare(
      `UPDATE ai_runs
          SET state = 'interrupted', error_code = 'RUN_INTERRUPTED',
              error_message = '操作超过期限，已标记为中断', finished_at = ?
        WHERE id = ? AND state = 'running'`,
    )
    .run(finishedAt, id);
  return Number(result.changes);
}

/** Latest run for a subject (item), used by status derivation. */
export function findLatestRunForSubject(
  db: DatabaseSync,
  subjectId: UUID,
  kind: RunKind,
): RunDTO | null {
  const row = db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM ai_runs
        WHERE subject_id = ? AND kind = ?
        ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get(subjectId, kind) as Record<string, unknown> | undefined;
  return row ? decodeRunRow(row) : null;
}

export function findRunningRunForSubject(
  db: DatabaseSync,
  subjectId: UUID,
  kind: RunKind,
): RunDTO | null {
  const row = db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM ai_runs
        WHERE subject_id = ? AND kind = ? AND state = 'running'
        ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get(subjectId, kind) as Record<string, unknown> | undefined;
  return row ? decodeRunRow(row) : null;
}

export function countRunningRuns(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COUNT(*) AS total FROM ai_runs WHERE state = 'running'")
    .get() as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

export function findRunningRunAny(db: DatabaseSync): RunDTO | null {
  const row = db
    .prepare(`SELECT ${RUN_COLUMNS} FROM ai_runs WHERE state = 'running' LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  return row ? decodeRunRow(row) : null;
}

export function countRuns(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS total FROM ai_runs').get() as
    | { total: number }
    | undefined;
  return Number(row?.total ?? 0);
}
