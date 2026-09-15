'use client';

/**
 * Graph canvas (T045).
 *
 * Two properties this component protects, both of which are easy to get wrong:
 *
 *  1. **The delete key cannot destroy knowledge (T045-R05).** React Flow deletes
 *     selected nodes and edges on Backspace/Delete by default. Here that would
 *     remove a *relation* or, worse, look like deleting the note it stands for.
 *     `deleteKeyCode={null}` disables it outright; deleting a record stays in the
 *     drawer and deleting a relation stays in the inspector, both of which ask
 *     for confirmation and use `expectedRevision`.
 *  2. **The container always has a size (T045-R03).** A React Flow canvas inside a
 *     zero-height flex child renders nothing and reports "no nodes". The wrapper
 *     has an explicit minimum height and the canvas fills it, so the layout never
 *     depends on content having already rendered.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from '@xyflow/react';

import '@xyflow/react/dist/style.css';

import type { GraphViewEdge } from '@/domain/graph';
import type { KnowledgeFlowEdge, KnowledgeFlowNode } from '@/features/graph/types';
import { KnowledgeNode } from '@/features/graph/KnowledgeNode';
import { RelationEdge } from '@/features/graph/RelationEdge';

/**
 * Stable references (T045-R02): a new object identity per render makes React Flow
 * remount every node, which loses focus and restarts any in-flight measurement.
 */
const NODE_TYPES = { knowledge: KnowledgeNode };
const EDGE_TYPES = { knowledge: RelationEdge };

export interface KnowledgeGraphProps {
  nodes: KnowledgeFlowNode[];
  edges: KnowledgeFlowEdge[];
  /** Called with only the positions that changed, never the whole map. */
  onNodesMoved: (moved: Record<string, { x: number; y: number }>) => void;
  onNodeOpen: (itemId: string) => void;
  onEdgeSelected: (edgeId: string) => void;
  onPaneClick: () => void;
  /** Highlighted from the relation list or the inspector. */
  selectedEdgeId?: string | null;
  fitViewToken?: number;
}

function Canvas({
  nodes,
  edges,
  onNodesMoved,
  onNodeOpen,
  onEdgeSelected,
  onPaneClick,
  fitViewToken,
}: KnowledgeGraphProps) {
  const onNodeClick = useCallback(
    (_: unknown, node: Node) => onNodeOpen(node.id),
    [onNodeOpen],
  );

  const onEdgeClick = useCallback(
    (_: unknown, edge: Edge) => onEdgeSelected(edge.id),
    [onEdgeSelected],
  );

  /**
   * Collect drag results into one commit.
   *
   * React Flow emits a change per frame while dragging. Sending each one would
   * hammer SQLite (T047-R02), so only `dragging === false` — the drop — is
   * reported, and only for nodes whose position actually changed.
   */
  const onNodesChange = useCallback(
    (changes: NodeChange<KnowledgeFlowNode>[]) => {
      const moved: Record<string, { x: number; y: number }> = {};
      for (const change of changes) {
        if (change.type !== 'position') continue;
        if (change.dragging === true) continue;
        if (!change.position) continue;
        moved[change.id] = { x: change.position.x, y: change.position.y };
      }
      if (Object.keys(moved).length > 0) onNodesMoved(moved);
    },
    [onNodesMoved],
  );

  const { fitView } = useReactFlow();

  /**
   * Fit the viewport when the caller asks for it.
   *
   * React Flow reads `fitView` once at mount, so a later change to the node array
   * (a new view, an auto-layout, a direction switch) leaves the canvas showing
   * wherever the old arrangement was — a graph that "disappeared" after layout
   * was actually one laid out off-screen. The page therefore bumps `fitViewToken`
   * at exactly the moments a re-fit is wanted, and this effect performs it.
   *
   * Deliberately keyed on the token and not on `nodes`: re-fitting whenever the
   * node array changed would yank the viewport away from wherever the user was
   * looking on every filter change, which is the behaviour T048-R04 forbids.
   */
  const lastFitToken = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (fitViewToken === undefined) return;
    if (lastFitToken.current === fitViewToken) return;
    lastFitToken.current = fitViewToken;
    // The nodes must have been committed before their bounds can be measured.
    void fitView({ padding: 0.2, maxZoom: 1.4, duration: 200 });
  }, [fitViewToken, fitView]);

  const fitViewOptions = useMemo(() => ({ padding: 0.2, maxZoom: 1.4 }), []);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      onNodeClick={onNodeClick}
      onEdgeClick={onEdgeClick}
      onNodesChange={onNodesChange}
      onPaneClick={onPaneClick}
      // See the class comment: the library's default delete binding is disabled.
      deleteKeyCode={null}
      nodesDraggable
      nodesConnectable={false}
      edgesFocusable
      elementsSelectable
      minZoom={0.05}
      maxZoom={2}
      // `fitView` at mount only places the graph once; later re-fits go through
      // the token effect above, which is keyed on an explicit user action.
      fitView
      fitViewOptions={fitViewOptions}
      proOptions={{ hideAttribution: true }}
      aria-label="关系图画布"
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      <MiniMap pannable zoomable aria-label="关系图缩略图" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

/**
 * Provider scope (T045-R02).
 *
 * `ReactFlowProvider` wraps the canvas here rather than at the page root, so the
 * hooks it enables (`useReactFlow` in children) cannot be called from a component
 * that is outside it.
 */
export function KnowledgeGraph(props: KnowledgeGraphProps) {
  return (
    <div
      className="view-canvas h-[560px] w-full overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--surface)]"
      data-testid="graph-canvas"
    >
      <ReactFlowProvider>
        <Canvas {...props} />
      </ReactFlowProvider>
    </div>
  );
}

/** Convenience export so callers can type their state without importing the lib. */
export type { KnowledgeFlowEdge, KnowledgeFlowNode, GraphViewEdge };
