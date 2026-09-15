/**
 * Whole-library logical export (T070).
 *
 * Two ordering decisions carry this task's rules, and both are about *when* work
 * happens rather than what it produces:
 *
 *   1. **Read everything inside one short transaction, serialize outside it**
 *      (R02). Selecting items and *then* relations would let a delete land in
 *      between, producing a bundle whose relation endpoints are gone — the one
 *      shape `/import` must reject, and the one a backup must never create. So
 *      the transaction covers every read, closes, and only then does JSON
 *      serialization and byte measurement run (measuring inside would hold a
 *      read lock while formatting large strings for no benefit).
 *
 *   2. **Every column is named explicitly** (R01). There is no `SELECT *` and no
 *      table iteration, so `settings` and `secrets` cannot be reached even by a
 *      future edit that adds a column — the statement would have to name it.
 *      `ai_runs` is not queried at all, so every `runId` in the output is `null`
 *      by construction rather than by a redaction pass that could miss one.
 *
 * The transaction is read-only in effect: it issues only SELECTs, and the
 * connection is left in autocommit so nothing is written back.
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import {
  BACKUP_SCHEMA_VERSION,
  backupFileName,
  checkSizeBudget,
  countBundle,
  sizeExceededMessage,
  type BackupBundle,
  type BackupItem,
  type BackupItemTag,
  type BackupRelation,
  type BackupTag,
  type BackupView,
} from '@/domain/exportBundle';
import { parseJsonColumn } from '@/server/repositories/mappers';
import {
  ITEM_TYPES,
  MANUAL_FIELDS,
  RELATION_ORIGINS,
  RELATION_TYPES,
  REVIEW_STATUSES,
  SOURCE_TYPES,
  type Evidence,
  type ItemType,
  type ManualField,
  type RelationOrigin,
  type RelationType,
  type ReviewStatus,
  type SelectionSpec,
  type SourceSnapshot,
  type SourceType,
  type ViewKind,
} from '@/domain/knowledge';

/** `knowledge.ts` does not export a view-kind list; this is the one definition. */
const VIEW_KINDS = ['graph', 'mindmap', 'flow'] as const;

/**
 * Columns for the backup, spelled out per R01.
 *
 * This is a second list alongside `ITEM_COLUMNS` on purpose. `ITEM_COLUMNS` is
 * the *runtime read* projection and legitimately grows with the feature set
 * (it carries `status`, `last_run_id`, `error_*`). The backup projection must
 * stay narrow, so sharing one list would mean every future read-path addition
 * silently expands the backup — including status columns the contract forbids.
 */
const BACKUP_ITEM_COLUMNS = [
  'id',
  'capture_request_id',
  'capture_request_hash',
  'captured_text',
  'raw_text',
  'raw_version',
  'revision',
  'structured_base_raw_version',
  'title',
  'summary',
  'type',
  'keywords_json',
  'importance',
  'manual_fields_json',
  'source_type',
  'source_ref',
  'created_at',
  'updated_at',
].join(', ');

const BACKUP_RELATION_COLUMNS = [
  'id',
  'source_id',
  'target_id',
  'relation_type',
  'origin',
  'review_status',
  'score',
  'reason',
  'evidence_json',
  'source_raw_version',
  'target_raw_version',
  'revision',
  'created_at',
  'updated_at',
].join(', ');

const BACKUP_VIEW_COLUMNS = [
  'id',
  'name',
  'kind',
  'selection_json',
  'source_snapshot_json',
  'content_json',
  'content_hash',
  'renderer_version',
  'prompt_version',
  'revision',
  'generated_at',
  'created_at',
  'updated_at',
].join(', ');

function asString(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value === 'string') return value;
  throw new AppError('INTERNAL', `导出失败：列 ${column} 不是字符串`);
}

function asNullableString(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  throw new AppError('INTERNAL', `导出失败：列 ${column} 期望字符串或 null`);
}

function asNumber(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new AppError('INTERNAL', `导出失败：列 ${column} 不是数字`);
}

function asNullableNumber(row: Record<string, unknown>, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new AppError('INTERNAL', `导出失败：列 ${column} 期望数字或 null`);
}

