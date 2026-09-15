/**
 * Relationship freshness (T051).
 *
 * A relation's justification is the pair of raw texts it was drawn from. When
 * either endpoint's `rawVersion` moves, the recorded evidence no longer
 * describes the text the user can read: the relation may still be true, but
 * nothing on record supports saying so.
 *
 * Three deliberate decisions:
 *
 *  1. **`rawVersion`, not `updatedAt` (T051-R01, T051-R02).** Editing only a
 *     title bumps `updatedAt` and `revision` while the text a relation was
 *     derived from is untouched. Comparing timestamps would invalidate every
 *     edge attached to a renamed note; comparing `rawVersion` invalidates
 *     exactly the relations whose evidence actually moved.
 *  2. **A missing endpoint is `missing`, not `stale`.** They read differently to
 *     a user: "the text changed" invites re-reading, "the note was deleted"
 *     explains why the node is gone. Collapsing them into one boolean loses the
 *     only information that makes the notice actionable.
 *  3. **Derived on read, never stored (T051-R06).** A `stale` column is a second
 *     copy of the truth that drifts the first time an update path forgets to
 *     maintain it. This module computes freshness from current versions, so it
 *     cannot disagree with the rows it describes.
 */
import type { RelationDTO } from './knowledge';

export type RelationFreshness = 'fresh' | 'stale' | 'missing';

/**
 * The versions a relation was recorded against.
 *
 * Structural rather than `Pick<RelationDTO, ...>` so a thin repository row can
 * be classified without being inflated into a full DTO, and vice versa.
 */
export interface RelationVersionPair {
  sourceId: string;
  targetId: string;
  sourceRawVersion: number;
  targetRawVersion: number;
}

/** Current `rawVersion` per live item; `undefined` means the item is gone. */
export type ItemRawVersions = ReadonlyMap<string, number>;

/**
 * Classify one relation.
 *
 * Endpoint versions are compared in both directions: a relation recorded against
 * an *older* raw version is stale (the evidence is out of date), and one
 * recorded against a *newer* raw version is stale too (the database was rolled
 * back or restored from a bundle taken at a different point). Treating a
 * mismatch as "fresh because the number grew" would hide the second case.
 */
export function relationFreshness(
  relation: RelationVersionPair,
  current: ItemRawVersions,
): RelationFreshness {
  const source = current.get(relation.sourceId);
  const target = current.get(relation.targetId);
  if (source === undefined || target === undefined) return 'missing';
  if (source !== relation.sourceRawVersion || target !== relation.targetRawVersion) {
    return 'stale';
  }
  return 'fresh';
}

export interface GraphFreshness {
  byRelationId: Record<string, RelationFreshness>;
  freshCount: number;
  staleCount: number;
  missingCount: number;
  /** Freshness of the relation shown at the top of the notice, if any. */
  notice: string | null;
}

/**
 * Classify every relation at once and summarise the result for display.
 *
 * The counts are the *whole* relation set handed in, not just the edges that
 * survived the graph's node/edge budget. A viewer that reported "0 stale edges"
 * while truncating away the stale ones would be actively misleading, so the
 * caller passes the same relation list it filters from.
 */
export function deriveGraphFreshness(
  relations: readonly RelationVersionPair[],
  current: ItemRawVersions,
): GraphFreshness {
  const byRelationId: Record<string, RelationFreshness> = {};
  let freshCount = 0;
  let staleCount = 0;
  let missingCount = 0;

  for (const relation of relations) {
    const freshness = relationFreshness(relation, current);
    byRelationId[relationKey(relation)] = freshness;
    if (freshness === 'fresh') freshCount += 1;
    else if (freshness === 'stale') staleCount += 1;
    else missingCount += 1;
  }

  return {
    byRelationId,
    freshCount,
    staleCount,
    missingCount,
    notice: describeFreshness({ staleCount, missingCount }),
  };
}

/**
 * Freshness keyed by relation *id* — the form the graph UI looks up.
 *
 * Kept separate from `relationFreshness`'s pair-based comparison because a
 * relation's identity for the client is its id, and an edge carries the id.
 */
export function deriveGraphFreshnessFromDto(
  relations: readonly RelationDTO[],
  current: ItemRawVersions,
): GraphFreshness {
  const byRelationId: Record<string, RelationFreshness> = {};
  let freshCount = 0;
  let staleCount = 0;
  let missingCount = 0;

  for (const relation of relations) {
    const freshness = relationFreshness(relation, current);
    byRelationId[relation.id] = freshness;
    if (freshness === 'fresh') freshCount += 1;
    else if (freshness === 'stale') staleCount += 1;
    else missingCount += 1;
  }

  return {
    byRelationId,
    freshCount,
    staleCount,
    missingCount,
    notice: describeFreshness({ staleCount, missingCount }),
  };
}

/**
 * Human-readable notice, or `null` when every relation is fresh.
 *
 * The wording says what happened and what the user can do; it never claims the
 * relation is wrong, because a moved raw version only means the recorded
 * evidence no longer applies.
 */
export function describeFreshness(counts: {
  staleCount: number;
  missingCount: number;
}): string | null {
  const parts: string[] = [];
  if (counts.staleCount > 0) {
    parts.push(`${counts.staleCount} 条关系的原文已变化，依据已过期`);
  }
  if (counts.missingCount > 0) {
    parts.push(`${counts.missingCount} 条关系的端点已删除`);
  }
  if (parts.length === 0) return null;
  return `${parts.join('；')}。可重新整理来源，或切换「显示过期关系」查看旧依据。`;
}

function relationKey(relation: RelationVersionPair): string {
  // Thin rows may carry an id; fall back to the pair when they do not, so the
  // function still returns a usable key instead of throwing on a missing id.
  const withId = relation as RelationVersionPair & { id?: string };
  return withId.id ?? `${relation.sourceId}->${relation.targetId}`;
}
