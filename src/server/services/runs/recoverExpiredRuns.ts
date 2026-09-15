/**
 * Lease recovery (T040) — the transaction-free core.
 *
 * Recovery has exactly one job: a row still marked `running` past its lease
 * becomes `interrupted`. It is deliberately *not* a sweep that touches anything
 * else:
 *
 *   - it never calls a model (recovery must not cost money, T040-R05);
 *   - it never deletes a run (the ledger is evidence the user paid for);
 *   - it only affects rows whose deadline has actually passed, so an HMR reload
 *     or a stray GET cannot kill a healthy in-flight operation (T040-R01);
 *   - item status is recomputed for the affected items only, and only through the
 *     shared derivation (T040-R02).
 *
 * `recoverExpiredRuns` opens its own transaction. `recoverExpiredRunsTx` is the
 * version that participates in a caller's transaction — registration needs both
 * steps (recover, then occupy the slot) inside one `BEGIN IMMEDIATE`.
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import type { UUID } from '@/domain/knowledge';
import { withTransaction } from '@/server/db/database';
import { findExpiredRunningRuns, markInterrupted, findRunById } from '@/server/repositories/runs';
import { nowIso } from '@/server/repositories/shared';
import { syncItemStatus } from '../status';

/**
 * Recover expired runs inside the caller's transaction.
 *
 * Returns the recovered run ids so the caller can report them. Must not open a
 * transaction of its own — SQLite has no nested `BEGIN`.
 */
export function recoverExpiredRunsTx(db: DatabaseSync, now: string = nowIso()): UUID[] {
  const expired = findExpiredRunningRuns(db, now);
  if (expired.length === 0) return [];

  const recovered: UUID[] = [];
  for (const run of expired) {
    if (markInterrupted(db, run.id, now) === 0) continue;
    recovered.push(run.id);

    // The item's processing badge is derived from the run, so it must be
    // recomputed in the same transaction. `syncItemStatus` reads the *current*
    // running run for the subject, so a newer organize run for the same item
    // keeps its `processing` status untouched (T040-R02).
    const subjectId = run.subjectId ?? findRunById(db, run.id)?.subjectId ?? null;
    if (subjectId !== null && run.kind === 'organize') {
      syncItemStatus(db, subjectId, Date.parse(now));
    }
  }
  return recovered;
}

/** Recover expired leases in a transaction of its own. */
export function recoverExpiredRuns(db: DatabaseSync, now: string = nowIso()): UUID[] {
  const expired = findExpiredRunningRuns(db, now);
  if (expired.length === 0) return [];
  return withTransaction(db, () => recoverExpiredRunsTx(db, now));
}
