import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normalizeTag } from '@/domain/tags';

import { E2E_DATA_DIR } from './env';

/**
 * Fixture seeding for rows the UI cannot produce without a model.
 *
 * Two kinds of data are needed by the graph/projection acceptance cases but have
 * no user-facing creation path in this version:
 *
 *  - an **AI** relation (with score and evidence), which only the organize
 *    pipeline writes, and
 *  - a **generated** view (mindmap / flow), which only a model-backed generation
 *    route writes.
 *
 * The honest options are (a) add a "test mode" to the product, or (b) seed the
 * suite's own throwaway database. (a) is ruled out by T011-C03 — a shipped test
 * entrance that returns fixed fake results is a false delivery. So this file
 * writes rows directly into `tests/e2e/.data`, which is the suite's isolated
 * database and never the user's `.data` (guard: the path must be the e2e one).
 *
 * `contentHash` is deliberately left NULL here. The hash is computed by the
 * service that creates a view; recomputing it in a fixture would only prove the
 * fixture agrees with itself. Read paths do not verify it, so a seeded row is a
 * valid starting state rather than a forged "already validated" one.
 */
/**
 * Refuse anything that is not one of this suite's own throwaway databases.
 *
 * Two directories are legitimate: the shared server's `.data` and the restart
 * case's `.data-restart` (T026-R03). The check is "an e2e `.data*` directory"
 * rather than "exactly `.data`" because T061-C02 has to put its view into the
 * database the *restart* server will open — a view seeded into `.data` and then
 * read from `.data-restart` would simply be missing, which is the opposite of the
 * persistence the case is trying to show.
 */
function refuseUnlessE2eDatabase(databasePath: string): void {
  const resolved = path.resolve(databasePath);
  const parent = path.dirname(resolved);
  const expectedParent = path.resolve(parent, '..', path.basename(parent));
  if (
    parent !== expectedParent ||
    !path.basename(parent).startsWith('.data') ||
    path.basename(path.dirname(parent)) !== 'e2e'
  ) {
    throw new Error(`拒绝写入非 e2e 数据库：${resolved}`);
  }
}

/** The database file for one of the suite's data directories. */
function databasePathFor(dataDir: string): string {
  const databasePath = path.resolve(dataDir, 'brain.db');
  refuseUnlessE2eDatabase(databasePath);
  return databasePath;
}

/**
 * Open the suite's database for seeding.
 *
 * WAL mode plus a busy timeout is what makes a second writer safe: the running
 * server holds its own connection, and a short wait is normal rather than a
 * failure. The caller must close it (`close()`), which the `withSeedDb` helper
 * does.
 */
export function openSeedDb(dataDir: string = E2E_DATA_DIR): DatabaseSync {
  const db = new DatabaseSync(databasePathFor(dataDir));
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 10000');
  return db;
}

export function withSeedDb<T>(action: (db: DatabaseSync) => T, dataDir: string = E2E_DATA_DIR): T {
  const db = openSeedDb(dataDir);
  try {
    return action(db);
  } finally {
    db.close();
  }
}

const SYMMETRIC = new Set(['similar_to', 'contradicts', 'related_to']);

/** Endpoint order the schema enforces for symmetric types (`source_id < target_id`). */
function orderEndpoints(
  sourceId: string,
  targetId: string,
  type: string,
): { sourceId: string; targetId: string } {
  if (!SYMMETRIC.has(type)) return { sourceId, targetId };
  return sourceId < targetId
    ? { sourceId, targetId }
    : { sourceId: targetId, targetId: sourceId };
}

export interface SeededAiRelation {
  id: string;
  sourceId: string;
  targetId: string;
  revision: number;
}

export interface SeedAiRelationInput {
  sourceId: string;
  targetId: string;
  type?: string;
  score?: number;
  reason?: string;
  reviewStatus?: 'suggested' | 'accepted';
  /** Evidence quotes must be real substrings of the endpoint raw text. */
  evidence?: { itemId: string; quote: string }[];
}

/**
 * Insert an AI relation recorded against the endpoints' *current* raw versions.
 *
 * The versions are read inside the same connection rather than passed in, so a
 * seeded edge starts out fresh — a fixture that guessed the version would produce
 * an edge that looks stale for no real reason.
 */
