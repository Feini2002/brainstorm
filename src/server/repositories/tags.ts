/**
 * Tag dictionary repository.
 *
 * Tags are the authoritative label store; item tags are a projection rebuilt
 * inside the caller's transaction. Creating a tag is part of the Item/Relation
 * domain service, not a standalone "run arbitrary tag SQL" endpoint.
 */
import 'server-only';

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { TagDTO, UUID } from '@/domain/knowledge';
import { normalizeTag } from '@/domain/tags';
import { LIMITS } from '@/domain/limits';
import { escapeLike } from './items';

export function findTagByNormalized(db: DatabaseSync, normalized: string): UUID | null {
  const row = db.prepare('SELECT id FROM tags WHERE normalized = ?').get(normalized) as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

/**
 * Reuse an existing tag by normalized key or create it. Returns the tag ID.
 * Must be called inside a transaction that also writes item_tags.
 */
export function ensureTag(db: DatabaseSync, label: string, now: string): UUID {
  const normalized = normalizeTag(label);
  const existing = findTagByNormalized(db, normalized);
  if (existing) return existing;

  const id = randomUUID();
  db.prepare('INSERT INTO tags (id, label, normalized, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    label,
    normalized,
    now,
  );
  return id;
}

/** Replace the whole tag mapping of one item, preserving position order. */
export function setItemTags(db: DatabaseSync, itemId: UUID, labels: readonly string[], now: string): void {
  db.prepare('DELETE FROM item_tags WHERE item_id = ?').run(itemId);
  const limited = labels.slice(0, LIMITS.tagsPerItem);
  limited.forEach((label, position) => {
    const tagId = ensureTag(db, label, now);
    db.prepare(
      'INSERT INTO item_tags (item_id, tag_id, position) VALUES (?, ?, ?)',
    ).run(itemId, tagId, position);
  });
}

export function listTags(db: DatabaseSync, query?: string): TagDTO[] {
  const params: string[] = [];
  let filter = '';
  if (query !== undefined && query.length > 0) {
    filter = "WHERE t.label LIKE ? ESCAPE '\\' OR t.normalized LIKE ? ESCAPE '\\'";
    const pattern = `%${escapeLike(query)}%`;
    params.push(pattern, pattern);
  }

  const rows = db
    .prepare(
      `SELECT t.id AS id, t.label AS label, t.normalized AS normalized,
              (SELECT COUNT(*) FROM item_tags it WHERE it.tag_id = t.id) AS item_count
         FROM tags t
         ${filter}
        ORDER BY item_count DESC, t.label ASC`,
    )
    .all(...params) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: String(row.id),
    label: String(row.label),
    normalized: String(row.normalized),
    itemCount: Number(row.item_count),
  }));
}

export function getTag(db: DatabaseSync, id: UUID): TagDTO | null {
  const row = db
    .prepare(
      `SELECT t.id AS id, t.label AS label, t.normalized AS normalized,
              (SELECT COUNT(*) FROM item_tags it WHERE it.tag_id = t.id) AS item_count
         FROM tags t WHERE t.id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    label: String(row.label),
    normalized: String(row.normalized),
    itemCount: Number(row.item_count),
  };
}

/**
 * Remove tags that are no longer referenced by any item. Optional maintenance;
 * not part of the main flow.
 */
export function pruneOrphanTags(db: DatabaseSync): number {
  const result = db
    .prepare('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM item_tags)')
    .run();
  return Number(result.changes);
}
