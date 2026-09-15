/**
 * Run registration, idempotency and the global concurrency slot (T035).
 *
 * One module owns "may this request talk to a provider right now?", because the
 * contract gives every paid operation — connection test, organize, mindmap,
 * flow — a *single* shared slot. That is enforced by
 * `idx_one_global_running WHERE state='running'`, not by a process variable, so
 * two browser tabs cannot each start a paid call (T035-R03).
 *
 * Order inside the one `BEGIN IMMEDIATE` transaction, which is the whole point:
 *
 *   1. recover expired leases,  so a dead request does not block the slot forever
 *   2. look up the request key, so a replay is answered without a second call
 *   3. compare the fingerprint, so the same key with a different intent is 409
 *   4. insert the running row,  which is what occupies the slot
 *
 * The transaction commits *before* the caller issues any network request
 * (T035-R04). An insertion failure means the provider call count is zero.
 */
import 'server-only';

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { RunDTO, RunKind, UUID } from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import { addMilliseconds } from '@/domain/run';
import { canonicalJson } from '@/domain/canonicalJson';
import { hashSha256 } from '@/server/crypto/hash';
import { withTransaction } from '@/server/db/database';
import type { ConfigSnapshot } from '@/server/llm/adapter';
import {
  RunKeyConflictError,
  findRunByRequestKey,
  getRunRequestHash,
  insertRunningRun,
} from '@/server/repositories/runs';
import { nowIso } from '@/server/repositories/shared';
import { recoverExpiredRunsTx } from './recoverExpiredRuns';

/**
 * The request fingerprint (T035-R01).
 *
 * Every field that would change what the provider is asked to do participates:
 * the kind of operation, its target, the input revision, the resolved selection,
 * the user's own intent text, the config revision and the prompt version.
 *
 * The *values* are hashed, not the key: `fingerprint` produces a stable digest
 * that can be compared on replay, and the raw intent text never has to be stored
 * on the run row.
 */
export interface RunFingerprintInput {
  kind: RunKind;
  subjectId: UUID | null;
  inputRevision: number | null;
  inputHash: string;
  selectionItemIds?: readonly UUID[];
  intent?: string;
  configRevision: number;
  promptVersion: string;
}

export function runRequestHash(input: RunFingerprintInput): string {
  return hashSha256(
    canonicalJson({
      kind: input.kind,
      subjectId: input.subjectId,
      inputRevision: input.inputRevision,
      inputHash: input.inputHash,
      selectionItemIds: [...(input.selectionItemIds ?? [])],
      intent: input.intent ?? null,
      configRevision: input.configRevision,
      promptVersion: input.promptVersion,
    }),
  );
}

export interface RegisterRunInput extends RunFingerprintInput {
  requestKey: UUID;
  configSnapshot: ConfigSnapshot;
  candidateIds: readonly UUID[];
}

/**
 * What happened, from the caller's point of view.
 *
 * `replayed` covers *every* prior state, not just success: a finished run is
 * reported as its stored outcome and a failed run is reported as that same
 * failure. Neither path may issue a new paid request (T035-R02), and a failure
 * is never silently retried (T035-C05).
 */
export type RunDisposition = 'execute' | 'replayed' | 'replay_failed' | 'replay_in_flight';

export interface RegisterRunResult {
  run: RunDTO;
  disposition: RunDisposition;
  /** True when the caller must issue the provider request. */
  shouldExecute: boolean;
}

export function registerRun(db: DatabaseSync, input: RegisterRunInput): RegisterRunResult {
  const requestHash = runRequestHash(input);

  return withTransaction(db, () => {
    const now = nowIso();

    // 1. Leases that already expired stop occupying the slot.
    recoverExpiredRunsTx(db, now);

    // 2 + 3. Idempotency: same key, same intent => reuse; different => 409.
    const existing = findRunByRequestKey(db, input.requestKey);
    if (existing) {
      const storedHash = getRunRequestHash(db, input.requestKey);
      if (storedHash !== requestHash) throw new RunKeyConflictError();
      return { run: existing, disposition: classifyReplay(existing), shouldExecute: false };
    }

    // 4. Occupy the slot. A UNIQUE violation here is RUN_BUSY (mapped in the
    // repository), and because this insert failed the transaction, the count of
    // provider requests this registration caused is exactly zero.
    const id = randomUUID();
    const deadlineAt = addMilliseconds(now, LIMITS.operationDeadlineMs);

    insertRunningRun(db, {
      id,
      requestKey: input.requestKey,
      requestHash,
      kind: input.kind,
      subjectId: input.subjectId,
      inputRevision: input.inputRevision,
      inputHash: input.inputHash,
      configRevision: input.configRevision,
      configSnapshotJson: JSON.stringify(input.configSnapshot),
      candidateIds: [...input.candidateIds],
      promptVersion: input.promptVersion,
      startedAt: now,
      deadlineAt,
    });

    return {
      run: {
        id,
        kind: input.kind,
        subjectId: input.subjectId,
        state: 'running',
        startedAt: now,
        deadlineAt,
        finishedAt: null,
        resultRef: null,
        error: null,
        attemptCount: 0,
        promptVersion: input.promptVersion,
        usage: null,
      },
      disposition: 'execute',
      shouldExecute: true,
    };
  });
}

export interface RunReplayLookup {
  requestKey: UUID;
  requestHash: string;
}

/**
 * Resolve an existing run for this request key *before* the caller inspects any
 * mutable state.
 *
 * This exists because of a specific contract rule (docs/03_contracts/06 §2): a
 * replay must not re-check the item revision, the config or the key, all of which
 * may legitimately have changed since the original request. An organize run
 * bumps the item's revision when it commits, so re-validating `expectedRevision`
 * before looking up the key would turn every intended replay into a spurious
 * conflict.
 *
 * The check here is read-only and therefore not authoritative — a concurrent
 * writer can still slip in. `registerRun` repeats it inside the transaction that
 * occupies the slot, and that repetition is what actually enforces uniqueness.
 * This lookup only guarantees that the *validation the caller performs next* is
 * skipped in the replay case.
 */
export function findReplayRun(db: DatabaseSync, lookup: RunReplayLookup): RunDTO | null {
  const existing = findRunByRequestKey(db, lookup.requestKey);
  if (!existing) return null;
  const storedHash = getRunRequestHash(db, lookup.requestKey);
  // Same key aimed at different work is a conflict, and it is reported here so a
  // caller cannot "discover" it only after doing retrieval work.
  if (storedHash !== lookup.requestHash) throw new RunKeyConflictError();
  return existing;
}

/**
 * Map a stored run to what the caller may do next.
 *
 * A `running` row replay is deliberately *not* treated as "your request is
 * executing": it is either this same request still in flight or a lease awaiting
 * recovery, and the caller must not start a second paid call either way.
 */
function classifyReplay(run: RunDTO): RunDisposition {
  switch (run.state) {
    case 'succeeded':
      return 'replayed';
    case 'failed':
    case 'interrupted':
    case 'conflict':
      return 'replay_failed';
    case 'running':
    default:
      return 'replay_in_flight';
  }
}
