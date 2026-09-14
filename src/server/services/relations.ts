/**
 * Relation service: manual creation, review actions, deletion.
 *
 * Manual creation is a user declaration: origin=manual, accepted, no score.
 * If an AI suggestion for the same canonical pair exists, that same row is
 * promoted — the knowledge base never holds a parallel "manual version".
 */
import 'server-only';

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { AppError, notFound, revisionConflict, validationError } from '@/domain/errors';
import type { RelationDTO, RelationType, UUID } from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import { normalizeEndpoints } from '@/domain/relation';
import { codePointLength } from '@/domain/text';
import { bumpDatasetRevision, withTransaction } from '@/server/db/database';
import { getItem } from '@/server/repositories/items';
import { nowIso } from '@/server/repositories/shared';
import {
  deleteRelation,
  findCanonicalRelation,
  getRelation,
  insertRelation,
  listRelations,
  promoteToManual,
  reconfirmRelation,
  updateReviewStatus,
} from '@/server/repositories/relations';

export interface CreateManualRelationInput {
  sourceId: UUID;
  targetId: UUID;
  type: RelationType;
  reason: string;
  sourceExpectedRevision: number;
  targetExpectedRevision: number;
}

export interface CreateManualRelationResult {
  relation: RelationDTO;
  /** False when an existing AI suggestion was upgraded in place (→ HTTP 200). */
  created: boolean;
}

export function createManualRelation(
  db: DatabaseSync,
  input: CreateManualRelationInput,
): CreateManualRelationResult {
  if (input.sourceId === input.targetId) {
    throw validationError('不能把记录连到自己', { targetId: ['不能连到自己'] });
  }
  if (codePointLength(input.reason) > LIMITS.relationReasonCodePoints) {
    throw validationError('关系理由过长', {
      reason: [`理由不能超过 ${LIMITS.relationReasonCodePoints} 个字符`],
    });
  }

  const source = getItem(db, input.sourceId);
  const target = getItem(db, input.targetId);

  if (source.revision !== input.sourceExpectedRevision) {
    throw revisionConflict('起点记录已被更新，请重新确认');
  }
  if (target.revision !== input.targetExpectedRevision) {
    throw revisionConflict('终点记录已被更新，请重新确认');
  }

  const existing = findCanonicalRelation(db, {
    sourceId: input.sourceId,
    targetId: input.targetId,
    type: input.type,
  });

  const now = nowIso();

  if (existing) {
    if (existing.relation.origin === 'manual') {
      // The same canonical pair (notably a symmetric type submitted from the
      // other side) already has a manual relation. This is a replay, not a new
      // edge: return it unchanged rather than erroring or inserting a parallel
      // row. `created: false` tells the caller nothing new was written.
      return { relation: existing.relation, created: false };
    }
    withTransaction(db, () => {
      const changes = promoteToManual(db, existing.relation.id, {
        sourceRawVersion: source.rawVersion,
        targetRawVersion: target.rawVersion,
        reason: input.reason.length > 0 ? input.reason : existing.relation.reason,
        now,
      });
      if (changes === 0) throw new AppError('INTERNAL', '关系升级失败');
      bumpDatasetRevision(db);
    });
    const promoted = getRelation(db, existing.relation.id);
    if (!promoted) throw notFound('关系不存在');
    return { relation: promoted, created: false };
  }

  const endpoints = normalizeEndpoints(input.sourceId, input.targetId, input.type);
  const id = randomUUID();

  withTransaction(db, () => {
    insertRelation(db, {
      id,
      sourceId: input.sourceId,
      targetId: input.targetId,
      type: input.type,
      origin: 'manual',
      reviewStatus: 'accepted',
      score: null,
      reason: input.reason,
      evidence: [],
      sourceRawVersion: source.rawVersion,
      targetRawVersion: target.rawVersion,
      runId: null,
      now,
    });
    void endpoints;
    bumpDatasetRevision(db);
  });

  const created = getRelation(db, id);
  if (!created) throw new AppError('INTERNAL', '关系创建后无法读取');
  return { relation: created, created: true };
}