/**
 * Narrow a stored enum to its union.
 *
 * A row that violates its CHECK constraint should already be impossible, but if
 * one exists the export must fail loudly instead of writing an unchecked string
 * into a file the user will treat as their backup. The message names the column
 * and value but never the row's text content.
 */
function asEnum<T extends string>(
  row: Record<string, unknown>,
  column: string,
  allowed: readonly T[],
): T {
  const value = asString(row, column);
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new AppError('INTERNAL', `导出失败：列 ${column} 含未知值 ${value}`);
}

function asStringArray(value: unknown, column: string): string[] {
  if (!Array.isArray(value)) {
    throw new AppError('INTERNAL', `导出失败：${column} 期望数组`);
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new AppError('INTERNAL', `导出失败：${column} 含非字符串元素`);
    }
    result.push(entry);
  }
  return result;
}

/** Read every column the backup needs, in one pass per table. */
function readItems(db: DatabaseSync): BackupItem[] {
  const rows = db
    .prepare(`SELECT ${BACKUP_ITEM_COLUMNS} FROM knowledge_items ORDER BY created_at ASC, id ASC`)
    .all() as Record<string, unknown>[];

  return rows.map((row) => {
    const keywords = parseJsonColumn<unknown>(row, 'keywords_json');
    const manualRaw = parseJsonColumn<unknown>(row, 'manual_fields_json');
    const manualFields: ManualField[] = [];
    for (const field of asStringArray(manualRaw, 'manual_fields_json')) {
      if (!(MANUAL_FIELDS as readonly string[]).includes(field)) {
        throw new AppError('INTERNAL', `导出失败：manual_fields_json 含未知字段 ${field}`);
      }
      manualFields.push(field as ManualField);
    }

    return {
      id: asString(row, 'id'),
      captureRequestId: asString(row, 'capture_request_id'),
      captureRequestHash: asString(row, 'capture_request_hash'),
      capturedText: asString(row, 'captured_text'),
      rawText: asString(row, 'raw_text'),
      rawVersion: asNumber(row, 'raw_version'),
      revision: asNumber(row, 'revision'),
      structuredBaseRawVersion: asNullableNumber(row, 'structured_base_raw_version'),
      title: asString(row, 'title'),
      summary: asString(row, 'summary'),
      type: asEnum(row, 'type', ITEM_TYPES) as ItemType,
      keywords: asStringArray(keywords, 'keywords_json'),
      importance: asNumber(row, 'importance'),
      manualFields,
      sourceType: asEnum(row, 'source_type', SOURCE_TYPES) as SourceType,
      sourceRef: asNullableString(row, 'source_ref'),
      createdAt: asString(row, 'created_at'),
      updatedAt: asString(row, 'updated_at'),
    } satisfies BackupItem;
  });
}

function readTags(db: DatabaseSync): BackupTag[] {
  const rows = db
    .prepare('SELECT id, label, normalized, created_at FROM tags ORDER BY normalized ASC')
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    id: asString(row, 'id'),
    label: asString(row, 'label'),
    normalized: asString(row, 'normalized'),
    createdAt: asString(row, 'created_at'),
  }));
}

function readItemTags(db: DatabaseSync): BackupItemTag[] {
  const rows = db
    .prepare('SELECT item_id, tag_id, position FROM item_tags ORDER BY item_id ASC, position ASC')
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    itemId: asString(row, 'item_id'),
    tagId: asString(row, 'tag_id'),
    position: asNumber(row, 'position'),
  }));
}

function readRelations(db: DatabaseSync): BackupRelation[] {
  const rows = db
    .prepare(`SELECT ${BACKUP_RELATION_COLUMNS} FROM relations ORDER BY created_at ASC, id ASC`)
    .all() as Record<string, unknown>[];

  return rows.map((row) => {
    const evidence = parseJsonColumn<unknown>(row, 'evidence_json');
    return {
      id: asString(row, 'id'),
      sourceId: asString(row, 'source_id'),
      targetId: asString(row, 'target_id'),
      type: asEnum(row, 'relation_type', RELATION_TYPES) as RelationType,
      origin: asEnum(row, 'origin', RELATION_ORIGINS) as RelationOrigin,
      reviewStatus: asEnum(row, 'review_status', REVIEW_STATUSES) as ReviewStatus,
      score: asNullableNumber(row, 'score'),
      reason: asString(row, 'reason'),
      evidence: evidence as Evidence[],
      sourceRawVersion: asNumber(row, 'source_raw_version'),
      targetRawVersion: asNumber(row, 'target_raw_version'),
      revision: asNumber(row, 'revision'),
      createdAt: asString(row, 'created_at'),
      updatedAt: asString(row, 'updated_at'),
    } satisfies BackupRelation;
  });
}

