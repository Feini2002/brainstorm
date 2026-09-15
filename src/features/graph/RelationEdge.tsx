'use client';

/**
 * Custom relation edge (T049-R05, T048-R06).
 *
 * The edge carries a *short* badge, never the reason text: drawing a 300-code-point
 * reason on every edge turns a graph into an unreadable wall of text. The full
 * sentence and reason are shown in the inspector once the user selects the edge.
 *
 * Line style encodes the two states a user must be able to tell apart without
 * colour (T050-R04): a pending suggestion is dashed, a stale edge is dotted.
 */
import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';

import { lineStyleFor } from '@/features/graph/badges';

const STROKE: Record<string, string> = {
  suggested: 'var(--suggested)',
  accepted: 'var(--accepted)',
  rejected: 'var(--danger)',
};

const DASH: Record<string, string | undefined> = {
  solid: undefined,
  dashed: '6 4',
  dotted: '2 3',
};

function RelationEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
  selected,
}: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const status = String(data?.reviewStatus ?? 'accepted');
  const freshness = String(data?.freshness ?? 'fresh');
  const style = lineStyleFor(status as never, freshness as never);
  const badge = typeof data?.badge === 'string' ? data.badge : null;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: STROKE[status] ?? 'var(--line)',
          strokeWidth: selected ? 2.5 : 1.5,
          strokeDasharray: DASH[style],
        }}
      />
      {badge ? (
        <EdgeLabelRenderer>
          <span
            data-testid="graph-edge-badge"
            data-relation-id={data?.relationId as string}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'none',
            }}
            className="rounded-sm border border-[var(--line)] bg-[var(--surface)] px-1 text-[10px] text-[var(--ink-muted)]"
          >
            {badge}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const RelationEdge = memo(RelationEdgeView);