export type ReviewAction = 'accept' | 'reject' | 'restoreSuggestion' | 'reconfirm';

export interface ReviewRelationInput {
  id: UUID;
  expectedRevision: number;
  action: ReviewAction;
}

/**
 * Apply a review action.
 *
 * accept/reject/restoreSuggestion apply only to origin=ai rows. reconfirm
 * re-matches the stored evidence against the current raw text; anything that no
 * longer matches verbatim is dropped and reported, never silently kept.
 */
export function reviewRelation(db: DatabaseSync, input: ReviewRelationInput): RelationDTO {
  const relation = getRelation(db, input.id);
  if (!relation) throw notFound('关系不存在');

  if (relation.revision !== input.expectedRevision) throw revisionConflict();

  if (input.action !== 'reconfirm' && relation.origin !== 'ai') {
    throw new AppError('VALIDATION', '人工关系不支持该审核动作，删除即可');
  }

  const now = nowIso();

  if (input.action === 'reconfirm') {
    const source = getItem(db, relation.sourceId);
    const target = getItem(db, relation.targetId);
    const liveById = new Map<string, string>([
      [source.id, source.rawText],
      [target.id, target.rawText],
    ]);

    const kept = relation.evidence.filter((entry) => {
      const text = liveById.get(entry.itemId);
      if (text === undefined) return false;
      return text.includes(entry.quote);
    });

    withTransaction(db, () => {
      const changes = reconfirmRelation(db, input.id, input.expectedRevision, {
        sourceRawVersion: source.rawVersion,
        targetRawVersion: target.rawVersion,
        evidence: kept,
        now,
      });
      if (changes === 0) throw revisionConflict();
      bumpDatasetRevision(db);
    });

    const updated = getRelation(db, input.id);
    if (!updated) throw notFound('关系不存在');
    return updated;
  }

  const nextStatus =
    input.action === 'accept'
      ? 'accepted'
      : input.action === 'reject'
        ? 'rejected'
        : 'suggested';

  withTransaction(db, () => {
    const changes = updateReviewStatus(db, input.id, input.expectedRevision, nextStatus, now);
    if (changes === 0) {
      const live = getRelation(db, input.id);
      if (!live) throw notFound('关系已被删除');
      throw revisionConflict();
    }
    bumpDatasetRevision(db);
  });

  const updated = getRelation(db, input.id);
  if (!updated) throw notFound('关系不存在');
  return updated;
}

export function removeRelation(
  db: DatabaseSync,
  id: UUID,
  expectedRevision: number,
): { deletedId: UUID } {
  const relation = getRelation(db, id);
  if (!relation) throw notFound('关系不存在');
  if (relation.revision !== expectedRevision) throw revisionConflict();

  withTransaction(db, () => {
    const changes = deleteRelation(db, id, expectedRevision);
    if (changes === 0) throw revisionConflict();
    bumpDatasetRevision(db);
  });

  return { deletedId: id };
}

export interface QueryRelationsInput {
  itemId?: UUID;
  reviewStatus?: RelationDTO['reviewStatus'];
  includeStale?: boolean;
  includeRejected?: boolean;
}

export function queryRelations(db: DatabaseSync, input: QueryRelationsInput): RelationDTO[] {
  return listRelations(db, input);
}

/** Relations between an explicit set of items, used by graph and generators. */
export function relationsWithin(
  db: DatabaseSync,
  itemIds: readonly UUID[],
  includeStale = false,
): RelationDTO[] {
  const allowed = new Set(itemIds);
  return listRelations(db, { includeStale, includeRejected: false }).filter(
    (relation) => allowed.has(relation.sourceId) && allowed.has(relation.targetId),
  );
}
