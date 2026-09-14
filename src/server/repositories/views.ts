/**
 * View repository.
 *
 * One repository for all three kinds — there is no graph_views/mindmap_views
 * split. `content` is canonical validated JSON; positions are presentation data
 * that can never write back into an item. `missingSources` is computed at read
 * time and never turns a View into a 404.
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import { AppError, notFound } from '@/domain/errors';
import type {
  FlowContent,
  GraphContent,
  MindmapContent,
  SelectionSpec,
  SourceSnapshot,
  UUID,
  ViewDTO,
  ViewKind,
  ViewSummaryDTO,
} from '@/domain/knowledge';
import {
  computeStaleness,
  prunePositions,
  rendererVersionFor,
  sourceCount,
  type CurrentSourceState,
} from '@/domain/view';
import { VIEW_COLUMNS, decodeViewRow } from './mappers';

export interface InsertViewInput {
  id: UUID;
  name: string;
  kind: ViewKind;
  selection: SelectionSpec;
  sourceSnapshot: SourceSnapshot;
  content: GraphContent | MindmapContent | FlowContent;
  contentHash: string | null;
  promptVersion: string | null;
  runId: UUID | null;
  generatedAt: string | null;
  now: string;
}

export function insertView(db: DatabaseSync, input: InsertViewInput): void {
  db.prepare(
    `INSERT INTO views (
       id, name, kind, selection_json, source_snapshot_json, content_json,
       content_hash, renderer_version, prompt_version, run_id, revision,
       generated_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    input.id,
    input.name,
    input.kind,
    JSON.stringify(input.selection),
    JSON.stringify(input.sourceSnapshot),
    JSON.stringify(input.content),
    input.contentHash,
    rendererVersionFor(input.kind),
    input.promptVersion,
    input.runId,
    input.generatedAt,
    input.now,
    input.now,
  );
}

export function findViewRow(db: DatabaseSync, id: UUID): Record<string, unknown> | null {
  const row = db.prepare(`SELECT ${VIEW_COLUMNS} FROM views WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ?? null;
}

export function listViewRows(
  db: DatabaseSync,
  input: { kind?: ViewKind; limit: number; offset: number },
): { rows: Record<string, unknown>[]; total: number } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (input.kind) {
    where.push('kind = ?');
    params.push(input.kind);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const countRow = db
    .prepare(`SELECT COUNT(*) AS total FROM views ${clause}`)
    .get(...params) as { total: number } | undefined;
  const rows = db
    .prepare(
      `SELECT ${VIEW_COLUMNS} FROM views ${clause}
        ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, input.limit, input.offset) as Record<string, unknown>[];
  return { rows, total: Number(countRow?.total ?? 0) };
}

export interface UpdateViewInput {
  id: UUID;
  expectedRevision: number;
  name?: string;
  selection?: SelectionSpec;
  snapshot?: SourceSnapshot;
  content?: GraphContent | MindmapContent | FlowContent;
  contentHash?: string | null;
  promptVersion?: string | null;
  runId?: UUID | null;
  generatedAt?: string | null;
  now: string;
}

/**
 * Compare-and-swap view update. Only the columns present in the input are
 * written, so renaming a view cannot accidentally clear its content.
 */
export function updateViewIfRevision(db: DatabaseSync, input: UpdateViewInput): number {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (input.name !== undefined) {
    sets.push('name = ?');
    params.push(input.name);
  }
  if (input.selection !== undefined) {
    sets.push('selection_json = ?');
    params.push(JSON.stringify(input.selection));
  }
  if (input.snapshot !== undefined) {
    sets.push('source_snapshot_json = ?');
    params.push(JSON.stringify(input.snapshot));
  }
  if (input.content !== undefined) {
    sets.push('content_json = ?');
    params.push(JSON.stringify(input.content));
  }
  if (input.contentHash !== undefined) {
    sets.push('content_hash = ?');
    params.push(input.contentHash);
  }
  if (input.promptVersion !== undefined) {
    sets.push('prompt_version = ?');
    params.push(input.promptVersion);
  }
  if (input.runId !== undefined) {
    sets.push('run_id = ?');
    params.push(input.runId);
  }
  if (input.generatedAt !== undefined) {
    sets.push('generated_at = ?');
    params.push(input.generatedAt);
  }

  if (sets.length === 0) return 0;

  sets.push('revision = revision + 1', 'updated_at = ?');
  params.push(input.now, input.id, input.expectedRevision);

  const result = db
    .prepare(`UPDATE views SET ${sets.join(', ')} WHERE id = ? AND revision = ?`)
    .run(...params);
  return Number(result.changes);
}

