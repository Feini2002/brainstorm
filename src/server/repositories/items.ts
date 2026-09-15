/**
 * Item repository: the only place that reads or writes knowledge_items.
 *
 * All values are bound parameters; sort columns and directions come from a
 * whitelist. Aggregating tags through a join keeps list queries free of N+1
 * lookups, and updates are guarded by `WHERE id = ? AND revision = ?` so a
 * zero-row update is reported as a conflict instead of a fake success.
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import { notFound, validationError } from '@/domain/errors';
import type { ItemDTO, ItemStatus, ItemType, ManualField, SourceType, UUID } from '@/domain/knowledge';
import { canonicalJson } from '@/domain/canonicalJson';
import { ITEM_COLUMNS, decodeItemRow, parseJsonColumn } from './mappers';
import { requireRow } from './shared';

export interface CreateCaptureRow {
  id: UUID;
  captureRequestId: UUID;
  captureRequestHash: string;
  capturedText: string;
  rawText: string;
  sourceType: SourceType;
  sourceRef: string | null;
  now: string;
}

export interface ItemListFilters {
  q?: string;
  type?: ItemType;
  status?: ItemStatus;
  tagId?: UUID;
}

export interface CursorPayload {
  sort: 'newest' | 'oldest' | 'importance';
  sortValue: string | number;
  id: UUID;
  filterHash: string;
}

/** Tag lookup join produces one row per (item, tag); collapse in insertion order. */
const ITEM_WITH_TAGS_SQL = `
  SELECT ${ITEM_COLUMNS},
         (SELECT json_group_array(t.label)
            FROM (SELECT t.label AS label
                    FROM item_tags it JOIN tags t ON t.id = it.tag_id
                   WHERE it.item_id = knowledge_items.id
                   ORDER BY it.position) AS t) AS tags_json
    FROM knowledge_items
`;

