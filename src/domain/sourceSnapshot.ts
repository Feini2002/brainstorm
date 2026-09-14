/**
 * Source snapshots.
 *
 * A generated projection records the exact item/relation versions it was built
 * from. Regeneration is a new Run and a new View; a stale View keeps its
 * history instead of being silently rewritten.
 */
import type { SourceSnapshot } from './knowledge';

export function emptySnapshot(): SourceSnapshot {
  return { items: [], relations: [] };
}

export function buildSnapshot(
  items: readonly { id: string; rawVersion: number; revision: number }[],
  relations: readonly { id: string; revision: number }[],
): SourceSnapshot {
  const seenItems = new Map<string, { id: string; rawVersion: number; revision: number }>();
  for (const item of items) {
    if (!seenItems.has(item.id)) seenItems.set(item.id, { ...item });
  }
  const seenRelations = new Map<string, { id: string; revision: number }>();
  for (const relation of relations) {
    if (!seenRelations.has(relation.id)) seenRelations.set(relation.id, { ...relation });
  }
  return {
    items: [...seenItems.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    relations: [...seenRelations.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
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
