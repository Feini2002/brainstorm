/**
 * Apply AI relation suggestions (T039).
 *
 * The governing principle is "user decisions are never overwritten". Three
 * stored states are treated differently, and the differences are the whole point:
 *
 *   - `manual`  — the user declared this; the model's opinion is irrelevant and
 *                 the row is left untouched (T039-R05);
 *   - `rejected`— the user declined this; the row stays as a tombstone so the
 *                 *same* canonical pair cannot be resurrected by the next run
 *                 (T023 behaviour, restated here because this module is where a
 *                 later run could accidentally break it);
 *   - `suggested`— still the model's; reason/score/evidence are refreshed, and no
 *                 duplicate row is inserted (T039-R05).
 *
 * A run that keeps zero relations is still a successful organize: the warning
 * list explains what was dropped so the user is not left guessing whether the
 * model found nothing or the filter rejected everything (T039-R06).
 *
 * Note on symmetric types: repository code (`normalizeEndpoints`) owns endpoint
 * ordering, including moving the two raw versions as one unit. Evidence is keyed
 * by `itemId`, so it does not need reordering when the endpoints swap — each
 * quote already carries the version of the item it came from.
 */
import 'server-only';

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { RelationType, UUID } from '@/domain/knowledge';
import { describeRejection, meetsScoreFloor, verifyEvidence } from '@/domain/evidence';
import { canonicalJson } from '@/domain/canonicalJson';
import {
  findCanonicalRelation,
  insertRelation,
  updateSuggestedRelation,
} from '@/server/repositories/relations';
import { getItemOrNull } from '@/server/repositories/items';
import type { OrganizeOutputRelation } from '@/domain/schemas/organize';

export interface RelationApplyInput {
  db: DatabaseSync;
  runId: UUID;
  /** The item being organized: the source endpoint the model was told about. */
  target: { id: UUID; rawText: string; rawVersion: number };
  /** Candidate briefs actually sent, in send order. */
  candidates: readonly { id: UUID }[];
  suggestions: readonly OrganizeOutputRelation[];
  now: string;
}

export interface RelationApplyResult {
  created: UUID[];
  updated: UUID[];
  /** Relation ids whose stored row is the user's decision, left as-is. */
  preserved: UUID[];
  /** How many proposals hit a remembered rejection. */
  preservedRejected: number;
  /** One short reason per dropped proposal, for the user-facing warning. */
  droppedReasons: string[];
}

export function applyRelationSuggestions(input: RelationApplyInput): RelationApplyResult {
  const { db, runId, target, candidates, suggestions, now } = input;

  const allowedCandidateIds = new Set(candidates.map((candidate) => candidate.id));

  /**
   * Live text and versions for everything a quote may cite, read inside the
   * caller's commit transaction. Only the target and this run's candidates are
   * present, so a quote naming any other item fails as `unknown_item`
   * (T039-R01) rather than being silently accepted.
   */
  const liveText = new Map<UUID, string>();
  const liveVersion = new Map<UUID, number>();
  liveText.set(target.id, target.rawText);
  liveVersion.set(target.id, target.rawVersion);

  const briefed = new Map<UUID, { rawText: string; rawVersion: number }>();
  for (const candidateId of allowedCandidateIds) {
    const item = getItemOrNull(db, candidateId);
    if (!item) continue;
    // A candidate edited since retrieval is compared against its *current*
    // text, so a quote from the older version correctly fails the verbatim
    // check instead of being stored against text that has since changed.
    liveText.set(item.id, item.rawText);
    liveVersion.set(item.id, item.rawVersion);
    briefed.set(item.id, { rawText: item.rawText, rawVersion: item.rawVersion });
  }

  const result: RelationApplyResult = {
    created: [],
    updated: [],
    preserved: [],
    preservedRejected: 0,
    droppedReasons: [],
  };

  const seenPairs = new Set<string>();

  for (const suggestion of suggestions) {
    const candidateId = suggestion.targetId;

    if (candidateId === target.id) {
      result.droppedReasons.push('关系不能指向自己');
      continue;
    }
    if (!allowedCandidateIds.has(candidateId)) {
      result.droppedReasons.push('目标不在本次发送的候选范围内');
      continue;
    }
    if (!meetsScoreFloor(suggestion.score)) {
      // The floor is a noise gate, not "70% probability of being correct".
      result.droppedReasons.push('评分低于阈值');
      continue;
    }

    const candidate = briefed.get(candidateId);
    if (!candidate) {
      // Deleted between retrieval and commit: the metadata still applies, only
      // the relations that referenced it lapse (docs/03_contracts/06 §3).
      result.droppedReasons.push('候选条目已被删除');
      continue;
    }

    const relationType = suggestion.type as RelationType;

    const pairKey = canonicalJson({ sourceId: target.id, targetId: candidateId, type: relationType });
    if (seenPairs.has(pairKey)) {
      result.droppedReasons.push('同一次返回里的重复建议');
      continue;
    }
    seenPairs.add(pairKey);

    // `sourceId` here is the *display* direction. The repository normalizes the
    // stored order for symmetric types and moves versions with the ids.
    const verification = verifyEvidence(
      suggestion.evidence.map((entry) => ({ itemId: entry.itemId, quote: entry.quote })),
      liveText,
      {
        sourceId: target.id,
        targetId: candidateId,
        sourceRawVersion: target.rawVersion,
        targetRawVersion: candidate.rawVersion,
      },
    );
    if (!verification.ok) {
      result.droppedReasons.push(describeRejection(verification.rejection));
      continue;
    }

    const existing = findCanonicalRelation(db, {
      sourceId: target.id,
      targetId: candidateId,
      type: relationType,
    });

    if (existing) {
      // Accepted or manual: the user (or an earlier confirmation) owns this edge.
      if (existing.relation.origin === 'manual' || existing.relation.reviewStatus === 'accepted') {
        result.preserved.push(existing.relation.id);
        continue;
      }
      // Rejected: the tombstone stays so the same pair cannot come back.
      if (existing.relation.reviewStatus === 'rejected') {
        result.preservedRejected += 1;
        continue;
      }
      const changes = updateSuggestedRelation(db, existing.relation.id, {
        sourceId: target.id,
        targetId: candidateId,
        type: relationType,
        score: suggestion.score,
        reason: suggestion.reason,
        evidence: verification.evidence,
        sourceRawVersion: target.rawVersion,
        targetRawVersion: candidate.rawVersion,
        now,
      });
      // Zero changes means the row moved on between the read and the write; it
      // is then the user's decision and must not be reported as refreshed.
      if (changes > 0) result.updated.push(existing.relation.id);
      else result.preserved.push(existing.relation.id);
      continue;
    }

    const id = randomUUID();
    insertRelation(db, {
      id,
      sourceId: target.id,
      targetId: candidateId,
      type: relationType,
      origin: 'ai',
      reviewStatus: 'suggested',
      score: suggestion.score,
      reason: suggestion.reason,
      evidence: verification.evidence,
      sourceRawVersion: target.rawVersion,
      targetRawVersion: candidate.rawVersion,
      runId,
      now,
    });
    result.created.push(id);
  }

  return result;
}
