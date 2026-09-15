/**
 * Read one run's diagnostics (T041).
 *
 * This is a *read*. It cannot change knowledge or a run, it cannot call a model
 * and it has no third-party telemetry — the only write it can cause is the same
 * idempotent lease recovery `GET /api/runs/:id` performs, so an expired run is
 * reported as interrupted instead of as an operation that is still working
 * (T041 negative requirement). Recovery is a local state transition; it issues no
 * provider request.
 *
 * Two boundaries are enforced here rather than trusted upstream:
 *
 *   - **Nothing secret-shaped is read back out of the snapshot.** The service
 *     picks an explicit allow-list of snapshot fields instead of spreading it, so
 *     a field added to `config_snapshot_json` later cannot arrive in the DTO by
 *     accident. The key is not merely filtered, it was never stored by design
 *     (`ConfigSnapshot` has no shape that can hold one — see `llm/types.ts`).
 *   - **Unknown stays unknown.** Usage the provider did not return is passed
 *     through as a null usage view, and the repair count is *derived from the
 *     recorded request count* rather than tracked a second time. A second counter
 *     would be a number that could disagree with the ledger.
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import { AppError, isErrorCode, isRetryable } from '@/domain/errors';
import { buildRunDiagnostics, type RunDiagnostics } from '@/domain/runDto';
import { findRunDiagnosticsRow, type RunDiagnosticsRow } from '@/server/repositories/runs';
import { recoverExpiredRuns } from '@/server/services/runs/recoverExpiredRuns';

/**
 * Snapshot fields this view is allowed to show.
 *
 * `baseUrlOrigin` is already origin-only at write time (`configSnapshot` calls
 * `requireEndpoint` and keeps the origin). Re-deriving it here would re-open the
 * door to echoing a full path, so the stored origin is used as-is.
 */
interface SnapshotView {
  model?: unknown;
  baseUrlOrigin?: unknown;
  structuredMode?: unknown;
  tokenField?: unknown;
}

function parseObject(json: string | null): Record<string, unknown> {
  if (json === null) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function snapshotView(row: RunDiagnosticsRow): SnapshotView {
  const raw = parseObject(row.configSnapshotJson);
  return {
    model: raw.model,
    baseUrlOrigin: raw.baseUrlOrigin,
    structuredMode: raw.structuredMode,
    tokenField: raw.tokenField,
  };
}

/**
 * Candidate ids, defensively.
 *
 * A malformed column degrades to "no candidates recorded" rather than throwing:
 * a diagnostics view that cannot render is worse than one that admits a gap, and
 * the count it would show is not load-bearing for any decision.
 */
function candidateIds(row: RunDiagnosticsRow): string[] {
  const parsed: unknown = (() => {
    if (row.candidateIdsJson === null) return [];
    try {
      return JSON.parse(row.candidateIdsJson);
    } catch {
      return [];
    }
  })();
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function usageInput(row: RunDiagnosticsRow): unknown {
  if (row.usageJson === null) return null;
  try {
    return JSON.parse(row.usageJson);
  } catch {
    return null;
  }
}

/**
 * The error as recorded.
 *
 * `error_code` and `error_message` are written by `finishRun`/`markInterrupted`
 * from a `SafeError`, which is contractually free of keys, provider bodies and
 * note text (T030). Retryability comes from the code registry rather than a
 * stored flag, so it cannot drift from the error contract.
 */
function errorInput(row: RunDiagnosticsRow): RunDiagnosticsInputError {
  if (row.errorCode === null) return null;
  return {
    code: row.errorCode,
    message: row.errorMessage ?? '这次运行以失败状态结束，没有留下可读的说明',
    retryable: isErrorCode(row.errorCode) ? isRetryable(row.errorCode) : false,
  };
}

type RunDiagnosticsInputError = { code: string; message: string; retryable: boolean } | null;

/**
 * Read diagnostics for a run, or throw `NOT_FOUND`.
 *
 * Recovery runs first so the reported state matches what the caller would get
 * from the run endpoint: a lease that has genuinely passed is interrupted, while
 * a healthy in-flight run is untouched.
 */
export function getRunDiagnostics(db: DatabaseSync, runId: string): RunDiagnostics {
  recoverExpiredRuns(db);

  const row = findRunDiagnosticsRow(db, runId);
  if (!row) throw new AppError('NOT_FOUND', '没有找到这次运行的记录');

  return buildRunDiagnostics({
    runId: row.id,
    kind: row.kind,
    state: row.state,
    promptVersion: row.promptVersion,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    attemptCount: row.attemptCount,
    resultRef: row.resultRef,
    subjectId: row.subjectId,
    usage: usageInput(row),
    config: snapshotView(row),
    candidateIds: candidateIds(row),
    error: errorInput(row),
  });
}
