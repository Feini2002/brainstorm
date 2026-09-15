/**
 * Apply organized metadata to an item (T038).
 *
 * This is the only path that lets model output write domain fields, so its rules
 * are stated in terms of what the model *cannot* do:
 *
 *   - it cannot write `capturedText`, `rawText`, `sourceRef`, `createdAt` or any
 *     id/version column. There is no parameter for them (T038-R01) — the schema
 *     rejects them upstream and this function has no way to express them;
 *   - it cannot overwrite a field the user has locked. Locked fields keep their
 *     value and are reported as skipped; if all six are locked the run still
 *     completes successfully and simply applies nothing (T038-R02);
 *   - it cannot win a race. The caller's transaction re-checks `revision`, and a
 *     mismatch aborts the whole application rather than merging field by field
 *     (T038-R03) — a per-field merge would mix two users' intents;
 *   - tags go through the same `TagRepository` normalization the manual editor
 *     uses, so "AI" and "ai" cannot become two dictionary entries on one path
 *     (T038-R04).
 *
 * Must be called inside the caller's commit transaction: item update, tags,
 * structured-base version and the run's terminal state commit together (T036-R04).
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import { AppError, revisionConflict } from '@/domain/errors';
import type { ItemDTO, ManualField } from '@/domain/knowledge';
import { isStructuredFullyLocked, mergeOrganizedFields } from '@/domain/itemFields';
import { normalizeKeywordList, normalizeTagList } from '@/domain/tags';
import { updateItemStructuredIfRevision } from '@/server/repositories/items';
import { setItemTags } from '@/server/repositories/tags';
import type { OrganizeOutput } from '@/domain/schemas/organize';

export interface ApplyOrganizeMetadataInput {
  db: DatabaseSync;
  /** The item as read *before* the provider call, used for the CAS check. */
  current: ItemDTO;
  organized: OrganizeOutput;
  expectedRevision: number;
  /**
   * The raw version the model actually read (T038-R03).
   *
   * `revision` and `rawVersion` answer different questions: `revision` guards
   * "did anything about this row change", `rawVersion` guards "is the text the
   * model summarized still the text we are about to attribute the summary to".
   * A write that moved `rawText` without bumping `revision` — an import, a
   * maintenance repair — would pass a revision-only check and then record a
   * `structuredBaseRawVersion` describing material nobody summarized.
   */
  expectedRawVersion: number;
  now: string;
}

export interface ApplyOrganizeMetadataResult {
  applied: ManualField[];
  skipped: ManualField[];
  /** True when the model's values were entirely blocked by user locks. */
  nothingApplied: boolean;
  /** Fields whose incoming value differed from the current one. */
  changed: boolean;
}

export class AllFieldsLockedNotice extends Error {
  constructor() {
    super('所有整理字段都被人工锁定，本次没有覆盖任何字段');
    this.name = 'AllFieldsLockedNotice';
  }
}

export function applyOrganizeMetadata(
  input: ApplyOrganizeMetadataInput,
): ApplyOrganizeMetadataResult {
  const { db, current, organized, expectedRevision, expectedRawVersion, now } = input;

  // The CAS is re-checked here, inside the commit transaction, because the
  // provider call took time and the user may have edited the item meanwhile.
  if (current.revision !== expectedRevision) {
    throw revisionConflict('整理期间该记录被修改，已放弃覆盖，原文与人工编辑保持不变');
  }
  // The raw version is a separate guard: it is what decides whether the summary
  // may be attributed to the text currently on the row (T038-R03).
  if (current.rawVersion !== expectedRawVersion) {
    throw revisionConflict('整理期间该记录原文已变化，放弃写入以免给旧文字配上新摘要');
  }

  // `structuredBaseRawVersion` records the text the model actually read, not the
  // row's current raw version. They are equal whenever the guard above passes,
  // but writing the snapshot keeps the attribution explicit rather than implied.
  const structuredBaseRawVersion = expectedRawVersion;

  const normalizedTags = normalizeTagList(organized.tags).labels.slice(0, 8);
  const normalizedKeywords = normalizeKeywordList(organized.keywords).keywords;

  const merged = mergeOrganizedFields(current, {
    title: organized.title,
    summary: organized.summary,
    type: organized.type,
    tags: normalizedTags,
    keywords: normalizedKeywords,
    importance: organized.importance,
  });

  const fullyLocked = isStructuredFullyLocked(current);

  const changes = updateItemStructuredIfRevision(db, {
    id: current.id,
    expectedRevision,
    title: merged.values.title,
    summary: merged.values.summary,
    type: merged.values.type,
    keywords: merged.values.keywords,
    importance: merged.values.importance,
    manualFields: current.manualFields,
    // Align the structured base with the raw version this run actually read.
    structuredBaseRawVersion,
    now,
  });

  if (changes === 0) {
    throw revisionConflict('记录在提交时已变化，未写入任何整理结果');
  }

  // Tags are written through the shared repository, in the same transaction, so
  // a dictionary conflict cannot leave a half-applied update behind.
  if (!merged.skipped.includes('tags')) {
    setItemTags(db, current.id, normalizedTags, now);
  }

  const changed =
    merged.values.title !== current.title ||
    merged.values.summary !== current.summary ||
    merged.values.type !== current.type ||
    merged.values.importance !== current.importance ||
    !sameSet(merged.values.keywords, current.keywords) ||
    !sameSet(merged.values.tags, current.tags);

  return {
    applied: merged.applied,
    skipped: merged.skipped,
    nothingApplied: fullyLocked || merged.applied.length === 0,
    changed,
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((value) => setB.has(value));
}

/** Item ids the model must never be able to address. Kept for documentation. */
export const MODEL_WRITE_DENYLIST: readonly (keyof ItemDTO)[] = [
  'id',
  'capturedText',
  'rawText',
  'rawVersion',
  'revision',
  'manualFields',
  'status',
  'lastRunId',
  'error',
  'sourceType',
  'sourceRef',
  'createdAt',
  'updatedAt',
];

/** Convenience for callers that need the "still valid" check without writing. */
export function assertRevision(
  item: ItemDTO,
  expectedRevision: number,
): asserts item is ItemDTO {
  if (item.revision !== expectedRevision) {
    throw new AppError('REVISION_CONFLICT', '版本不一致');
  }
}
