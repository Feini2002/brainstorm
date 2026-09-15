'use client';

/**
 * Relation inspector (T049-R02, T049-R06, T048-R03).
 *
 * Shows everything needed to judge one edge: the two endpoints, what the type
 * means in words, the reason, the recorded evidence, the endpoint versions it was
 * based on, its review status, and an honest description of the score. Long text
 * lives here rather than on the canvas (T049-R05).
 *
 * Reviewing uses the real `PATCH /api/relations/{id}` with `expectedRevision`, and
 * the panel reports its own outcome; the caller refreshes only the affected edges
 * (T049-R03) instead of reloading the whole page.
 */
import { useState } from 'react';

import type { GraphViewEdge } from '@/domain/graph';
import type { RelationDTO } from '@/domain/knowledge';
import { relationTypeMeta, RELATION_TYPE_META } from '@/domain/relations';
import { REVIEW_STATUS_LABELS } from '@/domain/relation';
import { Button, InlineError } from '@/components/ui/primitives';
import { ApiClientError, apiRequest } from '@/features/shared/apiClient';
import { describeScore } from '@/features/graph/badges';

export interface GraphInspectorProps {
  edge: GraphViewEdge | null;
  /** Labels of both endpoints, resolved by the caller from the current nodes. */
  sourceLabel: string;
  targetLabel: string;
  onReviewed: (relationId: string) => void;
  onOpenItem: (itemId: string) => void;
  onClose: () => void;
}