function readViews(db: DatabaseSync): BackupView[] {
  const rows = db
    .prepare(`SELECT ${BACKUP_VIEW_COLUMNS} FROM views ORDER BY created_at ASC, id ASC`)
    .all() as Record<string, unknown>[];

  return rows.map((row) => {
    // `null` for a missing runId is structural, not redaction: the column is not
    // in BACKUP_VIEW_COLUMNS, so there is no value to strip.
    return {
      id: asString(row, 'id'),
      name: asString(row, 'name'),
      kind: asEnum(row, 'kind', VIEW_KINDS) as ViewKind,
      selection: parseJsonColumn<SelectionSpec>(row, 'selection_json'),
      sourceSnapshot: parseJsonColumn<SourceSnapshot>(row, 'source_snapshot_json'),
      content: parseJsonColumn<unknown>(row, 'content_json'),
      contentHash: asNullableString(row, 'content_hash'),
      rendererVersion: asString(row, 'renderer_version'),
      promptVersion: asNullableString(row, 'prompt_version'),
      revision: asNumber(row, 'revision'),
      generatedAt: asNullableString(row, 'generated_at'),
      createdAt: asString(row, 'created_at'),
      updatedAt: asString(row, 'updated_at'),
    } satisfies BackupView;
  });
}

export interface ExportOutcome {
  bundle: BackupBundle;
  bytes: number;
  counts: ReturnType<typeof countBundle>;
  /** Fixed download name derived from `exportedAt` (R05). */
  fileName: string;
}

/**
 * Build the export bundle, or fail with a size error and no file (R04).
 *
 * Returns the bundle rather than a serialized string so the route decides the
 * response headers, and so a caller can hash exactly what was measured.
 *
 * @param now injected so `exportedAt` is deterministic in tests; the route
 *   passes the real clock.
 */
export function exportKnowledge(db: DatabaseSync, now: Date = new Date()): ExportOutcome {
  const bundle = readConsistentSnapshot(db, now);

  // Measured after the transaction closes: serialization of a large library is
  // the expensive part and needs no lock.
  const budget = checkSizeBudget(bundle);
  if (budget.exceeded) {
    // IMPORT_INVALID is a 422; the honest shape here is a refusal the user can
    // act on, not a 500. No partial body is produced.
    throw new AppError('VALIDATION', sizeExceededMessage(budget));
  }

  return {
    bundle,
    bytes: budget.bytes,
    counts: countBundle(bundle),
    fileName: backupFileName(bundle.exportedAt),
  };
}

/**
 * All reads inside one transaction (R02).
 *
 * The `BEGIN`/`COMMIT` pair is written out rather than using `withTransaction`
 * so the transaction opens with `BEGIN` (deferred) instead of `BEGIN IMMEDIATE`:
 * export is read-only by intent, and taking a write lock to read would block a
 * capture that has nothing to do with backing up. The callback form is also
 * avoided because it forbids returning a promise and this function is synchronous
 * anyway — the explicit form keeps the read-only intent visible at the call
 * site.
 */
function readConsistentSnapshot(db: DatabaseSync, now: Date): BackupBundle {
  db.exec('BEGIN');
  let committed = false;
  try {
    const data = {
      knowledgeItems: readItems(db),
      tags: readTags(db),
      itemTags: readItemTags(db),
      relations: readRelations(db),
      views: readViews(db),
    };
    db.exec('COMMIT');
    committed = true;

    return {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: now.toISOString(),
      data,
    };
  } catch (error) {
    if (!committed) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Keep the original failure; a rollback error is secondary.
      }
    }
    throw error as AppError;
  }
}
