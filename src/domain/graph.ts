/**
 * Graph domain: bounded subgraph projection of the knowledge base.
 *
 * Graph nodes come from KnowledgeItem, edges come from Relation. A filter
 * genuinely changes which nodes and edges are shown; nothing here invents data.
 */
import { LIMITS } from './limits';
import type { Evidence, GraphFilter, ItemDTO, RelationDTO, RelationType } from './knowledge';
import { describeRelation, RELATION_TYPE_EN } from './relation';
import type { GraphFreshness, RelationFreshness } from './staleness';

export interface GraphNode {
  id: string;
  /** Title when the item has one, otherwise a safe truncation of rawText. */
  label: string;
  summary: string;
  type: ItemDTO['type'];
  tags: string[];
  status: ItemDTO['status'];
  revision: number;
  /**
   * The raw text version this node's content corresponds to.
   *
   * Carried so a client can compare an edge's recorded endpoint version against
   * the live one and show 「依据过期」 without a second request (T051-R01).
   */
  rawVersion: number;
  isStructured: boolean;
  degree: number;
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: RelationType;
  origin: RelationDTO['origin'];
  reviewStatus: RelationDTO['reviewStatus'];
  score: number | null;
  reason: string;
  label: string;
  isStale: boolean;
  revision: number;
  /** Endpoint versions the relation was recorded against (T051-R01). */
  sourceRawVersion: number;
  targetRawVersion: number;
  /**
   * Verified citations, carried so the inspector can show the material a
   * judgement was actually made on (T049-R02/T049-C02).
   *
   * A graph without its evidence is a decorative diagram: the user is asked to
   * accept or reject an edge and has no way to see why the model proposed it.
   * The quotes were already verified verbatim against raw text at write time
   * (`domain/evidence.ts`), so this is a projection of stored proof, not a new
   * claim. Sending them costs nothing extra — the relation row was read anyway.
   */
  evidence: Evidence[];
}

export interface GraphScope {
  matchedNodeCount: number;
  shownNodeCount: number;
  matchedEdgeCount: number;
  shownEdgeCount: number;
  /**
   * How many of the shown edges are still awaiting confirmation.
   *
   * Reported as its own number because "12 条关系" and "12 条关系，其中 9 条待确认"
   * are entirely different situations, and the second is the one a user needs to
   * act on (T050-R01).
   */
  suggestedEdgeCount: number;
  truncated: boolean;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  datasetRevision: number;
  scope: GraphScope;
}

/**
 * A node as returned by the read API.
 *
 * `hasSavedPosition` is derived from the *View* being rendered, not from the
 * item: a graph read never implies a stored coordinate (T043-R06, T044-R05).
 */
export type GraphViewNode = GraphNode & { hasSavedPosition: boolean };

export type GraphViewEdge = GraphEdge & { freshness: RelationFreshness };

/**
 * Full `/api/graph` response.
 *
 * The contract's fields stay at the top level (docs/03_contracts/04_api_contract.md
 * §Graph) rather than being wrapped; `freshness` is an additive summary so a
 * viewer can explain *why* an edge is missing without a second request, and the
 * per-edge `freshness` is the same value the summary counted.
 */
export type GraphReadResponse = Omit<GraphData, 'nodes' | 'edges'> & {
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  freshness: GraphFreshness;
};

export function nodeLabel(item: Pick<ItemDTO, 'title' | 'rawText'>): string {
  const title = item.title.trim();
  if (title.length > 0) return title;
  const points = Array.from(item.rawText.replace(/\s+/gu, ' ').trim());
  if (points.length <= 40) return points.join('');
  return `${points.slice(0, 39).join('')}…`;
}

/** Edge label in natural language so direction is never lost. */
export function edgeLabel(
  relation: Pick<RelationDTO, 'type' | 'origin' | 'reviewStatus'>,
  sourceLabel: string,
  targetLabel: string,
): string {
  const base = describeRelation(relation.type, sourceLabel, targetLabel);
  if (relation.reviewStatus === 'suggested') return `${base}（待确认）`;
  return base;
}

export function edgeLabelEnglish(
  type: RelationType,
  sourceLabel: string,
  targetLabel: string,
): string {
  return `${sourceLabel} ${RELATION_TYPE_EN[type]} ${targetLabel}`;
}

export interface BuildGraphInput {
  items: ItemDTO[];
  relations: RelationDTO[];
  filter: GraphFilter;
  /**
   * Item ids that carry `filter.tagId`, resolved by the caller.
   *
   * Tag membership lives in the `item_tags` table, so this is deliberately *not*
   * derived from `ItemDTO.tags` — that field holds tag **labels**, and comparing a
   * tag UUID against a list of labels is a comparison that can only ever be false.
   * A previous version did exactly that and silently emptied the graph whenever a
   * tag filter was applied.
   *
   * Required whenever `filter.tagId` is set; passing no members for a tag filter
   * fails closed (no node matches) rather than quietly ignoring the filter.
   */
  tagMemberIds?: ReadonlySet<string> | null;
}

