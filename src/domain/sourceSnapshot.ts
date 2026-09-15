/**
 * Source snapshots.
 *
 * A generated projection records the exact item/relation versions it was built
 * from. Regeneration is a new Run and a new View; a stale View keeps its
 * history instead of being silently rewritten.
 *
 * Three things this module owns, because they must be one implementation rather
 * than one per caller (T054):
 *
 *  - **Order-independence.** `buildSnapshot` sorts by id, so the same set of
 *    materials submitted in a different order produces the same snapshot — and
 *    therefore the same hash (T054-C01). Without this, clicking two items in the
 *    opposite order would look like a different request and start a second paid
 *    call.
 *  - **A hash over canonical JSON.** `sourceInputHash` fixes both the field set
 *    and the ordering, and excludes anything random (no run id, no timestamp, no
 *    secret), so an identical intent is recognisable as identical (T054-R03).
 *  - **A budget check that refuses rather than truncates.** Over-budget material
 *    is reported with the numbers, never silently dropped: a graph built from
 *    "the first forty of what you chose" is a graph whose provenance is a lie
 *    (T054-R06).
 */
import { canonicalJson } from './canonicalJson';
import type { SourceSnapshot } from './knowledge';
import { LIMITS } from './limits';
import { hashSha256 } from './hash';

export function emptySnapshot(): SourceSnapshot {
  return { items: [], relations: [] };
}

