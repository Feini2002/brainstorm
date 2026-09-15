/**
 * Relation repository.
 *
 * One canonical pair + type yields at most one row (the SQL UNIQUE key), so AI
 * suggestions can never accumulate parallel edges. Upserts respect review
 * decisions: an accepted/manual/rejected record is never overwritten by a new
 * suggestion, and a rejected record must stay behind as a tombstone so it cannot
 * be resurrected by the next organize run.
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import type { Evidence, RelationDTO, RelationType, ReviewStatus, UUID } from '@/domain/knowledge';
import { normalizeEndpoints } from '@/domain/relation';
import { RELATION_COLUMNS, decodeRelationRow } from './mappers';

export interface RelationRowInput {
  id: UUID;
  sourceId: UUID;
  targetId: UUID;
  type: RelationType;
  origin: 'ai' | 'manual';
  reviewStatus: ReviewStatus;
  score: number | null;
  reason: string;
  evidence: Evidence[];
  sourceRawVersion: number;
  targetRawVersion: number;
  runId: UUID | null;
  now: string;
}

/** Staleness: a relation is stale when either endpoint's raw version moved. */
const RELATION_WITH_STALE_SQL = `
  SELECT ${RELATION_COLUMNS},
         (r.source_raw_version <> s.raw_version OR r.target_raw_version <> t.raw_version) AS stale_flag
    FROM relations r
    JOIN knowledge_items s ON s.id = r.source_id
    JOIN knowledge_items t ON t.id = r.target_id
`;

