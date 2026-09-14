'use client';

/**
 * Selection tray (T021).
 *
 * States plainly how many items are selected, what the budget is, and what the
 * user can do next. Two facts are called out rather than left implicit:
 *
 *  - selected items the current filter hides, so the send scope is never wider
 *    than what is on screen without the user knowing (T021-C03);
 *  - items dropped because they were deleted, so a shrinking list is explained
 *    (T021-C04).
 *
 * Nothing here runs a generation: the tray only navigates to the mindmap or flow
 * page, which validates the ids again server-side before anything is sent.
 */
import Link from 'next/link';

import { Button } from '@/components/ui/primitives';
import { useSelection } from './workspace';

export function SelectionTray() {
  const selection = useSelection();

  if (selection.count === 0 && selection.removedIds.length === 0) return null;

  return (
    <div
      data-testid="selection-tray"
      className="flex flex-col gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-raised)] px-3 py-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-[var(--ink)]" data-testid="selection-count">
          已选 {selection.count} / {selection.limit} 条
          {selection.isFull ? '（已达上限，继续勾选不会加入）' : ''}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/mindmap"
            data-testid="selection-to-mindmap"
            className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--ink)] hover:bg-[var(--surface-raised)]"
          >
            生成思维导图
          </Link>
          <Link
            href="/flow"
            data-testid="selection-to-flow"
            className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--ink)] hover:bg-[var(--surface-raised)]"
          >
            生成流程图
          </Link>
          <Button variant="ghost" data-testid="selection-clear" onClick={() => selection.clear()}>
            清空选择
          </Button>
        </div>
      </div>

      {selection.hiddenCount !== null && selection.hiddenCount > 0 ? (
        <p className="text-xs text-[var(--warn-ink)]" data-testid="selection-hidden">
          当前筛选看不到其中 {selection.hiddenCount} 条，但它们仍会被发送。
        </p>
      ) : null}

      {selection.removedIds.length > 0 ? (
        <p
          className="text-xs text-[var(--warn-ink)]"
          role="status"
          data-testid="selection-removed"
        >
          有 {selection.removedIds.length} 条已删除，已从选择中移除。
          <Button
            variant="ghost"
            className="ml-1"
            onClick={() => selection.acknowledgeRemoved()}
          >
            知道了
          </Button>
        </p>
      ) : null}
    </div>
  );
}
