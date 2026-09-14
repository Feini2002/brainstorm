/**
 * Graph domain: bounded subgraph projection of the knowledge base.
 *
 * Graph nodes come from KnowledgeItem, edges come from Relation. A filter
 * genuinely changes which nodes and edges are shown; nothing here invents data.
 */
import { LIMITS } from './limits';
import type { GraphFilter, ItemDTO, RelationDTO, RelationType } from './knowledge';
import { describeRelation, RELATION_TYPE_EN } from './relation';

export interface GraphNode {
  id: string;
  /** Title when the item has one, otherwise a safe truncation of rawText. */
  label: string;
  summary: string;
  type: ItemDTO['type'];
  tags: string[];
  status: ItemDTO['status'];
  revision: number;
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
}

export interface GraphScope {
  matchedNodeCount: number;
  shownNodeCount: number;
  matchedEdgeCount: number;
  shownEdgeCount: number;
  truncated: boolean;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  datasetRevision: number;
  scope: GraphScope;
}

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

  const filteredItems = items.filter((item) => matchesItemFilter(item, filter));
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
        truncated,
      },
    },
  };
}

function matchesItemFilter(item: ItemDTO, filter: GraphFilter): boolean {
  if (filter.type && item.type !== filter.type) return false;
  if (filter.tagId && !item.tags.includes(filter.tagId)) {
    // tagId filtering by ID is resolved to labels by the caller; a tag id that
    // is not present as a label means the item does not match.
    return false;
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
