/**
 * Derived relationship freshness service (T051).
 *
 * Freshness is a *question about the current database*, so it is answered here
 * and never stored (T051-R06). The comparison itself lives in
 * `src/domain/staleness.ts` as pure code; this module exists to do the two things
 * pure domain code cannot: read the live item versions, and hand back exactly the
 * relations it read them for.
 *
 * The read is deliberately one query for the whole endpoint set rather than one
 * query per relation. A per-relation read would let a concurrent edit land
 * halfway through, producing a graph where two edges from the same note disagree
 * about whether that note changed.
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import type { RelationDTO, UUID } from '@/domain/knowledge';
import {
  deriveGraphFreshnessFromDto,
  relationFreshness,
  type GraphFreshness,
  type RelationFreshness,
} from '@/domain/staleness';

/** Live `rawVersion` for the given item ids; absent ids are treated as deleted. */
export function readItemRawVersions(
  db: DatabaseSync,
  itemIds: readonly UUID[],
): Map<string, number> {
  const unique = [...new Set(itemIds)];
  if (unique.length === 0) return new Map();

  const placeholders = unique.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, raw_version FROM knowledge_items WHERE id IN (${placeholders})`,
    )
    .all(...unique) as { id: string; raw_version: number }[];

  return new Map(rows.map((row) => [String(row.id), Number(row.raw_version)]));
}

/** Versions of every item a relation list touches. */
export function versionsForRelations(
  db: DatabaseSync,
  relations: readonly RelationDTO[],
): Map<string, number> {
  const ids: string[] = [];
  for (const relation of relations) {
    ids.push(relation.sourceId, relation.targetId);
  }
  return readItemRawVersions(db, ids);
}

/** Classify one relation against the live database. */
export function freshnessOfRelation(
  db: DatabaseSync,
  relation: RelationDTO,
): RelationFreshness {
  const versions = versionsForRelations(db, [relation]);
  return relationFreshness(relation, versions);
}

/**
 * Classify a whole relation list and summarise it.
 *
 * The summary covers every relation passed in, including ones the caller will go
 * on to hide. A count computed after filtering would report "0 条依据过期" for a
 * graph that merely defaulted to hiding exactly those edges.
 */
export function deriveGraphFreshness(
  db: DatabaseSync,
  relations: readonly RelationDTO[],
): GraphFreshness {
  return deriveGraphFreshnessFromDto(relations, versionsForRelations(db, relations));
}