export function findItemRow(db: DatabaseSync, id: UUID): Record<string, unknown> | null {
  const row = db.prepare(`${ITEM_WITH_TAGS_SQL} WHERE knowledge_items.id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ?? null;
}

export function getItem(db: DatabaseSync, id: UUID): ItemDTO {
  const row = findItemRow(db, id);
  if (!row) throw notFound('记录不存在');
  return rowToItem(row);
}

export function getItemOrNull(db: DatabaseSync, id: UUID): ItemDTO | null {
  const row = findItemRow(db, id);
  return row ? rowToItem(row) : null;
}

export function rowToItem(row: Record<string, unknown>): ItemDTO {
  const raw = row.tags_json;
  let tags: string[] = [];
  if (typeof raw === 'string' && raw.length > 0) {
    const parsed = parseJsonColumn<unknown>({ tags_json: raw }, 'tags_json');
    if (Array.isArray(parsed)) {
      tags = parsed.filter((entry): entry is string => typeof entry === 'string');
    }
  }
  return decodeItemRow(row, tags);
}

export function findByCaptureRequestId(
  db: DatabaseSync,
  captureRequestId: UUID,
): { item: ItemDTO; captureRequestHash: string } | null {
  const row = db
    .prepare(`${ITEM_WITH_TAGS_SQL} WHERE knowledge_items.capture_request_id = ?`)
    .get(captureRequestId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    item: rowToItem(row),
    captureRequestHash: String(row.capture_request_hash),
  };
}

export function insertCapture(db: DatabaseSync, input: CreateCaptureRow): void {
  db.prepare(
    `INSERT INTO knowledge_items (
       id, capture_request_id, capture_request_hash, captured_text, raw_text,
       raw_version, revision, structured_base_raw_version, title, summary, type,
       keywords_json, importance, manual_fields_json, status, last_run_id,
       error_code, error_message, source_type, source_ref, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, 1, NULL, '', '', 'idea', '[]', 3, '[]', 'raw', NULL, NULL, NULL, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.captureRequestId,
    input.captureRequestHash,
    input.capturedText,
    input.rawText,
    input.sourceType,
    input.sourceRef,
    input.now,
    input.now,
  );
}

export interface UpdateItemInput {
  id: UUID;
  expectedRevision: number;
  rawText: string;
  rawVersion: number;
  title: string;
  summary: string;
  type: ItemType;
  keywords: string[];
  importance: number;
  manualFields: ManualField[];
  sourceType: SourceType;
  sourceRef: string | null;
  now: string;
}

/**
 * Compare-and-swap field update.
 *
 * Returns the number of changed rows; the caller distinguishes "gone" from
 * "version moved" by re-reading the row.
 */
export function updateItemIfRevision(db: DatabaseSync, input: UpdateItemInput): number {
  const result = db
    .prepare(
      `UPDATE knowledge_items
          SET raw_text = ?, raw_version = ?, title = ?, summary = ?, type = ?,
              keywords_json = ?, importance = ?, manual_fields_json = ?,
              source_type = ?, source_ref = ?,
              revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?`,
    )
    .run(
      input.rawText,
      input.rawVersion,
      input.title,
      input.summary,
      input.type,
      JSON.stringify(input.keywords),
      input.importance,
      JSON.stringify(input.manualFields),
      input.sourceType,
      input.sourceRef,
      input.now,
      input.id,
      input.expectedRevision,
    );
  return Number(result.changes);
}

/** Update only the status column plus the last-run pointer. */
export function updateItemStatus(
  db: DatabaseSync,
  id: UUID,
  status: ItemStatus,
  lastRunId: UUID | null,
  error: { code: string; message: string } | null,
  now: string,
): void {
  db.prepare(
    `UPDATE knowledge_items
        SET status = ?, last_run_id = ?, error_code = ?, error_message = ?, updated_at = ?
      WHERE id = ?`,
  ).run(status, lastRunId, error?.code ?? null, error?.message ?? null, now, id);
}

export interface UpdateStructuredInput {
  id: UUID;
  expectedRevision: number;
  title: string;
  summary: string;
  type: ItemType;
  keywords: string[];
  importance: number;
  manualFields: ManualField[];
  structuredBaseRawVersion: number;
  now: string;
}

/** Apply organized fields (CAS on revision) without touching raw text. */
export function updateItemStructuredIfRevision(
  db: DatabaseSync,
  input: UpdateStructuredInput,
): number {
  const result = db
    .prepare(
      `UPDATE knowledge_items
          SET title = ?, summary = ?, type = ?, keywords_json = ?, importance = ?,
              manual_fields_json = ?, structured_base_raw_version = ?,
              revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?`,
    )
    .run(
      input.title,
      input.summary,
      input.type,
      JSON.stringify(input.keywords),
      input.importance,
      JSON.stringify(input.manualFields),
      input.structuredBaseRawVersion,
      input.now,
      input.id,
      input.expectedRevision,
    );
  return Number(result.changes);
}

export function deleteItem(db: DatabaseSync, id: UUID, expectedRevision: number): number {
  const result = db
    .prepare('DELETE FROM knowledge_items WHERE id = ? AND revision = ?')
    .run(id, expectedRevision);
  return Number(result.changes);
}

export interface ListItemsResult {
  items: ItemDTO[];
  nextCursor: string | null;
  totalMatched: number;
}

const SORT_SQL: Record<CursorPayload['sort'], { order: string; column: string }> = {
  newest: { order: 'DESC', column: 'knowledge_items.created_at' },
  oldest: { order: 'ASC', column: 'knowledge_items.created_at' },
  importance: { order: 'DESC', column: 'knowledge_items.importance' },
};

export interface ListItemsInput {
  filters: ItemListFilters;
  sort: CursorPayload['sort'];
  limit: number;
  cursor: CursorPayload | null;
}

/** Escape LIKE wildcards so a query searches for literal characters. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (char) => `\\${char}`);
}

export function listItems(db: DatabaseSync, input: ListItemsInput): ListItemsResult {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (input.filters.q !== undefined && input.filters.q.length > 0) {
    const pattern = `%${escapeLike(input.filters.q)}%`;
    // Tag labels are part of the documented search scope (T016-R01: "搜索覆盖
    // rawText、title、summary 和标签名"), and the Library's search box says so.
    // Searching the join table rather than a JSON column is the same rule the
    // candidate retrieval uses, so "AI" finds a note tagged "AI" in both places.
    where.push(
      `(knowledge_items.title LIKE ? ESCAPE '\\' OR knowledge_items.summary LIKE ? ESCAPE '\\'
        OR knowledge_items.raw_text LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id
           WHERE it.item_id = knowledge_items.id
             AND t.label LIKE ? ESCAPE '\\'
        ))`,
    );
    params.push(pattern, pattern, pattern, pattern);
  }
  if (input.filters.type) {
    where.push('knowledge_items.type = ?');
    params.push(input.filters.type);
  }
  if (input.filters.status) {
    where.push('knowledge_items.status = ?');
    params.push(input.filters.status);
  }
  if (input.filters.tagId) {
    where.push(
      `EXISTS (SELECT 1 FROM item_tags it WHERE it.item_id = knowledge_items.id AND it.tag_id = ?)`,
    );
    params.push(input.filters.tagId);
  }

  const sortSpec = SORT_SQL[input.sort];

  const countRow = db
    .prepare(
      `SELECT COUNT(*) AS total FROM knowledge_items ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}`,
    )
    .get(...params) as { total: number } | undefined;
  const totalMatched = Number(countRow?.total ?? 0);

  // The cursor predicate is a WHERE condition like any other, so it is pushed
  // into the same list. Concatenating it separately produced `... FROM t AND (...)`
  // whenever no other filter was set (a real syntax error on page 2 of an
  // unfiltered list), so both fragments now share one `WHERE` builder.
  const cursorParams: (string | number)[] = [];
  if (input.cursor) {
    const comparison = sortSpec.order === 'DESC' ? '<' : '>';
    where.push(
      `(${sortSpec.column} ${comparison} ? ` +
        `OR (${sortSpec.column} = ? AND knowledge_items.id ${comparison} ?))`,
    );
    cursorParams.push(input.cursor.sortValue, input.cursor.sortValue, input.cursor.id);
  }

  const allParams = [...params, ...cursorParams, input.limit + 1];
  const rows = db
    .prepare(
      `${ITEM_WITH_TAGS_SQL}
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY ${sortSpec.column} ${sortSpec.order}, knowledge_items.id ${sortSpec.order}
        LIMIT ?`,
    )
    .all(...allParams) as Record<string, unknown>[];

  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const items = pageRows.map(rowToItem);

  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1];
    // `sortColumn` is qualified (`knowledge_items.created_at`), while the row
    // object is keyed by the bare column name, so the prefix is stripped here.
    const sortColumn = sortSpec.column.split('.').pop() as string;
    const sortValueRaw = last[sortColumn];
    nextCursor = encodeCursor({
      sort: input.sort,
      sortValue:
        typeof sortValueRaw === 'number' ? sortValueRaw : String(sortValueRaw),
      id: String(last.id),
      filterHash: filterHash(input.filters, input.sort),
    });
  }

  return { items, nextCursor, totalMatched };
}

export function encodeCursor(cursor: CursorPayload): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw validationError('游标格式不合法');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw validationError('游标格式不合法');
  }
  const record = parsed as Record<string, unknown>;
  const sort = record.sort;
  if (sort !== 'newest' && sort !== 'oldest' && sort !== 'importance') {
    throw validationError('游标排序方式不合法');
  }
  const sortValue = record.sortValue;
  if (typeof sortValue !== 'string' && typeof sortValue !== 'number') {
    throw validationError('游标缺少排序值');
  }
  if (typeof record.id !== 'string' || typeof record.filterHash !== 'string') {
    throw validationError('游标缺少必要字段');
  }
  return {
    sort,
    sortValue,
    id: record.id,
    filterHash: record.filterHash,
  };
}

/** Stable hash of the filter set; a cursor may only be reused with the same filter. */
export function filterHash(filters: ItemListFilters, sort: CursorPayload['sort']): string {
  return canonicalJson({
    q: filters.q ?? null,
    type: filters.type ?? null,
    status: filters.status ?? null,
    tagId: filters.tagId ?? null,
    sort,
  });
}

/**
 * Which of the supplied ids still exist.
 *
 * Used to bound a layout write: only live ids may keep a stored coordinate
 * (T047-R04). This asks about the exact ids in the request instead of reading a
 * page of items, because a page is capped by `limit` and would misreport every
 * valid coordinate beyond the cap as "vanished". Ids are chunked so the statement
 * stays well inside SQLite's bound-parameter limit.
 */
export function existingItemIds(db: DatabaseSync, ids: readonly string[]): Set<string> {
  const unique = [...new Set(ids)];
  const found = new Set<string>();
  const CHUNK = 400;
  for (let start = 0; start < unique.length; start += CHUNK) {
    const chunk = unique.slice(start, start + CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT id FROM knowledge_items WHERE id IN (${placeholders})`)
      .all(...chunk) as { id: string }[];
    for (const row of rows) found.add(String(row.id));
  }
  return found;
}

/**
 * Read exactly the requested items, in the order the ids were given.
 *
 * A saved View's explicit selection is a *set of ids*, and the list endpoint is
 * a *page ordered by recency*. Using the page to resolve the set made every
 * selected item that fell outside the newest N rows look deleted — the view
 * reported it as a missing source, and the graph silently dropped a node the
 * user had deliberately saved. Reading by id removes the ceiling entirely.
 *
 * Unknown ids are simply absent from the result: "the item is gone" is a fact
 * the caller decides how to report, not an error here.
 */
export function listItemsByIds(db: DatabaseSync, ids: readonly UUID[]): ItemDTO[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const byId = new Map<string, ItemDTO>();
  const CHUNK = 400;
  for (let start = 0; start < unique.length; start += CHUNK) {
    const chunk = unique.slice(start, start + CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db
      .prepare(`${ITEM_WITH_TAGS_SQL} WHERE knowledge_items.id IN (${placeholders})`)
      .all(...chunk) as Record<string, unknown>[];
    for (const row of rows) {
      const item = rowToItem(row);
      byId.set(item.id, item);
    }
  }
  // Preserve the caller's order so a snapshot's item list stays reproducible.
  return unique.map((id) => byId.get(id)).filter((item): item is ItemDTO => item !== undefined);
}

/** Versions of exactly the requested items; absent ids mean the item is gone. */
export function readItemVersionsByIds(
  db: DatabaseSync,
  ids: readonly UUID[],
): Map<string, { rawVersion: number; revision: number }> {
  const unique = [...new Set(ids)];
  const result = new Map<string, { rawVersion: number; revision: number }>();
  if (unique.length === 0) return result;
  const CHUNK = 400;
  for (let start = 0; start < unique.length; start += CHUNK) {
    const chunk = unique.slice(start, start + CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT id, raw_version, revision FROM knowledge_items WHERE id IN (${placeholders})`,
      )
      .all(...chunk) as { id: string; raw_version: number; revision: number }[];
    for (const row of rows) {
      result.set(String(row.id), {
        rawVersion: Number(row.raw_version),
        revision: Number(row.revision),
      });
    }
  }
  return result;
}

/** Tags for an item, ordered by position. */
export function listItemTags(db: DatabaseSync, itemId: UUID): string[] {
  const rows = db
    .prepare(
      `SELECT t.label AS label FROM item_tags it
         JOIN tags t ON t.id = it.tag_id
        WHERE it.item_id = ? ORDER BY it.position`,
    )
    .all(itemId) as { label: string }[];
  return rows.map((row) => row.label);
}

export { requireRow };