export function getRelation(db: DatabaseSync, id: UUID): RelationDTO | null {
  const row = db.prepare(`${RELATION_WITH_STALE_SQL} WHERE r.id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return decodeRelationRow(row, Boolean(row.stale_flag));
}

export interface FindCanonicalInput {
  sourceId: UUID;
  targetId: UUID;
  type: RelationType;
}

export function findCanonicalRelation(
  db: DatabaseSync,
  input: FindCanonicalInput,
): { relation: RelationDTO } | null {
  const endpoints = normalizeEndpoints(input.sourceId, input.targetId, input.type);
  const row = db
    .prepare(
      `${RELATION_WITH_STALE_SQL}
        WHERE r.source_id = ? AND r.target_id = ? AND r.relation_type = ?`,
    )
    .get(endpoints.sourceId, endpoints.targetId, input.type) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return { relation: decodeRelationRow(row, Boolean(row.stale_flag)) };
}

export interface ListRelationsInput {
  itemId?: UUID;
  reviewStatus?: ReviewStatus;
  includeStale?: boolean;
  includeRejected?: boolean;
}

export function listRelations(db: DatabaseSync, input: ListRelationsInput): RelationDTO[] {
  const where: string[] = [];
  const params: string[] = [];

  if (input.itemId) {
    where.push('(r.source_id = ? OR r.target_id = ?)');
    params.push(input.itemId, input.itemId);
  }
  if (input.reviewStatus) {
    where.push('r.review_status = ?');
    params.push(input.reviewStatus);
  } else if (!input.includeRejected) {
    where.push("r.review_status <> 'rejected'");
  }
  if (!input.includeStale) {
    where.push('r.source_raw_version = s.raw_version AND r.target_raw_version = t.raw_version');
  }

  const rows = db
    .prepare(
      `${RELATION_WITH_STALE_SQL}
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.updated_at DESC, r.id DESC`,
    )
    .all(...params) as Record<string, unknown>[];

  return rows.map((row) => decodeRelationRow(row, Boolean(row.stale_flag)));
}

/**
 * Read exactly the requested relations, rejecting nothing.
 *
 * A saved View snapshots the relation ids it was built from. Reading them back
 * by id (instead of listing every relation and filtering in memory) keeps the
 * snapshot/staleness comparison honest for a library larger than one page: a
 * relation that merely fell outside the list window used to look deleted, which
 * reported a healthy view as "来源已删除".
 */
export function listRelationsByIds(db: DatabaseSync, ids: readonly UUID[]): RelationDTO[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const byId = new Map<string, RelationDTO>();
  const CHUNK = 400;
  for (let start = 0; start < unique.length; start += CHUNK) {
    const chunk = unique.slice(start, start + CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db
      .prepare(`${RELATION_WITH_STALE_SQL} WHERE r.id IN (${placeholders})`)
      .all(...chunk) as Record<string, unknown>[];
    for (const row of rows) {
      const relation = decodeRelationRow(row, Boolean(row.stale_flag));
      byId.set(relation.id, relation);
    }
  }
  // Caller order, so a snapshot's relation list is deterministic.
  return unique.map((id) => byId.get(id)).filter((entry): entry is RelationDTO => entry !== undefined);
}

/** Insert a brand new relation row. */
export function insertRelation(db: DatabaseSync, input: RelationRowInput): void {
  const endpoints = normalizeEndpoints(input.sourceId, input.targetId, input.type);
  db.prepare(
    `INSERT INTO relations (
       id, source_id, target_id, relation_type, origin, review_status, score, reason,
       evidence_json, source_raw_version, target_raw_version, run_id, revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    input.id,
    endpoints.sourceId,
    endpoints.targetId,
    input.type,
    input.origin,
    input.reviewStatus,
    input.score,
    input.reason,
    JSON.stringify(input.evidence),
    endpoints.swapped ? input.targetRawVersion : input.sourceRawVersion,
    endpoints.swapped ? input.sourceRawVersion : input.targetRawVersion,
    input.runId,
    input.now,
    input.now,
  );
}

/**
 * Update a still-suggested AI relation in place. Only called when the existing
 * row is origin=ai and review_status=suggested; accepted/manual/rejected rows
 * are protected by the caller.
 */
export function updateSuggestedRelation(
  db: DatabaseSync,
  id: UUID,
  input: Omit<RelationRowInput, 'id' | 'origin' | 'reviewStatus' | 'runId'>,
): number {
  const endpoints = normalizeEndpoints(input.sourceId, input.targetId, input.type);
  const result = db
    .prepare(
      `UPDATE relations
          SET score = ?, reason = ?, evidence_json = ?,
              source_raw_version = ?, target_raw_version = ?,
              revision = revision + 1, updated_at = ?
        WHERE id = ? AND origin = 'ai' AND review_status = 'suggested'`,
    )
    .run(
      input.score,
      input.reason,
      JSON.stringify(input.evidence),
      endpoints.swapped ? input.targetRawVersion : input.sourceRawVersion,
      endpoints.swapped ? input.sourceRawVersion : input.targetRawVersion,
      input.now,
      id,
    );
  return Number(result.changes);
}

/**
 * Promote an existing AI relation to a manual one (user confirmed it).
 * Keeps the row identity — no parallel "manual version" row is inserted.
 */
export function promoteToManual(
  db: DatabaseSync,
  id: UUID,
  input: { sourceRawVersion: number; targetRawVersion: number; reason: string; now: string },
): number {
  const result = db
    .prepare(
      `UPDATE relations
          SET origin = 'manual', review_status = 'accepted', score = NULL,
              reason = ?, source_raw_version = ?, target_raw_version = ?,
              revision = revision + 1, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      input.reason,
      input.sourceRawVersion,
      input.targetRawVersion,
      input.now,
      id,
    );
  return Number(result.changes);
}

export function updateReviewStatus(
  db: DatabaseSync,
  id: UUID,
  expectedRevision: number,
  reviewStatus: ReviewStatus,
  now: string,
): number {
  const result = db
    .prepare(
      `UPDATE relations
          SET review_status = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND origin = 'ai'`,
    )
    .run(reviewStatus, now, id, expectedRevision);
  return Number(result.changes);
}

/** Reconfirm an AI relation against the current endpoint versions. */
export function reconfirmRelation(
  db: DatabaseSync,
  id: UUID,
  expectedRevision: number,
  input: {
    sourceRawVersion: number;
    targetRawVersion: number;
    evidence: Evidence[];
    now: string;
  },
): number {
  const result = db
    .prepare(
      `UPDATE relations
          SET source_raw_version = ?, target_raw_version = ?, evidence_json = ?,
              revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?`,
    )
    .run(
      input.sourceRawVersion,
      input.targetRawVersion,
      JSON.stringify(input.evidence),
      input.now,
      id,
      expectedRevision,
    );
  return Number(result.changes);
}

export function deleteRelation(
  db: DatabaseSync,
  id: UUID,
  expectedRevision: number,
): number {
  const result = db
    .prepare('DELETE FROM relations WHERE id = ? AND revision = ?')
    .run(id, expectedRevision);
  return Number(result.changes);
}

export function countRelations(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS total FROM relations').get() as
    | { total: number }
    | undefined;
  return Number(row?.total ?? 0);
}
