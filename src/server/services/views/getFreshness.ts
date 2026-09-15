/**
 * View freshness and regeneration preview (T059).
 *
 * Two questions the interface must answer before the user acts, and neither is
 * answerable from `ViewDTO` alone:
 *
 *  1. **"Why is this map out of date?"** The DTO carries `isStale` and
 *     `missingSources`, but not *how many* notes changed versus how many
 *     relations moved. "依据已过期" is true and useless; "1 条笔记已修改，1 条关系已
 *     变化" tells the user what to go and look at (T059-R01). The counts live
 *     here rather than on the DTO because the DTO's field set is a contract
 *     (`docs/03_contracts/03_dto_and_version_rules.md` §12) and this is a
 *     derived explanation, not a stored fact.
 *  2. **"What would be sent if I regenerate now?"** A filter selection resolves
 *     to a *different* set than it did at generation time — a tag may have gained
 *     members, or lost them (T059-R03, T059-C04). Re-evaluating the stored
 *     selection here, as a read, is what lets the user confirm the scope before
 *     paying for a generation. The alternative — re-evaluating it as a side
 *     effect of pressing the button — would send material the user never
 *     agreed to, which is the one thing a projection's provenance cannot survive.
 *
 * Nothing in this module writes. Reading freshness must never mark a view clean,
 * bump `generatedAt`, or touch an item: the whole point of a snapshot is that a
 * later read cannot rewrite history (T059-R05, docs/03_contracts/09 §5).
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import { notFound } from '@/domain/errors';
import type { SelectionSpec, UUID } from '@/domain/knowledge';
import {
  computeStaleness,
  describeSourceDrift,
  describeStaleness,
  type ViewFreshness,
} from '@/domain/view';
import { captureSources } from './captureSources';
import { listItemsByIds } from '@/server/repositories/items';
import { findViewRow } from '@/server/repositories/views';
import { readCurrentSourceState } from './views';

export type { ViewFreshness };

/**
 * Describe one view's freshness and what regenerating it would send.
 *
 * A missing view is a 404 rather than an empty result: the caller asked about a
 * specific id, and answering "no changes" for a view that does not exist would
 * make a deleted view look healthy.
 */
export function getViewFreshness(db: DatabaseSync, id: UUID): ViewFreshness {
  const row = findViewRow(db, id);
  if (!row) throw notFound('视图不存在');

  const decoded = JSON.parse(String(row.selection_json)) as SelectionSpec;
  const snapshot = JSON.parse(String(row.source_snapshot_json)) as {
    items: { id: string; rawVersion: number; revision: number }[];
    relations: { id: string; revision: number }[];
  };

  const staleness = computeStaleness(snapshot, readCurrentSourceState(db, snapshot));

  // Re-resolve the stored selection against the database as it is now. This is
  // the same `captureSources` the generation path uses, so the preview and the
  // eventual request cannot disagree about what "this selection" means — a
  // second resolution rule here would be a second answer to the same question.
  const captured = captureSources(db, { selection: decoded });
  const resolvedIds = captured.items.map((item) => item.id);

  const snapshotIds = new Set(snapshot.items.map((entry) => entry.id));
  const resolvedSet = new Set(resolvedIds);

  // Titles are read only for sources that actually drifted, so a healthy view
  // costs one version lookup and nothing else.
  const driftedItemIds = staleness.drift
    .filter((entry) => entry.kind === 'item')
    .map((entry) => entry.id);
  const titles = new Map(
    listItemsByIds(db, driftedItemIds).map((item) => [item.id, item.title]),
  );

  return {
    viewId: String(row.id),
    kind: String(row.kind) as ViewFreshness['kind'],
    revision: Number(row.revision),
    generatedAt: (row.generated_at as string | null) ?? null,
    isStale: staleness.isStale,
    missingSources: staleness.missingSources,
    changedItemCount: staleness.changedItemIds.length,
    changedRelationCount: staleness.changedRelationIds.length,
    missingSourceCount: staleness.missingSources.length,
    reason: describeStaleness(staleness),
    drift: staleness.drift.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      title: titles.get(entry.id) ?? null,
      message: describeSourceDrift(entry),
      missing: entry.current === null,
    })),
    currentSelection: {
      mode: decoded.mode,
      resolvedIds,
      count: resolvedIds.length,
      snapshotCount: snapshotIds.size,
      addedIds: resolvedIds.filter((itemId) => !snapshotIds.has(itemId)),
      removedIds: [...snapshotIds].filter((itemId) => !resolvedSet.has(itemId)),
      withinBudget: captured.budget.ok,
      budgetMessage: captured.budget.ok ? null : (captured.budget.message ?? '超出单次整理上限'),
      isEmpty: resolvedIds.length === 0,
    },
  };
}
