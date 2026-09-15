'use client';

/**
 * Regenerate a saved projection (T059-R02, T059-R03, T059-R06).
 *
 * Regeneration creates a **new** View and leaves the old one alone. That is not
 * an implementation detail the user can be left to discover: the confirmation
 * step says it, because "regenerate" is a word that normally means "replace".
 *
 * The confirmation is not ceremony. A filter selection resolves to whatever the
 * filter matches *now*, so the set about to be sent may differ from the one the
 * old map was built from — a tag may have gained members (T059-C04). The user
 * gets the resolved count and the added/removed ids, and confirms that scope.
 * Sending it without asking would be the one failure a projection's provenance
 * cannot survive, and it would be discovered only after paying for the call.
 *
 * Regeneration is refused, with the reason, in two cases that no confirmation can
 * fix:
 *  - the selection now resolves to nothing — there is no material to organise,
 *    and an empty prompt would invite the model to invent its own (T059-R06);
 *  - the selection is over budget — the server would refuse it anyway, so the
 *    button says why instead of turning into a 400.
 */
import { useState } from 'react';

import type { ViewFreshness } from '@/domain/view';
import { Button, InlineError } from '@/components/ui/primitives';

export interface RegenerateOutcome {
  /** The new view's id, when the server produced one. */
  viewId: string | null;
  state: 'succeeded' | 'conflict' | 'failed';
  warnings: string[];
}

export function RegenerateAction({
  freshness,
  /** True while a generation is in flight, so the button cannot be double-fired. */
  busy,
  onRegenerate,
}: {
  freshness: ViewFreshness;
  busy: boolean;
  onRegenerate: (input: { requestKey: string; itemIds: string[] }) => Promise<RegenerateOutcome>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RegenerateOutcome | null>(null);

  const selection = freshness.currentSelection;
  const blockedReason = selection.isEmpty
    ? '这张图引用的来源已经全部删除，没有可以整理的材料。旧图仍然可以打开和导出，但不会向模型发起空请求。'
    : !selection.withinBudget
      ? (selection.budgetMessage ?? '当前材料超出单次整理上限')
      : null;

  const start = async () => {
    setRunning(true);
    setError(null);
    setOutcome(null);
    try {
      const result = await onRegenerate({
        // The key is minted per explicit user action, so a retry after a failure
        // is a new request while a double-click is the same one. The server
        // deduplicates on it.
        requestKey: crypto.randomUUID(),
        itemIds: selection.resolvedIds,
      });
      setOutcome(result);
      setConfirming(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '重新生成失败');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="regenerate-action">
      {blockedReason ? (
        <p className="text-xs text-[var(--warn-ink)]" data-testid="regenerate-blocked">
          {blockedReason}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="regenerate-open"
            disabled={busy || running}
            onClick={() => setConfirming((value) => !value)}
          >
            按当前来源重新生成
          </Button>
          <span className="text-xs text-[var(--ink-muted)]" data-testid="regenerate-scope">
            将发送 {selection.count} 条来源
          </span>
        </div>
      )}

      {confirming && !blockedReason ? (
        <div
          className="flex flex-col gap-2 rounded-md border border-[var(--line)] bg-[var(--surface-raised)] p-3 text-xs"
          data-testid="regenerate-confirm"
        >
          <p className="text-[var(--ink)]">
            将用当前选中的 {selection.count} 条来源重新生成一张新脑图（原图生成时是{' '}
            {selection.snapshotCount} 条）。新旧两张会同时保留，方便对照。
          </p>

          {/*
            Membership changes are stated as ids-and-counts rather than a bare
            "the selection changed" flag. The user is confirming which material
            leaves their machine, so the honest thing is the concrete difference.
          */}
          {selection.addedIds.length > 0 ? (
            <p className="text-[var(--warn-ink)]" data-testid="regenerate-added">
              新增 {selection.addedIds.length} 条生成时没有的来源。
            </p>
          ) : null}
          {selection.removedIds.length > 0 ? (
            <p className="text-[var(--warn-ink)]" data-testid="regenerate-removed">
              有 {selection.removedIds.length} 条来源已不在选择范围内，本次不会发送。
            </p>
          ) : null}
          {selection.addedIds.length === 0 && selection.removedIds.length === 0 ? (
            <p className="text-[var(--ink-muted)]" data-testid="regenerate-same">
              来源集合与生成时一致。
            </p>
          ) : null}

          <div className="flex items-center gap-2">
            <Button data-testid="regenerate-confirm-go" disabled={running} onClick={() => void start()}>
              {running ? '正在生成…' : '确认重新生成'}
            </Button>
            <Button
              variant="ghost"
              data-testid="regenerate-confirm-cancel"
              disabled={running}
              onClick={() => setConfirming(false)}
            >
              取消
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <InlineError message={error}>
          {/*
            A failed generation is reported and nothing else changes: the old map
            keeps its content, hash and generatedAt (T059-C03).
          */}
          <span className="text-xs" data-testid="regenerate-error-note">
            原图没有被改动，仍可继续查看。
          </span>
        </InlineError>
      ) : null}

      {outcome ? (
        <div className="flex flex-col gap-1 text-xs" data-testid="regenerate-outcome">
          <p
            className={outcome.state === 'succeeded' ? 'text-[var(--ink)]' : 'text-[var(--warn-ink)]'}
            data-testid="regenerate-outcome-state"
          >
            {outcome.state === 'succeeded'
              ? '已经生成新的脑图，可以在上面的列表里切换查看；旧图仍然保留。'
              : outcome.state === 'conflict'
                ? '生成期间来源发生了变化，本次没有保存新脑图，旧图保持原样。'
                : '这次生成没有成功，旧图保持原样。'}
          </p>
          {outcome.warnings.map((warning) => (
            <p key={warning} className="text-[var(--ink-muted)]">
              {warning}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