export function GraphInspector({
  edge,
  sourceLabel,
  targetLabel,
  onReviewed,
  onOpenItem,
  onClose,
}: GraphInspectorProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!edge) {
    return (
      <section
        className="rounded-lg border border-dashed border-[var(--line)] bg-[var(--surface-raised)] p-3 text-sm text-[var(--ink-muted)]"
        aria-label="关系详情"
        data-testid="graph-inspector-empty"
      >
        选中一条关系或一个节点以查看详情。节点会打开统一的记录详情抽屉。
      </section>
    );
  }

  const meta = relationTypeMeta(edge.type);

  /**
   * Apply a review decision.
   *
   * The endpoint takes an `action` (`accept` / `reject` / `restoreSuggestion` /
   * `reconfirm`), not a target status — the schema is strict, so sending
   * `reviewStatus` here was rejected with a 400 and the buttons never worked.
   * A manual relation has no suggestion to confirm, so it is not offered these
   * actions at all.
   */
  async function review(action: 'accept' | 'reject') {
    if (!edge || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await apiRequest<RelationDTO>(`/api/relations/${edge.id}`, {
        method: 'PATCH',
        body: { action, expectedRevision: edge.revision },
      });
      setNotice(
        action === 'reject'
          ? '已拒绝这条建议。该记录会保留为墓碑，之后的整理不会再复活它。'
          : '已确认这条关系。',
      );
      onReviewed(updated.id);
    } catch (caught) {
      setError(
        caught instanceof ApiClientError
          ? caught
          : new ApiClientError({ code: 'INTERNAL', message: '审核失败', retryable: false }),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3"
      aria-label="关系详情"
      data-testid="graph-inspector"
    >
      <header className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--ink)]">关系详情</h3>
        <Button variant="ghost" data-testid="graph-inspector-close" onClick={onClose}>
          关闭
        </Button>
      </header>

      <p className="text-sm text-[var(--ink)]" data-testid="graph-inspector-sentence">
        {edge.label}
      </p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-[var(--ink-muted)]">起点</dt>
        <dd>
          <button
            type="button"
            className="text-left text-[var(--ink)] underline decoration-dotted"
            onClick={() => onOpenItem(edge.sourceId)}
          >
            {sourceLabel}
          </button>
        </dd>
        <dt className="text-[var(--ink-muted)]">终点</dt>
        <dd>
          <button
            type="button"
            className="text-left text-[var(--ink)] underline decoration-dotted"
            onClick={() => onOpenItem(edge.targetId)}
          >
            {targetLabel}
          </button>
        </dd>
        <dt className="text-[var(--ink-muted)]">类型含义</dt>
        <dd className="text-[var(--ink)]">
          {meta.label}
          {meta.symmetric ? '（对称，两端含义相同）' : `（${meta.directionHint}）`}
        </dd>
        <dt className="text-[var(--ink-muted)]">来源</dt>
        <dd className="text-[var(--ink)]">
          {edge.origin === 'manual' ? '人工建立' : '模型建议'}·
          {REVIEW_STATUS_LABELS[edge.reviewStatus]}
        </dd>
        <dt className="text-[var(--ink-muted)]">评分</dt>
        <dd className="text-[var(--ink)]" data-testid="graph-inspector-score">
          {describeScore(edge.origin, edge.score)}
        </dd>
        <dt className="text-[var(--ink-muted)]">依据版本</dt>
        <dd className="text-[var(--ink)]" data-testid="graph-inspector-versions">
          起点原文 v{edge.sourceRawVersion}，终点原文 v{edge.targetRawVersion}；关系 revision{' '}
          {edge.revision}
        </dd>
      </dl>

      {edge.freshness !== 'fresh' ? (
        <p
          role="status"
          className="rounded-md border border-[var(--warn)] bg-[var(--surface-raised)] p-2 text-xs text-[var(--warn-ink)]"
          data-testid="graph-inspector-stale"
        >
          {edge.freshness === 'missing'
            ? '这条关系的一个端点已被删除，依据无法再核对。'
            : '这条关系所依据的原文版本已经变化，记录的证据不再对应当前内容。可重新整理来源，或确认关系仍然成立。'}
        </p>
      ) : null}

      {/*
        The evidence, shown rather than summarised (T049-R02/T049-C02).
        Without it the user is asked to accept or reject a judgement while the
        material it was made on stays hidden — which is the difference between a
        citation and a decoration. Each quote is attributed to the endpoint it
        was verified against; `verifyEvidence` refuses a quote that belongs to
        any other item, so a cited id is always one of the two ends.
      */}
      <div className="flex flex-col gap-1">
        <h4 className="text-xs font-medium text-[var(--ink-muted)]">证据摘录</h4>
        {edge.evidence.length === 0 ? (
          <p className="text-sm text-[var(--ink-muted)]" data-testid="graph-inspector-no-evidence">
            {edge.origin === 'manual'
              ? '人工建立的关系没有模型引文；理由见下。'
              : '这条关系没有留下引文，无法回溯到具体原文。'}
          </p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="graph-inspector-evidence">
            {edge.evidence.map((entry, index) => (
              <li
                key={`${entry.itemId}-${index}`}
                data-testid="graph-inspector-evidence-item"
                data-evidence-item-id={entry.itemId}
                className="rounded-md border border-[var(--line)] bg-[var(--surface-raised)] p-2 text-xs"
              >
                <p className="text-[var(--ink)]">「{entry.quote}」</p>
                <p className="text-[var(--ink-muted)]">
                  出自：{entry.itemId === edge.sourceId ? sourceLabel : targetLabel} · 原文 v
                  {entry.rawVersion}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <h4 className="text-xs font-medium text-[var(--ink-muted)]">理由</h4>
        <p className="whitespace-pre-wrap text-sm text-[var(--ink)]" data-testid="graph-inspector-reason">
          {edge.reason.trim().length > 0 ? edge.reason : '（没有记录理由）'}
        </p>
      </div>

      {error ? <InlineError message={error.message} /> : null}
      {notice ? (
        <p role="status" className="text-xs text-[var(--success)]">
          {notice}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          data-testid="graph-inspector-accept"
          disabled={busy || edge.reviewStatus === 'accepted' || edge.origin === 'manual'}
          onClick={() => void review('accept')}
        >
          确认关系
        </Button>
        <Button
          variant="danger"
          data-testid="graph-inspector-reject"
          disabled={busy || edge.reviewStatus === 'rejected' || edge.origin === 'manual'}
          onClick={() => void review('reject')}
        >
          拒绝这条建议
        </Button>
      </div>
      {edge.origin === 'manual' ? (
        <p className="text-xs text-[var(--ink-muted)]" data-testid="graph-inspector-manual-hint">
          人工建立的关系始终视为已确认；如需撤销，请在资料库的关系详情里删除它。
        </p>
      ) : null}

      <p className="text-xs text-[var(--ink-muted)]">
        关系类型：{RELATION_TYPE_META.map((entry) => entry.label).join('、')}
      </p>
    </section>
  );
}
