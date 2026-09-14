/**
 * View domain rules shared by all three projections.
 *
 * A View is a projection over the knowledge base, never another copy of it:
 * graph positions, mindmap AST and flow AST are all presentation data that must
 * not be able to rewrite capturedText or rawText (docs/00_product/01_product_contract.md §4).
 */
import { LIMITS } from './limits';
import { codePointLength } from './text';
import type {
  GraphContent,
  SelectionSpec,
  SourceSnapshot,
  ViewDTO,
  ViewKind,
  ViewSummaryDTO,
} from './knowledge';

/** Graph views carry no prompt; generated views carry the template version. */
export const GRAPH_RENDERER_VERSION = 'graph-reactflow-dagre-v1';
export const MINDMAP_RENDERER_VERSION = 'mindmap-markmap-v1';
export const FLOW_RENDERER_VERSION = 'flow-mermaid-v1';

export const MINDMAP_PROMPT_VERSION = 'mindmap-v1';
export const FLOW_PROMPT_VERSION = 'flow-v1';
export const ORGANIZE_PROMPT_VERSION = 'organize-v1';
export const REPAIR_PROMPT_VERSION = 'repair-v1';

export function rendererVersionFor(kind: ViewKind): string {
  switch (kind) {
    case 'graph':
      return GRAPH_RENDERER_VERSION;
    case 'mindmap':
      return MINDMAP_RENDERER_VERSION;
    case 'flow':
      return FLOW_RENDERER_VERSION;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function promptVersionFor(kind: ViewKind): string | null {
  switch (kind) {
    case 'graph':
      return null;
    case 'mindmap':
      return MINDMAP_PROMPT_VERSION;
    case 'flow':
      return FLOW_PROMPT_VERSION;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** True when absolute coordinates are finite and inside the contract bound. */
export function isValidCoordinate(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= LIMITS.viewCoordinateAbsMax;
}

export function isValidZoom(value: number): boolean {
  return Number.isFinite(value) && value >= LIMITS.viewZoomMin && value <= LIMITS.viewZoomMax;
}

/**
 * Drop positions that no longer reference an existing item. Positions are
 * presentation data; a stale key must never invent a knowledge node.
 */
export function prunePositions(
  positions: Record<string, { x: number; y: number }>,
  existingIds: ReadonlySet<string>,
): Record<string, { x: number; y: number }> {
  const result: Record<string, { x: number; y: number }> = {};
  for (const [id, point] of Object.entries(positions)) {
    if (!existingIds.has(id)) continue;
    if (!isValidCoordinate(point.x) || !isValidCoordinate(point.y)) continue;
    result[id] = { x: point.x, y: point.y };
  }
  return result;
}

export function defaultGraphContent(): GraphContent {
  return { positions: {}, direction: 'TB' };
}

/**
 * Staleness of a saved projection.
 *
 * A view is stale when any referenced item revision/rawVersion moved, any
 * referenced relation revision moved, or a referenced item was deleted.
 * Missing sources are reported separately so the user keeps context.
 */
export interface CurrentSourceState {
  items: Map<string, { rawVersion: number; revision: number }>;
  relations: Map<string, { revision: number }>;
}

export interface StalenessResult {
  isStale: boolean;
  missingSources: string[];
  changedItemIds: string[];
  changedRelationIds: string[];
}

export function computeStaleness(
  snapshot: SourceSnapshot,
  current: CurrentSourceState,
): StalenessResult {
  const missingSources: string[] = [];
  const changedItemIds: string[] = [];
  const changedRelationIds: string[] = [];

  for (const entry of snapshot.items) {
    const live = current.items.get(entry.id);
    if (!live) {
      missingSources.push(entry.id);
      continue;
    }
    if (live.rawVersion !== entry.rawVersion || live.revision !== entry.revision) {
      changedItemIds.push(entry.id);
    }
  }

  for (const entry of snapshot.relations) {
    const live = current.relations.get(entry.id);
    if (!live) {
      missingSources.push(entry.id);
      continue;
    }
    if (live.revision !== entry.revision) changedRelationIds.push(entry.id);
  }

  return {
    isStale: changedItemIds.length > 0 || changedRelationIds.length > 0,
    missingSources,
    changedItemIds,
    changedRelationIds,
  };
}

export function sourceCount(snapshot: SourceSnapshot): number {
  const ids = new Set<string>();
  for (const item of snapshot.items) ids.add(item.id);
  for (const relation of snapshot.relations) ids.add(relation.id);
  return ids.size;
}

export function toViewSummary(view: ViewDTO): ViewSummaryDTO {
  return {
    id: view.id,
    name: view.name,
    kind: view.kind,
    revision: view.revision,
    generatedAt: view.generatedAt,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    sourceCount: sourceCount(view.sourceSnapshot),
    isStale: view.isStale,
    missingSourceCount: view.missingSources.length,
  };
}

/** Selection identity: sorted, deduplicated item IDs (checked order is not identity). */
export function selectionIdentity(selection: SelectionSpec): string[] {
  if (selection.mode === 'filter') return [];
  return [...new Set(selection.itemIds)].sort();
}

export function selectionItemIds(selection: SelectionSpec): string[] {
  if (selection.mode === 'explicit') return [...selection.itemIds];
  return [];
}

/** Human-readable stale reason for the UI; never a generic "load failed". */
export function describeStaleness(result: StalenessResult): string | null {
  if (!result.isStale && result.missingSources.length === 0) return null;
  const parts: string[] = [];
  if (result.changedItemIds.length > 0) {
    parts.push(`${result.changedItemIds.length} 条笔记已修改`);
  }
  if (result.changedRelationIds.length > 0) {
    parts.push(`${result.changedRelationIds.length} 条关系已变化`);
  }
  if (result.missingSources.length > 0) {
    parts.push(`${result.missingSources.length} 条来源已删除`);
  }
  return parts.join('，');
}

/** Validate a view name coming from user input. */
export function validateViewName(name: string): string | null {
  const length = codePointLength(name);
  if (length < 1) return '视图名称不能为空';
  if (length > LIMITS.viewNameCodePoints) {
    return `视图名称不能超过 ${LIMITS.viewNameCodePoints} 个字符`;
  }
  return null;
}
