/**
 * Domain graph → React Flow adapter (T044).
 *
 * This is the replacement boundary T052-R05 asks for: the canvas, the layout
 * engine and the repositories never touch each other, and swapping React Flow
 * out means rewriting this file plus the components, not the relation tables.
 *
 * Three properties are load-bearing:
 *
 *  1. **Identity is preserved, never generated (T044-R01).** `node.id` is the
 *     item id and `edge.id` is the relation id, so a click, a saved position and
 *     a review action all address the same row the server knows about. Array
 *     indices and `crypto.randomUUID()` would make a refresh silently renumber
 *     everything.
 *  2. **Input is read, never mutated (T044-R06).** Every returned node and edge
 *     is a newly built object; nothing writes into the `GraphData` handed in.
 *     Drag state therefore cannot leak back into a domain DTO through a shared
 *     reference.
 *  3. **Direction is honest (T044-R04).** Symmetric types render without
 *     arrowheads and with a sentence that reads the same both ways, so the
 *     picture never implies a direction the data does not have.
 */
import { isSymmetricRelationType, type RelationType } from '@/domain/knowledge';
import { describeRelation } from '@/domain/relation';
import { reviewStatusBadge } from './badges';
import type {
  GraphAdapterInput,
  GraphAdapterResult,
  KnowledgeEdgeData,
  KnowledgeFlowEdge,
  KnowledgeFlowNode,
} from './types';

/**
 * Horizontal bounds are generous enough that labels rarely collide; the vertical
 * step is smaller because Chinese titles wrap onto at most two lines.
 */
export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 84;

/** Marker used by React Flow to pick the built-in arrowhead. */
export const ARROW_MARKER = 'url(#rf-arrow)';

/**
 * Convert a domain graph into React Flow nodes and edges.
 *
 * Pure and synchronous: no fetch, no measurement, no layout, no provider call.
 * The caller decides when to compute coordinates (T044-R05).
 */
export function toFlowGraph(input: GraphAdapterInput): GraphAdapterResult {
  const { graph, positions, freshness, selectedItemId, selectedRelationId } = input;

  let needsLayout = false;

  const nodes: KnowledgeFlowNode[] = graph.nodes.map((node) => {
    const saved = positions?.[node.id];
    const hasSaved =
      saved !== undefined && Number.isFinite(saved.x) && Number.isFinite(saved.y);
    if (!hasSaved) needsLayout = true;
    return {
      id: node.id,
      type: 'knowledge',
      position: hasSaved ? { x: saved.x, y: saved.y } : { x: 0, y: 0 },
      selected: selectedItemId === node.id,
      data: {
        itemId: node.id,
        label: node.label,
        summary: node.summary,
        type: node.type,
        tags: [...node.tags],
        status: node.status,
        revision: node.revision,
        isStructured: node.isStructured,
        degree: node.degree,
        needsLayout: !hasSaved,
      },
      // Fixed card size so Dagre can run before the DOM is measured (T046-R03).
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });

  // A relation is drawn as an edge even when it is hidden by the current filter;
  // `buildGraph` already guarantees both endpoints are present, so this map only
  // needs label text.
  const labelById = new Map(graph.nodes.map((node) => [node.id, node.label]));

  const edges: KnowledgeFlowEdge[] = graph.edges.map((edge) => {
    const relationFreshness = freshness?.[edge.id] ?? (edge.isStale ? 'stale' : 'fresh');
    const sourceLabel = labelById.get(edge.sourceId) ?? edge.sourceId;
    const targetLabel = labelById.get(edge.targetId) ?? edge.targetId;
    const sentence = describeRelation(edge.type, sourceLabel, targetLabel);
    const symmetric = isSymmetricRelationType(edge.type as RelationType);

    const data: KnowledgeEdgeData = {
      relationId: edge.id,
      relationType: edge.type,
      origin: edge.origin,
      reviewStatus: edge.reviewStatus,
      score: edge.score,
      reason: edge.reason,
      isStale: edge.isStale,
      freshness: relationFreshness,
      revision: edge.revision,
      sentence,
      badge: reviewStatusBadge(edge.reviewStatus, relationFreshness),
    };

    return {
      id: edge.id,
      source: edge.sourceId,
      target: edge.targetId,
      type: 'knowledge',
      selected: selectedRelationId === edge.id,
      // Symmetric relations get no arrowhead: drawing one would assert a
      // direction the stored relation does not have (T044-R04).
      markerEnd: symmetric ? undefined : ARROW_MARKER,
      // React Flow's own label is a plain string; the full sentence is rendered
      // by the custom edge so a long reason never lands on the canvas (T049-R05).
      label: data.badge ?? undefined,
      data,
    };
  });

  return { nodes, edges, needsLayout };
}

/**
 * Node ids that still lack a saved position.
 *
 * Exposed separately so a caller can lay out *only* the missing nodes and keep
 * every position the user already arranged (T047-R04).
 */
export function nodesNeedingLayout(
  positions: Record<string, { x: number; y: number }> | undefined,
  nodeIds: readonly string[],
): string[] {
  return nodeIds.filter((id) => {
    const point = positions?.[id];
    return point === undefined || !Number.isFinite(point.x) || !Number.isFinite(point.y);
  });
}
