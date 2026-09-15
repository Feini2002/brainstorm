/**
 * View service (T053).
 *
 * One module owns save, list, read, rename and delete for all three projection
 * kinds, so `graph`, `mindmap` and `flow` cannot grow three different ideas of
 * what a saved view is. Two rules shape it:
 *
 *  1. **The list never carries content (T053-R02).** Switching to the views page
 *     must not download every saved graph. `listViews` returns summaries; only
 *     `getView` assembles the full structure, and it prunes positions whose item
 *     is gone rather than 404-ing.
 *  2. **Writing a view is not writing knowledge (T053-R03).** Delete removes the
 *     row and nothing else — the items and relations a view pointed at are
 *     untouched, and `missingSources` is reported instead of repaired.
 *
 * `contentHash` is computed over `{kind, content, sourceSnapshot, promptVersion}`
 * per docs/03_contracts/03_dto_and_version_rules.md §44. The fixture
 * `reference/fixtures/backup_valid.json` pins that exact input set, so a change
 * here that is not also a contract change fails the contract guard.
 */
import 'server-only';

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { notFound, revisionConflict, validationError } from '@/domain/errors';
import type {
  GraphContent,
  SelectionSpec,
  SourceSnapshot,
  UUID,
  ViewDTO,
  ViewSummaryDTO,
} from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import {
  computeStaleness,
  defaultGraphContent,
  promptVersionFor,
  validateViewName,
  type CurrentSourceState,
} from '@/domain/view';
import { hashCanonical } from '@/server/crypto/hash';
import {
  assembleView,
  assembleViewSummary,
  deleteView,
  findViewRow,
  insertView,
  listViewRows,
  updateViewIfRevision,
} from '@/server/repositories/views';
import { listItems, listItemsByIds, readItemVersionsByIds } from '@/server/repositories/items';
import { listRelations, listRelationsByIds } from '@/server/repositories/relations';

export interface CreateGraphViewServiceInput {
  name: string;
  selection: SelectionSpec;
  positions: Record<string, { x: number; y: number }>;
  direction: 'LR' | 'TB';
}

/** `kind` is part of the hash input, so it is a parameter rather than a literal. */
export function viewContentHash(input: {
  kind: 'graph' | 'mindmap' | 'flow';
  content: unknown;
  sourceSnapshot: SourceSnapshot;
  promptVersion: string | null;
}): string {
  return hashCanonical({
    kind: input.kind,
    content: input.content,
    sourceSnapshot: input.sourceSnapshot,
    promptVersion: input.promptVersion,
  });
}

/**
 * Snapshot the sources a view is about to depend on.
 *
 * For a filter selection this is the set the filter currently matches; for an
 * explicit selection it is exactly the chosen ids. Reading the versions now is
 * what makes `isStale` later meaningful instead of a guess.
 */
export function buildSourceSnapshot(
  db: DatabaseSync,
  selection: SelectionSpec,
): SourceSnapshot {
  if (selection.mode === 'explicit') {
    const ids = [...new Set(selection.itemIds)];
    // Read the chosen ids directly. The schema already bounds the selection, and
    // a page read would silently treat every id beyond the newest N as deleted —
    // which made `isStale` report a saved view as having lost its sources.
    const items = listItemsByIds(db, ids);
    const itemIds = new Set(items.map((item) => item.id));
    const relations = listRelations(db, { includeStale: true, includeRejected: true }).filter(
      (relation) => itemIds.has(relation.sourceId) && itemIds.has(relation.targetId),
    );

    return {
      items: items.map((item) => ({
        id: item.id,
        rawVersion: item.rawVersion,
        revision: item.revision,
      })),
      relations: relations.map((relation) => ({ id: relation.id, revision: relation.revision })),
    };
  }

  // A filter selection snapshots what the filter matches right now: saving the
  // filter alone would let a later re-read silently cover different notes.
  const filter = selection.filter;
  const items = listItems(db, {
    filters: {
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.tagId ? { tagId: filter.tagId } : {}),
    },
    sort: 'newest',
    limit: LIMITS.graphNodes,
    cursor: null,
  }).items;

  const itemIds = new Set(items.map((item) => item.id));
  const relations = listRelations(db, { includeStale: true, includeRejected: true }).filter(
    (relation) => itemIds.has(relation.sourceId) && itemIds.has(relation.targetId),
  );

  return {
    items: items.map((item) => ({
      id: item.id,
      rawVersion: item.rawVersion,
      revision: item.revision,
    })),
    relations: relations.map((relation) => ({ id: relation.id, revision: relation.revision })),
  };
}

/**
 * Both states the repository needs to derive staleness, read once per request.
 *
 * The snapshot is the authority on *which* rows a view depends on, so version
 * lookups are scoped to it. Reading "the newest page of items and every
 * relation" instead was two bugs at once: a view whose sources sat past the page
 * boundary reported them as deleted, and a relation that was compacted away
 * outside the list window did the same.
 */
export function readCurrentSourceState(
  db: DatabaseSync,
  snapshot: SourceSnapshot,
): CurrentSourceState {
  const itemVersions = readItemVersionsByIds(
    db,
    snapshot.items.map((entry) => entry.id),
  );
  const relationRows = listRelationsByIds(
    db,
    snapshot.relations.map((entry) => entry.id),
  );
  return {
    items: itemVersions,
    relations: new Map(relationRows.map((relation) => [relation.id, { revision: relation.revision }])),
  };
}

