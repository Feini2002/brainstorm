/**
 * Run registration, idempotency and the global concurrency slot (T035).
 *
 * Request identity (`requestIntentHash`) is what the user submitted. The
 * execution snapshot (`inputHash` / `request_hash`) is what the first execution
 * actually used. A replay looks up identity first and must not re-read candidates
 * or settings to decide who the request is.
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
  getRunRequestIntentHash,
  insertRunningRun,
} from '@/server/repositories/runs';
import { nowIso } from '@/server/repositories/shared';
import { recoverExpiredRunsTx } from './recoverExpiredRuns';

export const INTENT_HASH_VERSION = 1;

export interface RunIntentInput {
  kind: RunKind;
  subjectId: UUID | null;
  expectedRevision: number | null;
  selection?: unknown;
  intent?: string | null;
  promptVersion: string;
}

export function runIntentHash(input: RunIntentInput): string {
  return hashSha256(
    canonicalJson({
      v: INTENT_HASH_VERSION,
      kind: input.kind,
      subjectId: input.subjectId,
      expectedRevision: input.expectedRevision,
      selection: input.selection ?? null,
      intent: input.intent ?? null,
      promptVersion: input.promptVersion,
    }),
  );
}

/**
 * Execution fingerprint: materials, model and prompt actually used the first time.
 * Stored as `request_hash` / `input_hash` for write-back checks. Not used to
 * decide whether a later delivery is "the same request".
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
  requestIntentHash?: string;
  configSnapshot: ConfigSnapshot;
  candidateIds: readonly UUID[];
}

export type RunDisposition = 'execute' | 'replayed' | 'replay_failed' | 'replay_in_flight';

export interface RegisterRunResult {
  run: RunDTO;
  disposition: RunDisposition;
  shouldExecute: boolean;
  identityUnconfirmed: boolean;
}

export function registerRun(db: DatabaseSync, input: RegisterRunInput): RegisterRunResult {
  const requestHash = runRequestHash(input);
  const requestIntentHash =
    input.requestIntentHash ??
    runIntentHash({
      kind: input.kind,
      subjectId: input.subjectId,
      expectedRevision: input.inputRevision,
      intent: input.intent ?? null,
      promptVersion: input.promptVersion,
      selection: input.selectionItemIds ?? null,
    });

  return withTransaction(db, () => {
    const now = nowIso();
    recoverExpiredRunsTx(db, now);

    const existing = findRunByRequestKey(db, input.requestKey);
    if (existing) {
      const storedIntent = getRunRequestIntentHash(db, input.requestKey);
      if (storedIntent && storedIntent !== requestIntentHash) {
        throw new RunKeyConflictError();
      }
      return {
        run: existing,
        disposition: classifyReplay(existing),
        shouldExecute: false,
        identityUnconfirmed: storedIntent === null || storedIntent.length === 0,
      };
    }

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
      requestIntentHash,
      intentHashVersion: INTENT_HASH_VERSION,
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
      identityUnconfirmed: false,
    };
  });
}

export type ReplayLookup =
  | { status: 'miss' }
  | { status: 'hit'; run: RunDTO }
  | { status: 'unconfirmed'; run: RunDTO };

export function lookupReplayRun(
  db: DatabaseSync,
  input: { requestKey: UUID; intentHash: string },
): ReplayLookup {
  const existing = findRunByRequestKey(db, input.requestKey);
  if (!existing) return { status: 'miss' };
  const storedIntent = getRunRequestIntentHash(db, input.requestKey);
  if (storedIntent === null || storedIntent.length === 0) {
    return { status: 'unconfirmed', run: existing };
  }
  if (storedIntent !== input.intentHash) throw new RunKeyConflictError();
  return { status: 'hit', run: existing };
}

/**
 * @deprecated Use lookupReplayRun. Kept so older call sites compile during the
 * cut-over; identity is now the intent hash, not the execution snapshot.
 */
export function findReplayRun(
  db: DatabaseSync,
  lookup: { requestKey: UUID; requestHash?: string; intentHash?: string },
): RunDTO | null {
  const result = lookupReplayRun(db, {
    requestKey: lookup.requestKey,
    intentHash: lookup.intentHash ?? lookup.requestHash ?? '',
  });
  if (result.status === 'miss') return null;
  return result.run;
}

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
