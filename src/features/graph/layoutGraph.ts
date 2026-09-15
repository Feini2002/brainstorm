/**
 * Dagre auto-layout (T046).
 *
 * Three rules shape this module, and each one exists because the naive version
 * breaks a real workflow:
 *
 *  1. **It runs on an explicit action, never on every render (T046-R01).**
 *     `layoutGraph` is a plain function; no component calls it from an effect
 *     that depends on the node array. A layout inside the render path would
 *     overwrite hand-arranged positions each time a filter changed.
 *  2. **Cycles and isolated nodes are normal input (T046-R04, T043-R05).**
 *     Knowledge is not a tree: two notes can support each other, and a captured
 *     fragment can have no relations at all. Nothing here deletes a relation to
 *     make the graph acyclic — Dagre's rank assignment already tolerates cycles,
 *     and this function passes the edges through unchanged.
 *  3. **Invalid output is refused, not repaired (T046-R05).** If any coordinate
 *     comes back non-finite the whole result is rejected and the caller keeps the
 *     previous layout. Writing `NaN` into a position would blank the canvas and
 *     then be saved as the user's arrangement.
 */
import dagre from '@dagrejs/dagre';

import type { UUID } from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import { isValidCoordinate } from '@/domain/view';
import type { GraphDirection } from './types';

export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 84;

/** Gap between ranks (flow direction) and between siblings. */
const RANK_SEP = 90;
const NODE_SEP = 40;

export interface LayoutNode {
  id: UUID;
  width?: number;
  height?: number;
}

export interface LayoutEdge {
  sourceId: UUID;
  targetId: UUID;
}

export interface LayoutInput {
  nodes: readonly LayoutNode[];
  edges: readonly LayoutEdge[];
  direction: GraphDirection;
}

export type LayoutPositions = Record<UUID, { x: number; y: number }>;

export type LayoutResult =
  | { ok: true; positions: LayoutPositions }
  | { ok: false; reason: string };

/**
 * Compute top-left coordinates for every node.
 *
 * Dagre reports *centre* coordinates; React Flow positions a node by its
 * top-left corner, so half the node's size is subtracted on both axes
 * (T046-R02). Mixing the two conventions puts every node half a card off, which
 * reads as "the layout is slightly wrong" rather than as a coordinate bug.
 */
export function layoutGraph(input: LayoutInput): LayoutResult {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: input.direction,
    ranksep: RANK_SEP,
    nodesep: NODE_SEP,
    marginx: 0,
    marginy: 0,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  const sizes = new Map<UUID, { width: number; height: number }>();
  for (const node of input.nodes) {
    const width = node.width && node.width > 0 ? node.width : NODE_WIDTH;
    const height = node.height && node.height > 0 ? node.height : NODE_HEIGHT;
    // A measured size can be `NaN` when a browser reports a collapsed box; fall
    // back to the agreed card size rather than feeding Dagre a broken number.
    const safeWidth = Number.isFinite(width) ? width : NODE_WIDTH;
    const safeHeight = Number.isFinite(height) ? height : NODE_HEIGHT;
    sizes.set(node.id, { width: safeWidth, height: safeHeight });
    graph.setNode(node.id, { width: safeWidth, height: safeHeight });
  }

  const known = new Set(input.nodes.map((node) => node.id));
  for (const edge of input.edges) {
    // Dangling edges are dropped before layout (T046-R03): Dagre would happily
    // create an implicit node for the missing endpoint and place a phantom card.
    if (!known.has(edge.sourceId) || !known.has(edge.targetId)) continue;
    if (edge.sourceId === edge.targetId) continue;
    // A multigraph key keeps two relation types between the same pair from
    // collapsing into one edge.
    graph.setEdge(
      edge.sourceId,
      edge.targetId,
      {},
      `${edge.sourceId}->${edge.targetId}`,
    );
  }

  try {
    dagre.layout(graph);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : '布局计算失败' };
  }

  const positions: LayoutPositions = {};
  for (const node of input.nodes) {
    const laid = graph.node(node.id) as { x?: number; y?: number } | undefined;
    const size = sizes.get(node.id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
    const x = laid?.x;
    const y = laid?.y;
    if (x === undefined || y === undefined) continue;
    const topLeft = { x: x - size.width / 2, y: y - size.height / 2 };
    if (!isValidCoordinate(topLeft.x) || !isValidCoordinate(topLeft.y)) {
      // Contract bound (|coordinate| <= viewCoordinateAbsMax) is also checked:
      // an in-range layout is the only one a View may store.
      return { ok: false, reason: '布局产生了超出允许范围的坐标，已保留原布局' };
    }
    positions[node.id] = topLeft;
  }

  if (Object.keys(positions).length !== input.nodes.length) {
    return { ok: false, reason: '布局未覆盖全部节点，已保留原布局' };
  }

  return { ok: true, positions };
}

/** Bound enforced by the contract for a stored coordinate. */
export const COORDINATE_LIMIT = LIMITS.viewCoordinateAbsMax;