export interface BuildGraphResult {
  data: GraphData;
}

/**
 * Build the displayable subgraph.
 *
 * Steps: filter items, then keep only edges whose review status passes, whose
 * score passes the AI threshold (manual edges have no score and are never
 * filtered by it), whose staleness is allowed, and whose endpoints are both in
 * the filtered node set.
 */
export function buildGraph(input: BuildGraphInput, datasetRevision: number): BuildGraphResult {
  const { items, relations, filter } = input;
  const tagMemberIds = input.tagMemberIds ?? null;

  const filteredItems = items.filter((item) => matchesItemFilter(item, filter, tagMemberIds));
  const allowedNodes = new Set(filteredItems.map((item) => item.id));

  const matchedEdges: GraphEdge[] = [];
  for (const relation of relations) {
    if (!allowedNodes.has(relation.sourceId) || !allowedNodes.has(relation.targetId)) continue;
    if (!matchesEdgeFilter(relation, filter)) continue;
    const source = filteredItems.find((item) => item.id === relation.sourceId);
    const target = filteredItems.find((item) => item.id === relation.targetId);
    if (!source || !target) continue;
    matchedEdges.push({
      id: relation.id,
      sourceId: relation.sourceId,
      targetId: relation.targetId,
      type: relation.type,
      origin: relation.origin,
      reviewStatus: relation.reviewStatus,
      score: relation.score,
      reason: relation.reason,
      label: edgeLabel(relation, nodeLabel(source), nodeLabel(target)),
      isStale: relation.isStale,
      revision: relation.revision,
      sourceRawVersion: relation.sourceRawVersion,
      targetRawVersion: relation.targetRawVersion,
      evidence: relation.evidence,
    });
  }

  const matchedNodeCount = filteredItems.length;
  const matchedEdgeCount = matchedEdges.length;

  // Bounds: keep stable node order (newest first as returned by the repository)
  // and only keep edges whose endpoints survive the node cap.
  const shownItems = filteredItems.slice(0, LIMITS.graphNodes);
  const shownNodes = new Set(shownItems.map((item) => item.id));
  const degree = new Map<string, number>();
  for (const edge of matchedEdges) {
    if (!shownNodes.has(edge.sourceId) || !shownNodes.has(edge.targetId)) continue;
    degree.set(edge.sourceId, (degree.get(edge.sourceId) ?? 0) + 1);
    degree.set(edge.targetId, (degree.get(edge.targetId) ?? 0) + 1);
  }

  const shownEdges: GraphEdge[] = [];
  for (const edge of matchedEdges) {
    if (shownEdges.length >= LIMITS.graphEdges) break;
    if (!shownNodes.has(edge.sourceId) || !shownNodes.has(edge.targetId)) continue;
    shownEdges.push(edge);
  }

  const nodes: GraphNode[] = shownItems.map((item) => ({
    id: item.id,
    label: nodeLabel(item),
    summary: item.summary,
    type: item.type,
    tags: item.tags,
    status: item.status,
    revision: item.revision,
    rawVersion: item.rawVersion,
    isStructured: item.structuredBaseRawVersion !== null,
    degree: degree.get(item.id) ?? 0,
  }));

  const truncated =
    matchedNodeCount > nodes.length || matchedEdgeCount > shownEdges.length;

  return {
    data: {
      nodes,
      edges: shownEdges,
      datasetRevision,
      scope: {
        matchedNodeCount,
        shownNodeCount: nodes.length,
        matchedEdgeCount,
        shownEdgeCount: shownEdges.length,
        suggestedEdgeCount: shownEdges.filter((edge) => edge.reviewStatus === 'suggested').length,
        truncated,
      },
    },
  };
}

function matchesItemFilter(
  item: ItemDTO,
  filter: GraphFilter,
  tagMemberIds: ReadonlySet<string> | null,
): boolean {
  if (filter.type && item.type !== filter.type) return false;
  if (filter.tagId) {
    // Membership comes from the `item_tags` join, not from `item.tags` (labels).
    // No member set for a tag filter means no match: fail closed, never ignore.
    if (!tagMemberIds || !tagMemberIds.has(item.id)) return false;
  }
  return true;
}

function matchesEdgeFilter(relation: RelationDTO, filter: GraphFilter): boolean {
  const statuses = filter.reviewStatuses ?? ['accepted', 'suggested'];
  if (!statuses.includes(relation.reviewStatus)) return false;
  if (filter.includeStale !== true && relation.isStale) return false;
  if (
    relation.origin === 'ai' &&
    filter.minimumScore !== undefined &&
    relation.score !== null &&
    relation.score < filter.minimumScore
  ) {
    return false;
  }
  return true;
}

/** Default graph filter used when the caller supplies none. */
export function defaultGraphFilter(): GraphFilter {
  return { reviewStatuses: ['accepted', 'suggested'], includeStale: false };
}
