/**
 * The single place that persists derived item status.
 *
 * `status` is a queryable summary of `deriveItemStatus`; every transaction that
 * can change the inputs calls this helper, and reads may assert consistency.
 * No page computes its own status rules.
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import type { ItemStatus, UUID } from '@/domain/knowledge';
import { deriveItemStatus } from '@/domain/knowledge';
import { findLatestRunForSubject, findRunningRunForSubject } from '@/server/repositories/runs';
import { findItemRow, rowToItem, updateItemStatus } from '@/server/repositories/items';
import { nowIso } from '@/server/repositories/shared';

/** Compute the status for an item without writing anything. */
export function computeStatus(db: DatabaseSync, itemId: UUID, now = Date.now()): ItemStatus | null {
  const row = findItemRow(db, itemId);
  if (!row) return null;
  const item = rowToItem(row);

  const running = findRunningRunForSubject(db, itemId, 'organize');
  const lastRun = findLatestRunForSubject(db, itemId, 'organize');

  const toRunInput = (
    run: ReturnType<typeof findLatestRunForSubject>,
  ): Parameters<typeof deriveItemStatus>[0]['activeRun'] =>
    run
      ? {
          kind: run.kind,
          state: run.state,
          deadlineAt: run.deadlineAt,
          error: run.error,
        }
      : null;

  return deriveItemStatus({
    structuredBaseRawVersion: item.structuredBaseRawVersion,
    rawVersion: item.rawVersion,
    hasRunHistory:
      lastRun !== null || running !== null,
    activeRun: toRunInput(running),
    lastRun: toRunInput(lastRun),
    now,
  });
}

/**
 * Recompute and persist the derived status. Call inside the surrounding
 * transaction; this function never opens its own.
 */
export function syncItemStatus(db: DatabaseSync, itemId: UUID, now = Date.now()): ItemStatus | null {
  const row = findItemRow(db, itemId);
  if (!row) return null;
  const item = rowToItem(row);
  const status = computeStatus(db, itemId, now);
  if (status === null) return null;

  if (status !== item.status) {
    updateItemStatus(db, itemId, status, item.lastRunId, item.error, nowIso());
  }
  return status;
}
