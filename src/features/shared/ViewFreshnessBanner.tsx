'use client';

/**
 * View freshness banner (T059-R01, T059-C01).
 *
 * Says *why* a saved projection is no longer backed by its record, and does so
 * without implying the picture was rewritten. Those are two different claims and
 * the difference is the whole point of keeping history: the map on screen is
 * exactly what was generated, and the notes underneath it have moved on since.
 *
 * Three decisions:
 *
 *  - **The specific source, not just a count.** 「1 条笔记已修改」 is true but not
 *    actionable; naming the note and its version change lets the user go and
 *    check whether the projection is still right (docs/03_contracts/09 §5).
 *  - **Actionable, or silent.** When every source still matches, this renders
 *    nothing at all. A banner that always says something is a banner nobody
 *    reads, and "this map is current" is not news.
 *  - **Missing sources stay visible even when nothing is stale.** A deleted note
 *    is not a version change, so `isStale` is false for it, but the user needs to
 *    know part of the basis is gone.
 */
import type { ViewFreshness } from '@/domain/view';
import { formatTime } from '@/features/shared/formatTime';

/** How many sources to name before summarising the rest. */
const DRIFT_LIMIT = 3;

export function ViewFreshnessBanner({
  freshness,
  onOpenItem,
}: {
  freshness: ViewFreshness;
  /** Opens a drifted note in the shared drawer, when the host can resolve it. */
  onOpenItem?: (itemId: string) => void;
}) {
  const quiet =
    freshness.reason === null &&
    freshness.drift.length === 0 &&
    freshness.missingSourceCount === 0;
  if (quiet) return null;

  const shown = freshness.drift.slice(0, DRIFT_LIMIT);
  const hidden = freshness.drift.length - shown.length;

  return (
    <section
      role="status"
      aria-label="来源过期情况"
      data-testid="view-freshness-banner"
      data-stale={freshness.isStale ? 'true' : 'false'}
      className="flex flex-col gap-2 rounded-lg border border-[var(--warn-line,var(--line))] bg-[var(--surface)] p-3 text-sm"
    >
      <p className="text-[var(--warn-ink)]" data-testid="view-freshness-reason">
        {freshness.reason ?? `有 ${freshness.missingSourceCount} 条来源已删除`}
      </p>

      <p className="text-xs text-[var(--ink-muted)]" data-testid="view-freshness-scope">
        这张图仍然显示生成时的内容
        {freshness.generatedAt
          ? `（生成于 ${formatTime(freshness.generatedAt).absolute}）`
          : ''}
        ，不会被自动改写。重新生成会新建一张，旧图继续保留。
      </p>

      {shown.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs" data-testid="view-freshness-drift">
          {shown.map((entry) => (
            <li key={`${entry.kind}:${entry.id}`} data-testid="view-freshness-drift-row">
              <span className="text-[var(--ink)]">
                {entry.kind === 'item' ? (entry.title ?? '未命名笔记') : '关系'}
              </span>
              <span className="text-[var(--ink-muted)]">：{entry.message}</span>
              {entry.kind === 'item' && !entry.missing && onOpenItem ? (
                <button
                  type="button"
                  className="ml-2 underline"
                  data-testid="view-freshness-open"
                  onClick={() => onOpenItem(entry.id)}
                >
                  查看原文
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {hidden > 0 ? (
        <p className="text-xs text-[var(--ink-muted)]" data-testid="view-freshness-more">
          另有 {hidden} 条来源变化未逐条列出。
        </p>
      ) : null}
    </section>
  );
}
