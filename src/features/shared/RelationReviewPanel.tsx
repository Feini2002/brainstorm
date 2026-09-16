'use client';

/**
 * Relation review panel (T023).
 *
 * Shows every relation an item participates in, including rejected ones, and
 * explains where each came from. The panel deliberately displays more than a
 * button: origin (AI or manual), the reason, the versions the judgement was made
 * against, and — for AI rows — what the score does *and does not* mean. A bare
 * number invites the reading "89% correct", which the contract forbids.
 *
 * Review actions never touch the model: accept/reject/reconfirm/restore only
 * change review state (T023-C06).
 *
 * Reads go through `useApiQuery`, which already owns loading/error state, stale
 * response ordering and `reload`. Endpoint labels are passed in by the drawer,
 * which already fetched the item list — the panel does not fetch them again.
 */
import { useCallback, useMemo, useState } from 'react';

import type { ItemDTO, RelationDTO } from '@/domain/knowledge';
import { RELATION_TYPE_LABELS } from '@/domain/knowledge';
import { describeRelation, REVIEW_STATUS_LABELS } from '@/domain/relation';
import { ApiClientError, apiRequest } from '@/features/shared/apiClient';
import { useApiQuery } from '@/features/shared/useApiQuery';
import { Button, InlineError, LoadingIndicator } from '@/components/ui/primitives';
import {
  EMPTY_STATES,
  STALE_LABEL,
  describeScoreMeaning,
} from '@/features/shared/StatusLabel';

export interface RelationReviewPanelProps {
  item: Pick<ItemDTO, 'id'>;
  /** Short display name per item id; falls back to a truncated id. */
  labels: ReadonlyMap<string, string>;
  /** Bumped by the parent after an edit, so versions shown stay current. */
  refreshToken?: number;
  /** Called after any successful change, so sibling views can refetch. */
  onChanged?: () => void;
}

const ORIGIN_LABELS: Record<RelationDTO['origin'], string> = {
  ai: '来自 AI 建议',
  manual: '人工建立',
};