export function createGraphView(
  db: DatabaseSync,
  input: CreateGraphViewServiceInput,
): ViewDTO {
  const nameError = validateViewName(input.name);
  if (nameError) throw validationError(nameError, { name: [nameError] });

  const invalid = Object.entries(input.positions).filter(
    ([, point]) => !Number.isFinite(point.x) || !Number.isFinite(point.y),
  );
  if (invalid.length > 0) {
    throw validationError('坐标不合法', { positions: ['坐标必须是有限数'] });
  }

  const content: GraphContent =
    Object.keys(input.positions).length > 0
      ? { positions: input.positions, direction: input.direction }
      : { ...defaultGraphContent(), direction: input.direction };

  const snapshot = buildSourceSnapshot(db, input.selection);
  const now = new Date().toISOString();
  const id = randomUUID();

  insertView(db, {
    id,
    name: input.name.trim(),
    kind: 'graph',
    selection: input.selection,
    sourceSnapshot: snapshot,
    content,
    contentHash: viewContentHash({
      kind: 'graph',
      content,
      sourceSnapshot: snapshot,
      promptVersion: promptVersionFor('graph'),
    }),
    // Graph views have no prompt template; only generated kinds carry one.
    promptVersion: promptVersionFor('graph'),
    runId: null,
    generatedAt: now,
    now,
  });

  return getView(db, id);
}

export function listViews(
  db: DatabaseSync,
  input: { kind?: 'graph' | 'mindmap' | 'flow'; limit: number; offset: number },
): { views: ViewSummaryDTO[]; total: number } {
  const { rows, total } = listViewRows(db, input);
  // Staleness is per row: each view depends on its own snapshot, so the version
  // lookup is scoped to that snapshot rather than to a global "newest page".
  return {
    views: rows.map((row) => {
      const snapshot = JSON.parse(String(row.source_snapshot_json)) as SourceSnapshot;
      return assembleViewSummary(row, readCurrentSourceState(db, snapshot));
    }),
    total,
  };
}

/**
 * Assemble one view.
 *
 * Missing sources are reported on the DTO, never turned into a 404: a view whose
 * notes were partly deleted must still open so the user can see which ones are
 * gone (T053-R06).
 */
export function getView(db: DatabaseSync, id: UUID): ViewDTO {
  const row = findViewRow(db, id);
  if (!row) throw notFound('视图不存在');
  // Staleness is computed against this view's own snapshot, not a global window.
  const snapshot = JSON.parse(String(row.source_snapshot_json)) as SourceSnapshot;
  return assembleView(db, row, readCurrentSourceState(db, snapshot));
}

/** Rename and/or replace the graph layout under optimistic concurrency (T053-R04). */
export function editView(
  db: DatabaseSync,
  input: {
    id: UUID;
    expectedRevision: number;
    name?: string;
    graphLayout?: { positions: Record<string, { x: number; y: number }>; direction: 'LR' | 'TB' };
  },
): ViewDTO {
  if (input.name !== undefined) {
    const nameError = validateViewName(input.name);
    if (nameError) throw validationError(nameError, { name: [nameError] });
  }

  const row = findViewRow(db, input.id);
  if (!row) throw notFound('视图不存在');
  if (String(row.kind) === 'graph' && input.graphLayout === undefined && input.name === undefined) {
    throw validationError('没有需要修改的字段');
  }
  if (input.graphLayout !== undefined && String(row.kind) !== 'graph') {
    throw validationError('只有关系图视图可以修改布局', { graphLayout: ['该视图不是关系图'] });
  }

  const now = new Date().toISOString();
  const content =
    input.graphLayout === undefined
      ? undefined
      : ({
          positions: input.graphLayout.positions,
          direction: input.graphLayout.direction,
        } satisfies GraphContent);

  // The hash covers the new content only when the content changed; a rename must
  // not invalidate the projection it describes.
  const contentHash =
    content === undefined
      ? undefined
      : viewContentHash({
          kind: 'graph',
          content,
          sourceSnapshot: JSON.parse(String(row.source_snapshot_json)) as SourceSnapshot,
          promptVersion: (row.prompt_version as string | null) ?? promptVersionFor('graph'),
        });

  const changes = updateViewIfRevision(db, {
    id: input.id,
    expectedRevision: input.expectedRevision,
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(contentHash !== undefined ? { contentHash } : {}),
    now,
  });
  if (changes === 0) throw revisionConflict('视图已被其他窗口修改，请重新载入');

  return getView(db, input.id);
}

/** Delete a view. Knowledge items and relations are never touched (T053-R03). */
export function removeView(
  db: DatabaseSync,
  id: UUID,
  expectedRevision: number,
): { deletedId: UUID } {
  const changes = deleteView(db, id, expectedRevision);
  if (changes === 0) {
    if (!findViewRow(db, id)) throw notFound('视图已被删除');
    throw revisionConflict('视图已被其他窗口修改，请重新载入');
  }
  return { deletedId: id };
}

/** Recompute the displayed staleness of a view; exported for tests and callers. */
export function viewStaleness(db: DatabaseSync, view: ViewDTO) {
  return computeStaleness(view.sourceSnapshot, readCurrentSourceState(db, view.sourceSnapshot));
}
