/**
 * React Flow binding types (T044).
 *
 * These describe the *presentation* objects React Flow needs. They deliberately
 * do not replace the domain DTOs: `GraphNode.data` carries only what the card
 * renders plus the source id needed to fetch the full record, so the library's
 * object shape never becomes the place business fields live (T044-R02).
 */
import type { Edge, Node } from '@xyflow/react';

import type { GraphData } from '@/domain/graph';
import type { RelationFreshness } from '@/domain/staleness';

export type GraphDirection = 'LR' | 'TB';

/**
 * Payload of a custom node.
 *
 * Kept small on purpose: no API key, no whole `ItemDTO`, no `rawText`. A node
 * that needs the full text opens the shared drawer by id (T049-R01).
 */
export interface KnowledgeNodeData extends Record<string, unknown> {
  itemId: string;
  label: string;
  summary: string;
  type: GraphData['nodes'][number]['type'];
  tags: string[];
  status: GraphData['nodes'][number]['status'];
  revision: number;
  isStructured: boolean;
  degree: number;
  /** True when this node's coordinates were computed rather than saved. */
  needsLayout: boolean;
}

export type KnowledgeFlowNode = Node<KnowledgeNodeData, 'knowledge'>;

/**
 * Payload of an edge.
 *
 * `suggested` needs a visible mark as well as a style, so the label and a
 * `data-testid`-able status travel with the edge rather than being re-derived
 * from CSS (T044-R03).
 */
export interface KnowledgeEdgeData extends Record<string, unknown> {
  relationId: string;
  relationType: GraphData['edges'][number]['type'];
  origin: GraphData['edges'][number]['origin'];
  reviewStatus: GraphData['edges'][number]['reviewStatus'];
  score: number | null;
  reason: string;
  isStale: boolean;
  freshness: RelationFreshness;
  revision: number;
  /** Full natural-language sentence, used in the inspector, not on the canvas. */
  sentence: string;
  /** Short on-canvas text mark (e.g. 「待确认」「依据已变化」). */
  badge: string | null;
}

export type KnowledgeFlowEdge = Edge<KnowledgeEdgeData, 'knowledge'>;

export interface GraphAdapterInput {
  graph: GraphData;
  /**
   * Positions from `View.content.positions`, keyed by item id.
   *
   * Absent or partial is normal: nodes without a saved coordinate are marked
   * `needsLayout` so the caller can run Dagre once, instead of the adapter
   * inventing coordinates or calling a layout engine itself (T044-R05).
   */
  positions?: Record<string, { x: number; y: number }>;
  /** Freshness per relation id, derived server-side at read time (T051). */
  freshness?: Record<string, RelationFreshness>;
  selectedItemId?: string | null;
  selectedRelationId?: string | null;
}

export interface GraphAdapterResult {
  nodes: KnowledgeFlowNode[];
  edges: KnowledgeFlowEdge[];
  /** True when at least one node has no saved position. */
  needsLayout: boolean;
}