export function buildSnapshot(
  items: readonly { id: string; rawVersion: number; revision: number }[],
  relations: readonly { id: string; revision: number }[],
): SourceSnapshot {
  // Fields are copied one by one rather than spread. A spread would carry
  // whatever else the caller happened to pass — `listItemsByIds` returns full
  // ItemDTOs, so spreading would put titles and summaries into the snapshot and
  // therefore into `sourceInputHash`. The snapshot's field set is a contract
  // (it is stored in the database and hashed), so it is fixed here, not by
  // convention at each call site.
  const seenItems = new Map<string, SourceSnapshot['items'][number]>();
  for (const item of items) {
    if (!seenItems.has(item.id)) {
      seenItems.set(item.id, {
        id: item.id,
        rawVersion: item.rawVersion,
        revision: item.revision,
      });
    }
  }
  const seenRelations = new Map<string, SourceSnapshot['relations'][number]>();
  for (const relation of relations) {
    if (!seenRelations.has(relation.id)) {
      seenRelations.set(relation.id, { id: relation.id, revision: relation.revision });
    }
  }
  return {
    items: [...seenItems.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    relations: [...seenRelations.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

/**
 * Identity of the material a projection is about to be built from (T054-R03).
 *
 * Covers exactly what would change the answer, and nothing else:
 *
 *  - `kind` and `promptVersion`, because the same notes under a different
 *    template are different work;
 *  - the selection *description* (which for a tag filter is the tag, not the ids
 *    it happened to resolve to), so re-running the same filter request is
 *    recognised even if the tag gained members in between;
 *  - the snapshot, whose ids are sorted by `buildSnapshot` and whose versions are
 *    the point of the whole exercise.
 *
 * Deliberately absent: the user's free-text intent is *not* omitted (it is
 * passed in by the caller and hashed), but timestamps, run ids, durations and
 * anything read from the settings table are — those are either random or are
 * already covered by `configRevision` on the run fingerprint.
 */
export interface SourceInputHashInput {
  kind: 'mindmap' | 'flow';
  promptVersion: string;
  /** The resolved material, already normalised by `buildSnapshot`. */
  snapshot: SourceSnapshot;
  /** A stable description of *how* the material was chosen. */
  selection: unknown;
  /** The user's own instruction, if the operation takes one. */
  intent?: string | null;
}

export function sourceInputHash(input: SourceInputHashInput): string {
  return hashSha256(
    canonicalJson({
      kind: input.kind,
      promptVersion: input.promptVersion,
      selection: input.selection,
      intent: input.intent ?? null,
      items: input.snapshot.items.map((entry) => ({
        id: entry.id,
        rawVersion: entry.rawVersion,
        revision: entry.revision,
      })),
      relations: input.snapshot.relations.map((entry) => ({
        id: entry.id,
        revision: entry.revision,
      })),
    }),
  );
}

/**
 * Whether this much material may be sent to a model at all (T054-R06).
 *
 * Two independent ceilings, and both are refusals rather than truncations:
 * `selectedItemsPerProjection` bounds how many records one projection may claim
 * to be about, and `outboundContextCodePoints` bounds what actually goes over
 * the wire. The second is measured on the *resolved* material, so a set of forty
 * very long notes is refused here rather than being silently shortened inside
 * the prompt builder.
 */
export interface SourceBudgetInput {
  itemCount: number;
  /** Code points of everything that would be sent, prompt included. */
  estimatedCodePoints: number;
}

export type SourceBudgetReason = 'empty' | 'too_many_items' | 'context_too_large';

export interface SourceBudgetResult {
  ok: boolean;
  reason?: SourceBudgetReason;
  message?: string;
  itemCount: number;
  estimatedCodePoints: number;
  /** How many items to remove to fit; present only for `too_many_items`. */
  overByItems?: number;
}

export function checkSourceBudget(input: SourceBudgetInput): SourceBudgetResult {
  const base = {
    itemCount: input.itemCount,
    estimatedCodePoints: input.estimatedCodePoints,
  };

  if (input.itemCount === 0) {
    return { ok: false, reason: 'empty', message: '请先选择要整理的资料', ...base };
  }
  if (input.itemCount > LIMITS.selectedItemsPerProjection) {
    const overByItems = input.itemCount - LIMITS.selectedItemsPerProjection;
    return {
      ok: false,
      reason: 'too_many_items',
      message: `一次最多整理 ${LIMITS.selectedItemsPerProjection} 条资料，请减少 ${overByItems} 条`,
      overByItems,
      ...base,
    };
  }
  if (input.estimatedCodePoints > LIMITS.outboundContextCodePoints) {
    const over = input.estimatedCodePoints - LIMITS.outboundContextCodePoints;
    return {
      ok: false,
      reason: 'context_too_large',
      message: `选中的原文合计超出单次上限，请减少约 ${over} 个字符的材料后再试`,
      ...base,
    };
  }
  return { ok: true, ...base };
}

export interface SnapshotComparison {
  matches: boolean;
  changedItemIds: string[];
  changedRelationIds: string[];
  missingItemIds: string[];
}

/** Compare a candidate snapshot against the current database state. */
export function compareSnapshot(
  candidate: SourceSnapshot,
  items: Map<string, { rawVersion: number; revision: number }>,
  relations: Map<string, { revision: number }>,
): SnapshotComparison {
  const changedItemIds: string[] = [];
  const changedRelationIds: string[] = [];
  const missingItemIds: string[] = [];

  for (const entry of candidate.items) {
    const live = items.get(entry.id);
    if (!live) {
      missingItemIds.push(entry.id);
      continue;
    }
    if (live.rawVersion !== entry.rawVersion || live.revision !== entry.revision) {
      changedItemIds.push(entry.id);
    }
  }

  for (const entry of candidate.relations) {
    const live = relations.get(entry.id);
    if (!live) {
      changedRelationIds.push(entry.id);
      continue;
    }
    if (live.revision !== entry.revision) changedRelationIds.push(entry.id);
  }

  return {
    matches:
      changedItemIds.length === 0 &&
      changedRelationIds.length === 0 &&
      missingItemIds.length === 0,
    changedItemIds,
    changedRelationIds,
    missingItemIds,
  };
}

/** Convert item/relation DTO subsets into a snapshot for saving on a new View. */
export function snapshotFrom(
  items: readonly { id: string; rawVersion: number; revision: number }[],
  relations: readonly { id: string; revision: number }[],
): SourceSnapshot {
  return buildSnapshot(items, relations);
}
