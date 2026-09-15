'use client';

/**
 * Custom knowledge node (T045-R04).
 *
 * A fixed card layout, not an auto-sized box: Dagre needs an agreed size before
 * the DOM is measured (T046-R03), and a title that wraps to a variable number of
 * lines would make the layout drift from the rendered result.
 *
 * Long Chinese titles are truncated with `line-clamp` and the full text is
 * available in two places — the native `title` tooltip and the node's own
 * accessible name — so truncation never hides a record's identity.
 */
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

import { ITEM_TYPE_LABELS } from '@/domain/knowledge';
import { NODE_HEIGHT, NODE_WIDTH } from '@/features/graph/graphAdapter';
import type { KnowledgeFlowNode } from '@/features/graph/types';

const STATUS_TONE: Record<string, string> = {
  raw: 'text-[var(--ink-muted)]',
  processing: 'text-[var(--warn-ink)]',
  done: 'text-[var(--accepted)]',
  error: 'text-[var(--danger)]',
  stale: 'text-[var(--warn-ink)]',
};

function KnowledgeNodeView({ data, selected }: NodeProps<KnowledgeFlowNode>) {
  const tone = STATUS_TONE[String(data.status)] ?? 'text-[var(--ink-muted)]';
  return (
    <div
      // `role="button"` rather than a real button: React Flow owns the drag and
      // click gestures on the wrapper, and a nested button would swallow them.
      role="button"
      tabIndex={0}
      aria-label={`打开记录：${data.label}`}
      data-testid="graph-node"
      data-item-id={data.itemId}
      title={data.label}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={`flex flex-col gap-1 overflow-hidden rounded-md border bg-[var(--surface)] px-3 py-2 shadow-sm transition-colors ${
        selected ? 'border-[var(--focus)] ring-2 ring-[var(--focus)]' : 'border-[var(--line)]'
      }`}
    >
      <span className="line-clamp-2 text-sm font-medium leading-snug text-[var(--ink)]">
        {data.label}
      </span>
      {/*
        The summary is decoration for the canvas; the drawer shows the real text.
        It is `aria-hidden` so a screen reader reads the label, not a fragment.
      */}
      {data.summary ? (
        <span aria-hidden className="line-clamp-1 text-xs text-[var(--ink-muted)]">
          {data.summary}
        </span>
      ) : null}
      <span className={`mt-auto flex items-center gap-2 text-[10px] ${tone}`}>
        <span>{ITEM_TYPE_LABELS[data.type as keyof typeof ITEM_TYPE_LABELS] ?? data.type}</span>
        {data.degree > 0 ? <span>· {data.degree} 条关系</span> : <span>· 暂无关系</span>}
        {data.isStructured ? <span>· 已整理</span> : null}
      </span>
      {/* Handles are visually hidden but must exist for edges to attach. */}
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

/**
 * Memoised: React Flow re-renders every node when one node's position changes,
 * and a card that re-renders on an unrelated drag makes a large graph stutter.
 */
export const KnowledgeNode = memo(KnowledgeNodeView);
