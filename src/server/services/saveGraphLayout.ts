/**
 * Graph layout persistence (T047).
 *
 * A saved layout is presentation data, so it lives in `views.content_json` and
 * never in `knowledge_items` (T047-R01). Three decisions carry the rules:
 *
 *  1. **The layout is merged, not replaced.** The request carries only the
 *     coordinates the user actually moved; positions for nodes the client did
 *     not mention are kept from the stored content. A whole-map write would let a
 *     stale tab erase every node it did not know about.
 *  2. **Deleted items drop their positions here, on write and on read.**
 *     `prunePositions` runs both ways: a coordinate whose item is gone is
 *     discarded so a View's JSON cannot accumulate keys that no longer mean
 *     anything (T047-R04). This is not a knowledge delete — only a stale key.
 *  3. **The stored shape is a whitelist.** Only `positions`, `direction` and
 *     `viewport` are serialized. Nothing from the browser's node objects, and no
 *     item field, can reach the JSON (T047-R05).
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import { notFound, revisionConflict, validationError } from '@/domain/errors';
import type { GraphContent, UUID } from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import { isValidCoordinate, isValidZoom } from '@/domain/view';
import { findViewRow, updateViewIfRevision } from '@/server/repositories/views';
import type { GraphDirection } from '@/features/graph/types';

export interface SaveGraphLayoutInput {
  viewId: UUID;
  expectedRevision: number;
  /** Only the positions to write; omitted ids keep their stored coordinate. */
  positions: Record<string, { x: number; y: number }>;
  direction?: GraphDirection;
  viewport?: { x: number; y: number; zoom: number } | undefined;
}

export interface SaveGraphLayoutResult {
  viewId: UUID;
  revision: number;
  positions: Record<string, { x: number; y: number }>;
  direction: GraphDirection;
  discardedIds: string[];
}

/** Parse and validate the stored graph content of one view. */
export function readStoredGraphContent(
  db: DatabaseSync,
  viewId: UUID,
): { revision: number; content: GraphContent } {
  const row = findViewRow(db, viewId);
  if (!row) throw notFound('视图不存在');
  const kind = String(row.kind);
  if (kind !== 'graph') throw validationError('只有关系图视图可以保存布局');

  const raw = JSON.parse(String(row.content_json)) as Record<string, unknown>;
  const positions: Record<string, { x: number; y: number }> = {};
  const source = (raw.positions ?? {}) as Record<string, { x?: unknown; y?: unknown }>;
  for (const [id, point] of Object.entries(source)) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!isValidCoordinate(x) || !isValidCoordinate(y)) continue;
    positions[id] = { x, y };
  }

  const direction: GraphDirection = raw.direction === 'LR' ? 'LR' : 'TB';
  const rawViewport = raw.viewport as { x?: unknown; y?: unknown; zoom?: unknown } | undefined;
  const viewport =
    rawViewport &&
    isValidCoordinate(Number(rawViewport.x)) &&
    isValidCoordinate(Number(rawViewport.y)) &&
    isValidZoom(Number(rawViewport.zoom))
      ? { x: Number(rawViewport.x), y: Number(rawViewport.y), zoom: Number(rawViewport.zoom) }
      : undefined;

  return {
    revision: Number(row.revision),
    content: { positions, direction, ...(viewport ? { viewport } : {}) },
  };
}

/**
 * Persist a layout change with optimistic concurrency.
 *
 * `resolveLiveIds` bounds the stored keys: a position whose item no longer exists
 * is dropped rather than written (T047-R04). It is a *lookup function* rather than
 * a precomputed set because the ids that need checking are only known after the
 * stored content is read — the union of what is already stored and what is being
 * written. Passing only the request's ids made every un-dragged node look deleted
 * on a partial update, which silently dropped the coordinates the user had already
 * arranged. The lookup still runs server-side inside this request, so the check is
 * never based on a list the browser supplied.
 */
export function saveGraphLayout(
  db: DatabaseSync,
  input: SaveGraphLayoutInput,
  resolveLiveIds: (ids: readonly string[]) => ReadonlySet<string>,
): SaveGraphLayoutResult {
  const invalid: string[] = [];
  const incoming: Record<string, { x: number; y: number }> = {};
  for (const [id, point] of Object.entries(input.positions)) {
    if (!isValidCoordinate(point.x) || !isValidCoordinate(point.y)) {
      invalid.push(id);
      continue;
    }
    incoming[id] = { x: point.x, y: point.y };
  }
  if (invalid.length > 0) {
    throw validationError('坐标不合法', {
      positions: [`${invalid.length} 个坐标不是有限数或超出允许范围`],
    });
  }

  if (
    input.viewport &&
    (!isValidCoordinate(input.viewport.x) ||
      !isValidCoordinate(input.viewport.y) ||
      !isValidZoom(input.viewport.zoom))
  ) {
    throw validationError('视口不合法', {
      viewport: ['视口坐标或缩放比例超出允许范围'],
    });
  }

  const stored = readStoredGraphContent(db, input.viewId);

  // Merge first, then ask about liveness for every key that would be stored — not
  // only the ones in this request.
  const candidate: Record<string, { x: number; y: number }> = {
    ...stored.content.positions,
    ...incoming,
  };
  const liveItemIds = resolveLiveIds(Object.keys(candidate));

  // A position for a vanished item is discarded; every other stored coordinate
  // survives a partial update (T047-R04).
  const merged: Record<string, { x: number; y: number }> = {};
  const discardedIds: string[] = [];
  for (const [id, point] of Object.entries(candidate)) {
    if (!liveItemIds.has(id)) {
      discardedIds.push(id);
      continue;
    }
    merged[id] = point;
  }

  if (Object.keys(merged).length > LIMITS.graphNodes) {
    throw validationError('布局节点过多', {
      positions: [`最多保存 ${LIMITS.graphNodes} 个节点位置`],
    });
  }

  const direction = input.direction ?? stored.content.direction;
  const content: GraphContent = {
    positions: merged,
    direction,
    ...(input.viewport ? { viewport: input.viewport } : stored.content.viewport ? { viewport: stored.content.viewport } : {}),
  };

  const now = new Date().toISOString();
  const changes = updateViewIfRevision(db, {
    id: input.viewId,
    expectedRevision: input.expectedRevision,
    content,
    now,
  });

  if (changes === 0) {
    // The revision moved under us. The caller keeps its local draft and offers a
    // reload or an explicit overwrite with the new baseline (T047-R03).
    throw revisionConflict('布局已被其他窗口修改，请重新载入或明确覆盖');
  }

  return {
    viewId: input.viewId,
    revision: input.expectedRevision + 1,
    positions: merged,
    direction,
    discardedIds,
  };
}