export function RelationReviewPanel({
  item,
  labels,
  refreshToken = 0,
  onChanged,
}: RelationReviewPanelProps) {
  const query = useMemo(
    // Rejected rows are requested explicitly: "why is this gone?" must stay
    // answerable from the detail view.
    () => ({ itemId: item.id, includeStale: true, includeRejected: true }),
    [item.id],
  );
  const state = useApiQuery<RelationDTO[]>('/api/relations', { query, version: refreshToken });
  const { reload } = state;

  const [actionError, setActionError] = useState<ApiClientError | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const relations = state.data;

  const labelFor = useCallback(
    (id: string) => labels.get(id) ?? id.slice(0, 8),
    [labels],
  );

  const act = useCallback(
    async (
      relation: RelationDTO,
      action: 'accept' | 'reject' | 'restoreSuggestion' | 'reconfirm',
    ) => {
      setBusyId(relation.id);
      setNotice(null);
      setActionError(null);
      try {
        await apiRequest<RelationDTO>(`/api/relations/${relation.id}`, {
          method: 'PATCH',
          body: { expectedRevision: relation.revision, action },
        });
        setNotice(actionNotice(action));
        reload();
        onChanged?.();
      } catch (caught) {
        setActionError(
          caught instanceof ApiClientError
            ? caught
            : new ApiClientError({ code: 'INTERNAL', message: '审核失败', retryable: false }),
        );
      } finally {
        setBusyId(null);
      }
    },
    [onChanged, reload],
  );

  const remove = useCallback(
    async (relation: RelationDTO) => {
      setBusyId(relation.id);
      setNotice(null);
      setActionError(null);
      try {
        await apiRequest<{ deletedId: string }>(`/api/relations/${relation.id}`, {
          method: 'DELETE',
          body: { expectedRevision: relation.revision },
        });
        setNotice('人工关系已删除');
        reload();
        onChanged?.();
      } catch (caught) {
        setActionError(
          caught instanceof ApiClientError
            ? caught
            : new ApiClientError({ code: 'INTERNAL', message: '删除关系失败', retryable: false }),
        );
      } finally {
        setBusyId(null);
      }
    },
    [onChanged, reload],
  );

  const displayError = actionError ?? state.error;

  return (
    <section className="flex flex-col gap-2" data-testid="relation-review-panel">
      <h3 className="text-sm font-semibold text-[var(--ink)]">关系</h3>

      {state.loading ? <LoadingIndicator label="正在读取关系" /> : null}

      {displayError ? (
        <InlineError message={displayError.message}>
          <Button variant="secondary" onClick={reload}>
            重新读取
          </Button>
        </InlineError>
      ) : null}

      {notice ? (
        <p role="status" className="text-xs text-[var(--success)]">
          {notice}
        </p>
      ) : null}

      {relations !== null && relations.length === 0 ? (
        <p className="text-sm text-[var(--ink-muted)]">{EMPTY_STATES.noRelations}</p>
      ) : null}

      {relations !== null && relations.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {relations.map((relation) => (
            <li
              key={relation.id}
              data-testid="relation-row"
              className="flex flex-col gap-1 rounded-md border border-[var(--line)] bg-[var(--surface-raised)] p-2 text-sm"
            >
              <p className="text-[var(--ink)]">
                {describeRelation(
                  relation.type,
                  labelFor(relation.sourceId),
                  labelFor(relation.targetId),
                )}
              </p>

              {/*
                One vocabulary for the score, shared with the graph inspector and
                the canvas badge. `relation.score` is a null-able number and a
                manual relation has none at all, so the third case is spelled out
                rather than rendered as "0.00" (T082-R02).
              */}
              <p className="text-xs text-[var(--ink-muted)]">
                {RELATION_TYPE_LABELS[relation.type]} · {ORIGIN_LABELS[relation.origin]} ·{' '}
                {REVIEW_STATUS_LABELS[relation.reviewStatus]} ·{' '}
                {describeScoreMeaning({ origin: relation.origin, score: relation.score })}
              </p>

              {relation.reason.trim().length > 0 ? (
                <p className="text-xs text-[var(--ink-muted)]">理由：{relation.reason}</p>
              ) : null}

              <p className="text-xs text-[var(--ink-muted)]">
                依据版本：起点 raw v{relation.sourceRawVersion} · 终点 raw v
                {relation.targetRawVersion}
                {relation.evidence.length > 0 ? ` · ${relation.evidence.length} 条引文` : ''}
              </p>

              {relation.isStale ? (
                <p className="text-xs text-[var(--warn-ink)]">
                  {STALE_LABEL}：这条判断基于旧版本的原文，需要重新确认才会更新依据。
                </p>
              ) : null}

              <div className="flex flex-wrap gap-2">
                {relation.origin === 'ai' && relation.reviewStatus === 'suggested' ? (
                  <>
                    <Button
                      variant="secondary"
                      disabled={busyId === relation.id}
                      onClick={() => void act(relation, 'accept')}
                    >
                      确认
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busyId === relation.id}
                      onClick={() => void act(relation, 'reject')}
                    >
                      拒绝
                    </Button>
                  </>
                ) : null}

                {relation.origin === 'ai' && relation.reviewStatus === 'accepted' ? (
                  <Button
                    variant="ghost"
                    disabled={busyId === relation.id}
                    onClick={() => void act(relation, 'reject')}
                  >
                    撤销确认
                  </Button>
                ) : null}

                {relation.origin === 'ai' && relation.reviewStatus === 'rejected' ? (
                  <Button
                    variant="secondary"
                    disabled={busyId === relation.id}
                    onClick={() => void act(relation, 'restoreSuggestion')}
                  >
                    重新允许这条建议
                  </Button>
                ) : null}

                {relation.isStale ? (
                  <Button
                    variant="secondary"
                    disabled={busyId === relation.id}
                    onClick={() => void act(relation, 'reconfirm')}
                  >
                    按当前原文重新确认
                  </Button>
                ) : null}

                {relation.origin === 'manual' ? (
                  <Button
                    variant="danger"
                    disabled={busyId === relation.id}
                    onClick={() => void remove(relation)}
                  >
                    删除这条人工关系
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function actionNotice(action: 'accept' | 'reject' | 'restoreSuggestion' | 'reconfirm'): string {
  switch (action) {
    case 'accept':
      return '已确认这条建议';
    case 'reject':
      return '已拒绝，重新整理时不会再次出现';
    case 'restoreSuggestion':
      return '已恢复为待确认，可以再次审核';
    case 'reconfirm':
      return '已按当前原文更新依据版本';
  }
}