export function deleteView(db: DatabaseSync, id: UUID, expectedRevision: number): number {
  const result = db
    .prepare('DELETE FROM views WHERE id = ? AND revision = ?')
    .run(id, expectedRevision);
  return Number(result.changes);
}

export function countViews(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS total FROM views').get() as
    | { total: number }
    | undefined;
  return Number(row?.total ?? 0);
}

/** Only the graph kind can create a view through the plain browser-facing API. */
export interface CreateGraphViewInput extends InsertViewInput {
  kind: 'graph';
}

export function getViewRaw(db: DatabaseSync, id: UUID): ReturnType<typeof decodeViewRow> {
  const row = findViewRow(db, id);
  if (!row) throw notFound('视图不存在');
  return decodeViewRow(row);
}

/**
 * Assemble a ViewDTO: parse canonical JSON, recompute staleness against the
 * current database and prune graph positions that point at deleted items.
 */
export function assembleView(
  db: DatabaseSync,
  row: Record<string, unknown>,
  current: CurrentSourceState,
): ViewDTO {
  const decoded = decodeViewRow(row);
  const selection = JSON.parse(decoded.selection_json) as SelectionSpec;
  const snapshot = JSON.parse(decoded.source_snapshot_json) as SourceSnapshot;
  const rawContent = JSON.parse(decoded.content_json) as Record<string, unknown>;

  const staleness = computeStaleness(snapshot, current);

  const base = {
    id: decoded.id,
    name: decoded.name,
    selection,
    sourceSnapshot: snapshot,
    contentHash: decoded.content_hash,
    rendererVersion: decoded.renderer_version,
    promptVersion: decoded.prompt_version,
    runId: decoded.run_id,
    revision: decoded.revision,
    generatedAt: decoded.generated_at,
    createdAt: decoded.created_at,
    updatedAt: decoded.updated_at,
    isStale: staleness.isStale,
    missingSources: staleness.missingSources,
  };

  switch (decoded.kind) {
    case 'graph': {
      const content = rawContent as unknown as GraphContent;
      const positions = prunePositions(
        content.positions ?? {},
        new Set(current.items.keys()),
      );
      return {
        ...base,
        kind: 'graph',
        content: {
          positions,
          direction: content.direction ?? 'TB',
          ...(content.viewport ? { viewport: content.viewport } : {}),
        },
      };
    }
    case 'mindmap':
      return { ...base, kind: 'mindmap', content: rawContent as unknown as MindmapContent };
    case 'flow':
      return { ...base, kind: 'flow', content: rawContent as unknown as FlowContent };
    default:
      throw new AppError('INTERNAL', '视图类型不合法');
  }
}

export function assembleViewSummary(
  row: Record<string, unknown>,
  current: CurrentSourceState,
): ViewSummaryDTO {
  const decoded = decodeViewRow(row);
  const snapshot = JSON.parse(decoded.source_snapshot_json) as SourceSnapshot;
  const staleness = computeStaleness(snapshot, current);
  return {
    id: decoded.id,
    name: decoded.name,
    kind: decoded.kind,
    revision: decoded.revision,
    generatedAt: decoded.generated_at,
    createdAt: decoded.created_at,
    updatedAt: decoded.updated_at,
    sourceCount: sourceCount(snapshot),
    isStale: staleness.isStale,
    missingSourceCount: staleness.missingSources.length,
  };
}