export function seedAiRelation(
  db: DatabaseSync,
  input: SeedAiRelationInput,
): SeededAiRelation {
  const endpoints = orderEndpoints(input.sourceId, input.targetId, input.type ?? 'related_to');
  const readRawVersion = (id: string): number => {
    const row = db
      .prepare('SELECT raw_version FROM knowledge_items WHERE id = ?')
      .get(id) as { raw_version: number } | undefined;
    if (!row) throw new Error(`seedAiRelation: 条目不存在 ${id}`);
    return Number(row.raw_version);
  };
  const readRawText = (id: string): string => {
    const row = db.prepare('SELECT raw_text FROM knowledge_items WHERE id = ?').get(id) as
      | { raw_text: string }
      | undefined;
    if (!row) throw new Error(`seedAiRelation: 条目不存在 ${id}`);
    return String(row.raw_text);
  };

  const evidence = (input.evidence ?? []).map((entry) => ({
    itemId: entry.itemId,
    rawVersion: readRawVersion(entry.itemId),
    quote: entry.quote.slice(0, 120),
  }));
  // A quote the schema could not have produced would make the inspector show a
  // citation that does not exist in the material.
  for (const entry of evidence) {
    if (!readRawText(entry.itemId).includes(entry.quote)) {
      throw new Error(`seedAiRelation: 证据摘录不是原文子串（itemId=${entry.itemId}）`);
    }
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO relations (
       id, source_id, target_id, relation_type, origin, review_status, score, reason,
       evidence_json, source_raw_version, target_raw_version, run_id, revision,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'ai', ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
  ).run(
    id,
    endpoints.sourceId,
    endpoints.targetId,
    input.type ?? 'related_to',
    input.reviewStatus ?? 'suggested',
    input.score ?? 0.85,
    (input.reason ?? 'T049 验收用模型建议').slice(0, 300),
    JSON.stringify(evidence),
    readRawVersion(endpoints.sourceId),
    readRawVersion(endpoints.targetId),
    now,
    now,
  );

  return { id, sourceId: endpoints.sourceId, targetId: endpoints.targetId, revision: 1 };
}

export interface SeedViewInput {
  name: string;
  kind: 'mindmap' | 'flow';  /**
   * Item ids the view's AST cites. These are recorded in the snapshot.
   *
   * Distinct from `selection`: a filter-created view cites a *subset* of what the
   * filter matched, or cites the same items while more have since joined.
   */
  itemIds: string[];
  content: unknown;
  /** Prompt version of the generating template; defaults to the kind's v1. */
  promptVersion?: string;
  /**
   * The selection to store, when it is not simply the cited ids.
   *
   * Defaults to `{mode:'explicit', itemIds}`. Pass a filter selection to seed a
   * view whose scope is re-resolved on every read — the shape T059-C04 needs,
   * where the tag's membership changes after the view was saved.
   *
   * `selectionItems` is what goes into the *snapshot*, and defaults to `itemIds`.
   * The snapshot is deliberately independent of the live selection so a case can
   * pin "generated from what the filter matched then" against "what it matches
   * now" — which is exactly the difference the freshness report describes.
   */
  selection?: {
    mode: 'explicit' | 'filter';
    itemIds?: string[];
    filter?: { type?: string; tagId?: string };
  };
  selectionItems?: string[];
}

/**
 * Put one label on a set of items, creating the tag when it does not exist.
 *
 * Needed by the scale cases, which must pin a read to a few hundred records
 * without an explicit id list (an explicit selection is capped at
 * `selectedItemsPerProjection`, and a filter-mode View is the only scope a user
 * could really create at that size).
 *
 * The tag rows are normalised the same way `repositories/tags.ts` does it, so a
 * label seeded here is the same row the application would have created — a
 * different normalisation would produce a tag the UI could not find.
 */
export function tagItems(itemIds: readonly string[], label: string): string {
  return withSeedDb((db) => {
    const now = new Date().toISOString();
    // The application's own match key, not a re-implementation: a different
    // normalisation would create a tag the UI then could not find.
    const normalized = normalizeTag(label);
    const existing = db.prepare('SELECT id FROM tags WHERE normalized = ?').get(normalized) as
      | { id: string }
      | undefined;
    let tagId = existing?.id;
    if (tagId === undefined) {
      tagId = randomUUID();
      db.prepare('INSERT INTO tags (id, label, normalized, created_at) VALUES (?, ?, ?, ?)').run(
        tagId,
        label,
        normalized,
        now,
      );
    }
    // Position 0 for every member: the constraint is unique per (item, position),
    // so this displaces nothing but a previous position-0 tag on the same item —
    // and every item passed here is freshly created for one case.
    const insert = db.prepare(
      'INSERT OR REPLACE INTO item_tags (item_id, tag_id, position) VALUES (?, ?, 0)',
    );
    for (const itemId of itemIds) insert.run(itemId, tagId);
    return tagId;
  });
}

/**
 * Create a graph View scoped by a filter rather than an id list.
 *
 * The only way to state a scope larger than `selectedItemsPerProjection`, which
 * is exactly the situation T050-C01 is about.
 */


/**
 * Insert a generated view with an already-validated AST.
 *
 * The AST comes from the case, and every referenced item id is checked to exist,
 * so a seeded view is the *result* of validation rather than a way around it.
 */
export function seedView(db: DatabaseSync, input: SeedViewInput): string {
  for (const itemId of input.itemIds) {
    const row = db.prepare('SELECT id, raw_version, revision FROM knowledge_items WHERE id = ?').get(itemId) as
      | { id: string; raw_version: number; revision: number }
      | undefined;
    if (!row) throw new Error(`seedView: 条目不存在 ${itemId}`);
  }

  // The snapshot is built from `selectionItems`, which defaults to the cited ids
  // but may name a different set — that is how a case pins "generated from what
  // the tag matched then" against a tag that has since gained members.
  const snapshotItemIds = input.selectionItems ?? input.itemIds;
  const items = snapshotItemIds.map((itemId) => {
    const row = db
      .prepare('SELECT raw_version, revision FROM knowledge_items WHERE id = ?')
      .get(itemId) as { raw_version: number; revision: number } | undefined;
    if (!row) throw new Error(`seedView: 快照来源不存在 ${itemId}`);
    return { id: itemId, rawVersion: Number(row.raw_version), revision: Number(row.revision) };
  });

  const id = randomUUID();
  const now = new Date().toISOString();
  const selection = input.selection ?? { mode: 'explicit', itemIds: input.itemIds };
  db.prepare(
    `INSERT INTO views (
       id, name, kind, selection_json, source_snapshot_json, content_json, content_hash,
       renderer_version, prompt_version, run_id, revision, generated_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 1, ?, ?, ?)`,
  ).run(
    id,
    input.name.slice(0, 100),
    input.kind,
    JSON.stringify(selection),
    JSON.stringify({ items, relations: [] }),
    JSON.stringify(input.content),
    input.kind === 'mindmap' ? 'mindmap-markmap-v1' : 'flow-mermaid-v1',
    input.promptVersion ?? (input.kind === 'mindmap' ? 'mindmap-v1' : 'flow-v1'),
    now,
    now,
    now,
  );

  return id;
}
