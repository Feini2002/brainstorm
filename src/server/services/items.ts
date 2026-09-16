/**
 * Capture and item editing services.
 *
 * Capture order is non-negotiable (docs/00_product/01_product_contract.md §1):
 * the raw text is persisted and gets an ID first; only then may any AI step run.
 * A provider timeout can therefore never lose the user's material.
 */
import 'server-only';

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { AppError, notFound, revisionConflict, validationError } from '@/domain/errors';
import type { ItemDTO, UUID } from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import { canonicalJson } from '@/domain/canonicalJson';
import { hashSha256 } from '@/server/crypto/hash';
import {
  changedManualFields,
  isNoOpPatch,
  parseManualFields,
  validateUserPatch,
  type UserPatch,
} from '@/domain/itemFields';
import { normalizeKeywordList, normalizeTagList } from '@/domain/tags';
import { bumpDatasetRevision, withTransaction } from '@/server/db/database';
import {
  deleteItem,
  encodeCursor,
  filterHash,
  findByCaptureRequestId,
  findItemRow,
  getItem,
  insertCapture,
  listItems,
  rowToItem,
  updateItemIfRevision,
  type CursorPayload,
  type ItemListFilters,
} from '@/server/repositories/items';
import { setItemTags } from '@/server/repositories/tags';
import { nowIso } from '@/server/repositories/shared';
import { syncItemStatus } from './status';
import { decodeCursor } from '@/server/repositories/items';

export interface CaptureInput {
  captureRequestId: UUID;
  rawText: string;
  sourceType: ItemDTO['sourceType'];
  sourceRef: string | null;
}

export interface CaptureResult {
  item: ItemDTO;
  replayed: boolean;
}

/** Stable fingerprint over user-controlled capture fields only. */
export function captureRequestHash(input: CaptureInput): string {
  return hashSha256(
    canonicalJson({
      rawText: input.rawText,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
    }),
  );
}

export class CaptureKeyConflictError extends AppError {
  constructor() {
    super('CAPTURE_KEY_CONFLICT', '同一次保存动作的内容已改变，请作为新的保存重试');
    this.name = 'CaptureKeyConflictError';
  }
}

/**
 * Create an item, or replay the existing one for the same capture request key.
 *
 * Same key + same fingerprint returns the stored item with replayed=true; same
 * key with different content is a conflict, never a silent second insert.
 */
export function createCapture(db: DatabaseSync, input: CaptureInput): CaptureResult {
  const hash = captureRequestHash(input);

  const existing = findByCaptureRequestId(db, input.captureRequestId);
  if (existing) {
    if (existing.captureRequestHash !== hash) throw new CaptureKeyConflictError();
    return { item: existing.item, replayed: true };
  }

  if (input.rawText.trim().length === 0) {
    throw validationError('原文不能为空', { rawText: ['原文不能为空'] });
  }
  if (Array.from(input.rawText).length > LIMITS.rawTextCodePoints) {
    throw validationError('原文过长', {
      rawText: [`原文不能超过 ${LIMITS.rawTextCodePoints} 个字符`],
    });
  }

  const id = randomUUID();
  const now = nowIso();

  try {
    withTransaction(db, () => {
      insertCapture(db, {
        id,
        captureRequestId: input.captureRequestId,
        captureRequestHash: hash,
        capturedText: input.rawText,
        rawText: input.rawText,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        now,
      });
      bumpDatasetRevision(db);
    });
  } catch (error) {
    /**
     * Two concurrent requests with the same key: the loser replays the winner.
     *
     * The detailed constraint message is the only place this is visible —
     * `withTransaction` maps a raw `UNIQUE constraint failed: …` onto
     * `DatabaseError('数据唯一性冲突')`, whose message no longer names the
     * constraint. Matching only the raw regex would therefore classify every
     * lost race as an unexpected 500 and, worse, hide a genuine conflict.
     * Both shapes are recognized, then the key is re-read to decide whether
     * this is a replay (same fingerprint) or a real conflict.
     */
    if (isCaptureKeyViolation(error)) {
      const raced = findByCaptureRequestId(db, input.captureRequestId);
      if (raced && raced.captureRequestHash === hash) {
        return { item: raced.item, replayed: true };
      }
      throw new CaptureKeyConflictError();
    }
    throw error;
  }

  return { item: getItem(db, id), replayed: false };
}

/**
 * Did this failure come from the `knowledge_items.capture_request_id` UNIQUE
 * index?
 *
 * Deliberately not "any UNIQUE failure": `findByCaptureRequestId` below is what
 * proves the row is actually there, so an unrelated constraint violation still
 * propagates instead of being reported as a capture key conflict.
 */
function isCaptureKeyViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    /UNIQUE constraint failed/u.test(error.message) ||
    error.message === '数据唯一性冲突'
  );
}

export interface PatchItemInput {
  id: UUID;
  expectedRevision: number;
  patch: UserPatch;
  unlockFields?: string[];
}

/**
 * Apply a user edit.
 *
 * The server — not the browser — decides which fields become manually locked,
 * based on which fields actually changed. An identical PATCH is a no-op: no
 * column write, no revision bump, no dataset revision bump.
 */
export function patchItem(db: DatabaseSync, input: PatchItemInput): ItemDTO {
  const current = getItem(db, input.id);

  if (current.revision !== input.expectedRevision) {
    throw revisionConflict('该记录已被其他窗口更新，请先重新载入');
  }

  const { fieldErrors } = validateUserPatch(input.patch);
  if (Object.keys(fieldErrors).length > 0) {
    throw validationError('输入不合法', fieldErrors);
  }

  const unlockFields = input.unlockFields ? parseManualFields(input.unlockFields) : [];

  if (isNoOpPatch(current, input.patch) && unlockFields.length === 0) {
    return current;
  }

  const changed = changedManualFields(current, input.patch);
  const manualSet = new Set(current.manualFields);
  for (const field of changed) manualSet.add(field);
  for (const field of unlockFields) manualSet.delete(field);
  const manualFields = [...manualSet];

  const rawText = input.patch.rawText ?? current.rawText;
  const rawVersion =
    input.patch.rawText !== undefined && input.patch.rawText !== current.rawText
      ? current.rawVersion + 1
      : current.rawVersion;

  const tags =
    input.patch.tags !== undefined
      ? normalizeTagList(input.patch.tags).labels
      : current.tags;
  const keywords =
    input.patch.keywords !== undefined
      ? normalizeKeywordList(input.patch.keywords).keywords
      : current.keywords;

  const now = nowIso();

  withTransaction(db, () => {
    const changes = updateItemIfRevision(db, {
      id: current.id,
      expectedRevision: input.expectedRevision,
      rawText,
      rawVersion,
      title: input.patch.title ?? current.title,
      summary: input.patch.summary ?? current.summary,
      type: input.patch.type ?? current.type,
      keywords,
      importance: input.patch.importance ?? current.importance,
      manualFields,
      sourceType: input.patch.sourceType ?? current.sourceType,
      sourceRef:
        input.patch.sourceRef !== undefined ? input.patch.sourceRef : current.sourceRef,
      now,
    });

    if (changes === 0) {
      // Re-read to distinguish "deleted" from "version moved" inside the transaction.
      const live = findItemRow(db, current.id);
      if (!live) throw notFound('记录已被删除');
      throw revisionConflict();
    }

    if (input.patch.tags !== undefined) {
      setItemTags(db, current.id, tags, now);
    }

    bumpDatasetRevision(db);
    syncItemStatus(db, current.id);
  });

  return getItem(db, input.id);
}

export function deleteItemById(
  db: DatabaseSync,
  id: UUID,
  expectedRevision: number,
): { deletedId: UUID } {
  const current = getItem(db, id);
  if (current.revision !== expectedRevision) throw revisionConflict();

  withTransaction(db, () => {
    const changes = deleteItem(db, id, expectedRevision);
    if (changes === 0) {
      const live = findItemRow(db, id);
      if (!live) throw notFound('记录已被删除');
      throw revisionConflict();
    }
    // Foreign keys cascade to relations and item_tags; the tag dictionary is
    // intentionally left intact, and historical views keep their context.
    bumpDatasetRevision(db);
  });

  return { deletedId: id };
}

export interface ListItemsServiceInput {
  filters: ItemListFilters;
  sort: CursorPayload['sort'];
  limit?: number;
  cursor?: string;
}

export function listItemsService(
  db: DatabaseSync,
  input: ListItemsServiceInput,
): { items: ItemDTO[]; nextCursor: string | null; totalMatched: number } {
  const limit = input.limit ?? LIMITS.listPageSizeDefault;
  let cursor: CursorPayload | null = null;

  if (input.cursor !== undefined) {
    cursor = decodeCursor(input.cursor);
    const expected = filterHash(input.filters, input.sort);
    if (cursor.filterHash !== expected) {
      throw validationError('游标与当前筛选条件不匹配，请重新搜索');
    }
    if (cursor.sort !== input.sort) {
      throw validationError('游标排序方式与当前查询不匹配');
    }
  }

  return listItems(db, {
    filters: input.filters,
    sort: input.sort,
    limit,
    cursor,
  });
}

/** Tags for a single item, used by detail views. */
export function itemTags(db: DatabaseSync, id: UUID): string[] {
  return getItem(db, id).tags;
}

export { encodeCursor, rowToItem };
