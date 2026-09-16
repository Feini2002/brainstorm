'use client';

/**
 * Graph summary and text alternative (T050).
 *
 * Three requirements meet here:
 *
 *  - **The counts must not lie (T050-R01).** "当前图" and "知识库合计" are shown
 *    as separate numbers. Reporting the library total next to a filtered subgraph
 *    would let a user believe they are looking at everything.
 *  - **The relation list is the accessible equivalent (T050-R03).** A canvas is
 *    not readable by a screen reader, and the keyboard cannot reliably reach every
 *    edge. This list is a real, focusable entry point to the same relations, so
 *    the graph never becomes the *only* way to reach a relation.
 *  - **Truncation is stated, not implied (T050-R02).** When the scope was
 *    truncated the notice says so and points at filtering, and the Library link
 *    remains the way to reach every record.
 */
import type { GraphReadResponse } from '@/domain/graph';
import { REVIEW_STATUS_LABELS } from '@/domain/relation';
import { Button } from '@/components/ui/primitives';
import { STALE_LABEL } from '@/features/shared/StatusLabel';

export interface GraphSummaryProps {
  graph: GraphReadResponse;
  /** Total records in the library, shown next to the current subgraph. */
  libraryTotal: number | null;
  onSelectRelation: (relationId: string) => void;
  onOpenLibrary: () => void;
}

export function GraphSummary({
  graph,
  libraryTotal,
  onSelectRelation,
  onOpenLibrary,
}: GraphSummaryProps) {
  const { scope, freshness } = graph;

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3"
      aria-label="关系图摘要"
      data-testid="graph-summary"
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-[var(--ink)]">
        <span data-testid="graph-summary-nodes">
          当前图：{scope.shownNodeCount} 个节点、{scope.shownEdgeCount} 条关系
        </span>
        <span className="text-[var(--ink-muted)]" data-testid="graph-summary-matches">
          筛选共匹配 {scope.matchedNodeCount} 个节点、{scope.matchedEdgeCount} 条关系
        </span>
        {scope.suggestedEdgeCount > 0 ? (
          <span className="text-[var(--ink-muted)]" data-testid="graph-summary-suggested">
            其中待确认 {scope.suggestedEdgeCount} 条
          </span>
        ) : null}
        {libraryTotal !== null ? (
          <span className="text-[var(--ink-muted)]">知识库合计 {libraryTotal} 条</span>
        ) : null}
      </div>

      {scope.truncated ? (
        <div
          role="status"
          data-testid="graph-truncated"
          className="flex flex-col gap-2 rounded-md border border-[var(--warn)] bg-[var(--surface-raised)] p-3 text-sm text-[var(--warn-ink)]"
        >
          <span>
            已达显示上限：当前只画出 {scope.shownNodeCount} 个节点、{scope.shownEdgeCount} 条关系，
            共匹配 {scope.matchedNodeCount} 个节点、{scope.matchedEdgeCount} 条关系。
            <strong>这不是全部知识。</strong>
          </span>
          <span className="text-xs">
            用上方筛选（标签、类型、审核状态）缩小范围，或在资料库里按条件查看全部材料。
          </span>
          <div>
            <Button variant="secondary" data-testid="graph-open-library" onClick={onOpenLibrary}>
              去资料库查看全部
            </Button>
          </div>
        </div>
      ) : null}

      {freshness.notice ? (
        <p
          role="status"
          data-testid="graph-freshness-notice"
          className="rounded-md border border-[var(--warn)] bg-[var(--surface-raised)] p-2 text-xs text-[var(--warn-ink)]"
        >
          {freshness.notice}
        </p>
      ) : null}

      {/*
        The text alternative. Each row is a button so a keyboard user can reach a
        relation and open its inspection panel without touching the canvas.
      */}
      <details className="text-sm" data-testid="graph-relation-list">
        <summary className="cursor-pointer text-[var(--ink)]">
          以列表阅读这 {graph.edges.length} 条关系（图的文本替代）
        </summary>
        {/*
          The counts a canvas cannot announce (T050-C02). A screen reader is told
          exactly what the picture contains — including how many edges were
          withheld — so "不用图形画布" loses no information. The numbers come from
          `scope`, the same object the header above renders, so the two cannot
          drift apart.
        */}
        <p className="mt-2 text-xs text-[var(--ink-muted)]" data-testid="graph-alt-summary">
          <span data-testid="graph-alt-summary-nodes">节点 {scope.shownNodeCount} 个</span>
          {'、'}
          <span data-testid="graph-alt-summary-edges">关系 {scope.shownEdgeCount} 条</span>
          {scope.suggestedEdgeCount > 0
            ? `（其中待确认 ${scope.suggestedEdgeCount} 条）`
            : ''}
          {scope.truncated ? `；筛选共匹配 ${scope.matchedNodeCount} 个节点、${scope.matchedEdgeCount} 条关系` : ''}
        </p>
        {graph.edges.length === 0 ? (
          <p className="mt-2 text-xs text-[var(--ink-muted)]">当前范围内还没有关系。</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {graph.edges.map((edge) => (
              <li key={edge.id} className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="text-left text-[var(--ink)] underline decoration-dotted"
                  data-testid="graph-relation-list-item"
                  data-relation-id={edge.id}
                  onClick={() => onSelectRelation(edge.id)}
                >
                  {edge.label}
                </button>
                <span className="text-xs text-[var(--ink-muted)]">
                  {REVIEW_STATUS_LABELS[edge.reviewStatus]}
                  {edge.origin === 'manual' ? '·人工' : '·AI'}
                  {edge.freshness !== 'fresh' ? `·${STALE_LABEL}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}
