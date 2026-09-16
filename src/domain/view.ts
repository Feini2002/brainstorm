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

/**
 * One recorded source whose version no longer matches, or which is gone.
 *
 * The counts on `StalenessResult` answer "is this view out of date?"; this
 * answers "out of date *how*", which is what the user acts on. The contract asks
 * for exactly that: 展示「基于旧版本」的理由，如哪条笔记 revision 从 3 变 4，不把所有
 * 变化都写成笼统的加载失败 (docs/03_contracts/09 §5).
 *
 * `current` is null when the record no longer exists. Which *fields* moved is
 * recorded rather than a single boolean, because the two read differently to a
 * user: a changed `rawVersion` means the text a node was generated from is not
 * the text on screen any more, while a changed `revision` alone means the
 * metadata (or a manual lock) moved.
 */
export interface SourceDrift {
  id: string;
  kind: 'item' | 'relation';
  /** Recorded values, as stored in the view's own snapshot. */
  recorded: { rawVersion: number; revision: number };
  /** Live values; null when the record was deleted. */
  current: { rawVersion: number; revision: number } | null;
  /** Fields that no longer match. Empty when `current` is null. */
  changedFields: ('rawVersion' | 'revision')[];
}

export interface StalenessResult {
  isStale: boolean;
  /**
   * Source *item* ids that no longer exist.
   *
   * Items only, because that is what the field means on the contract
   * (`docs/03_contracts/03_dto_and_version_rules.md` §12: 「missingSources 是已不存在的
   * 条目 ID 数组」) and callers use it to look up notes by id. A missing relation
   * is still reported — on `drift`, where its kind is stated — rather than
   * smuggled into a list of item ids, which is what this used to do.
   */
  missingSources: string[];
  changedItemIds: string[];
  changedRelationIds: string[];
  /** Every drifted or missing source, with the versions on both sides. */
  drift: SourceDrift[];
}

export function computeStaleness(
  snapshot: SourceSnapshot,
  current: CurrentSourceState,
): StalenessResult {
  const missingSources: string[] = [];
  const changedItemIds: string[] = [];
  const changedRelationIds: string[] = [];
  const drift: SourceDrift[] = [];

  for (const entry of snapshot.items) {
    const live = current.items.get(entry.id);
    if (!live) {
      missingSources.push(entry.id);
      drift.push({
        id: entry.id,
        kind: 'item',
        recorded: { rawVersion: entry.rawVersion, revision: entry.revision },
        current: null,
        changedFields: [],
      });
      continue;
    }
    const changedFields: SourceDrift['changedFields'] = [];
    if (live.rawVersion !== entry.rawVersion) changedFields.push('rawVersion');
    if (live.revision !== entry.revision) changedFields.push('revision');
    if (changedFields.length === 0) continue;
    changedItemIds.push(entry.id);
    drift.push({
      id: entry.id,
      kind: 'item',
      recorded: { rawVersion: entry.rawVersion, revision: entry.revision },
      current: { rawVersion: live.rawVersion, revision: live.revision },
      changedFields,
    });
  }

  for (const entry of snapshot.relations) {
    const live = current.relations.get(entry.id);
    if (!live) {
      // Deliberately *not* added to `missingSources`: that list is item ids. The
      // drift entry carries the kind, so nothing is lost by keeping the two
      // apart, and a caller that resolves `missingSources` against the item
      // table no longer gets a relation id back.
      changedRelationIds.push(entry.id);
      drift.push({
        id: entry.id,
        kind: 'relation',
        recorded: { rawVersion: 0, revision: entry.revision },
        current: null,
        changedFields: [],
      });
      continue;
    }
    if (live.revision !== entry.revision) {
      changedRelationIds.push(entry.id);
      drift.push({
        id: entry.id,
        kind: 'relation',
        recorded: { rawVersion: 0, revision: entry.revision },
        current: { rawVersion: 0, revision: live.revision },
        changedFields: ['revision'],
      });
    }
  }

  return {
    isStale: changedItemIds.length > 0 || changedRelationIds.length > 0,
    missingSources,
    changedItemIds,
    changedRelationIds,
    drift,
  };
}

export function sourceCount(snapshot: SourceSnapshot): number {
  const ids = new Set<string>();
  for (const item of snapshot.items) ids.add(item.id);
  for (const relation of snapshot.relations) ids.add(relation.id);
  return ids.size;
}

/**
 * Freshness report for one saved view (T059).
 *
 * This is the *wire* shape of `GET /api/views/{id}/freshness`, and it lives in
 * the domain layer for the same reason `RunDiagnostics` does: the browser needs
 * the type to render the banner, and `src/features` may not import from
 * `src/server` — a client bundle must not be able to reach server modules at all
 * (T003-R02). The server service constructs it; both sides name it from here.
 *
 * It is a read model, not a stored entity: nothing here is a column, and it is
 * recomputed on every request from the snapshot plus live versions.
 */
export interface SourceDriftView {
  id: string;
  kind: 'item' | 'relation';
  /** Set for items only: the note's title, so the notice is actionable. */
  title: string | null;
  /** One line naming what moved, e.g. `原文 v1 → v2`. */
  message: string;
  missing: boolean;
}

export interface ViewFreshness {
  viewId: string;
  kind: ViewKind;
  revision: number;
  generatedAt: string | null;
  isStale: boolean;
  /** Item ids that no longer exist. Items only, per the DTO contract. */
  missingSources: string[];
  changedItemCount: number;
  changedRelationCount: number;
  missingSourceCount: number;
  /** Human-readable reason, or null when there is nothing to report. */
  reason: string | null;
  drift: SourceDriftView[];
  /**
   * How the stored selection resolves *now*, for the regeneration confirmation
   * (T059-R03, T059-C04).
   */
  currentSelection: {
    mode: SelectionSpec['mode'];
    resolvedIds: string[];
    count: number;
    snapshotCount: number;
    addedIds: string[];
    removedIds: string[];
    /** False when regenerating now would be refused before any call is made. */
    withinBudget: boolean;
    budgetMessage: string | null;
    /**
     * True when there is nothing to send. Regeneration is refused rather than
     * offered with an empty prompt that would let the model invent material
     * (T059-R06).
     */
    isEmpty: boolean;
  };
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
  // A missing *relation* is counted in `changedRelationIds`, not in
  // `missingSources`, so say so separately — otherwise deleting a relation the
  // view was built from would read as "1 条关系已变化", which understates it.
  const missingRelations = result.drift.filter(
    (entry) => entry.kind === 'relation' && entry.current === null,
  ).length;
  if (missingRelations > 0) {
    parts.push(`${missingRelations} 条关系已删除`);
  }
  return parts.length > 0 ? parts.join('，') : null;
}

/**
 * One line about a single drifted source, naming both versions.
 *
 * The contract asks for the specific reason rather than a blanket statement
 * (docs/03_contracts/09 §5), and the version numbers are the part a user can
 * verify: 「revision 从 3 变 4」 can be checked by opening the note, whereas
 * 「依据已变化」 cannot.
 */
export function describeSourceDrift(entry: SourceDrift): string {
  const noun = entry.kind === 'item' ? '笔记' : '关系';
  if (entry.current === null) return `${noun}已删除`;
  const parts: string[] = [];
  if (entry.changedFields.includes('rawVersion')) {
    parts.push(`原文 v${entry.recorded.rawVersion} → v${entry.current.rawVersion}`);
  }
  if (entry.changedFields.includes('revision')) {
    parts.push(`revision ${entry.recorded.revision} → ${entry.current.revision}`);
  }
  return parts.length > 0 ? parts.join('，') : '版本已变化';
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
