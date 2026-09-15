'use client';

/**
 * Saved-flow list (T067-R01/R04/R06).
 *
 * The list is the page's statement that flows are *history*, not a canvas that
 * happens to be on screen: every generation is a new row, the previous one is
 * still there, and opening a row is a read.
 *
 * Three things the shape of this component enforces:
 *
 *  - **Nothing here can create or modify a flow.** There is no write call in this
 *    file at all, so "browsing produced a model request" is impossible rather than
 *    merely discouraged (T067-C05). `generatedAt` is displayed and never touched —
 *    the timestamp belongs to the run that produced the content, and re-reading it
 *    must not move it (T067-R06).
 *  - **Two views of the same question stay comparable (T067-C04).** Rows are shown
 *    newest-first with their generation time and source count, so the earlier and
 *    later answer to one observation question can be told apart and opened in turn.
 *  - **Staleness is stated on the row.** A flow whose sources or relations moved
 *    says so before it is opened, because the alternative is discovering it after
 *    reading the picture as current (T067-R03, T067-C02).
 */
import type { ViewSummaryDTO } from '@/domain/knowledge';
import { Button, Field, Select } from '@/components/ui/primitives';
import { formatTime } from '@/features/shared/formatTime';

export interface SavedFlowListProps {
  views: readonly ViewSummaryDTO[];
  /** The view currently open, or null. */
  activeId: string | null;
  disabled?: boolean;
  onSelect: (viewId: string | null) => void;
  /** Refresh the list from the server. A read, never a generation. */
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function SavedFlowList({
  views,
  activeId,
  disabled = false,
  onSelect,
  onRefresh,
  refreshing = false,
}: SavedFlowListProps) {
  return (
    <section
      className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3"
      aria-label="已保存的流程图"
      data-testid="flow-saved-list"
    >
      <Field label="已保存的流程图" htmlFor="flow-view-select">
        <Select
          id="flow-view-select"
          data-testid="flow-view-select"
          value={activeId ?? ''}
          disabled={disabled}
          onChange={(event) => onSelect(event.target.value || null)}
        >
          <option value="">不打开已保存的流程图</option>
          {views.map((entry) => (
            <option key={entry.id} value={entry.id} data-testid="flow-view-option">
              {entry.name}
              {entry.isStale ? '（来源已变化）' : ''}
              {entry.missingSourceCount > 0 ? `（${entry.missingSourceCount} 条来源已删除）` : ''}
            </option>
          ))}
        </Select>
      </Field>

      <p className="text-xs text-[var(--ink-muted)]" data-testid="flow-saved-count">
        共 {views.length} 张，都是各自生成时间的快照；打开只读取本地数据，不会调用模型。
      </p>

      {onRefresh ? (
        <Button
          variant="secondary"
          data-testid="flow-refresh-list"
          disabled={refreshing}
          onClick={onRefresh}
        >
          {refreshing ? '正在刷新…' : '刷新列表'}
        </Button>
      ) : null}

      {views.length > 0 ? (
        <ul className="flex w-full flex-col gap-1 text-xs" data-testid="flow-saved-rows">
          {views.map((entry) => (
            <li
              key={entry.id}
              data-testid="flow-saved-row"
              data-view-id={entry.id}
              data-active={entry.id === activeId ? 'true' : 'false'}
              data-stale={entry.isStale ? 'true' : 'false'}
              className="flex flex-wrap items-baseline gap-2 rounded-md border border-[var(--line)] p-2"
            >
              <button
                type="button"
                className="text-left text-sm text-[var(--ink)] underline-offset-2 hover:underline"
                data-testid="flow-saved-open"
                onClick={() => onSelect(entry.id)}
              >
                {entry.name}
              </button>
              <span className="text-[var(--ink-muted)]">
                生成于 {entry.generatedAt ? formatTime(entry.generatedAt).absolute : '未知时间'}
                ，来源 {entry.sourceCount} 条
              </span>
              {entry.isStale ? (
                <span className="text-[var(--warn-ink)]" data-testid="flow-saved-stale">
                  依据来源已变化
                </span>
              ) : null}
              {entry.missingSourceCount > 0 ? (
                <span className="text-[var(--warn-ink)]" data-testid="flow-saved-missing">
                  {entry.missingSourceCount} 条来源已删除
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
