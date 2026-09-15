'use client';

/**
 * Inbox timeline (T015).
 *
 * Shows the most recent captures newest-first, using the same list endpoint the
 * library uses. It renders honestly at every stage: loading, empty, and error
 * each have a distinct, actionable presentation — no placeholder cards and no
 * silent failure.
 */
import type { ItemPageResult } from '@/domain/api';
import { Button, EmptyState, InlineError, LoadingIndicator } from '@/components/ui/primitives';
import { timelineSummary } from '@/features/shared/cardDisplay';
import { KnowledgeCard } from '@/features/shared/KnowledgeCard';
import { useApiQuery } from '@/features/shared/useApiQuery';
import { useSelection } from '@/features/shared/workspace';

export interface RecentItemsProps {
  onOpen?: (id: string) => void;
  /** Bumped by the parent after a successful capture so the list refetches. */
  refreshToken?: number;
  /** How many records the timeline asks for. */
  limit?: number;
}

/** The timeline never shows more than this in one page. */
const DEFAULT_LIMIT = 20;

export function RecentItems({ onOpen, refreshToken = 0, limit = DEFAULT_LIMIT }: RecentItemsProps) {
  const selection = useSelection();
  // `refreshToken` is folded into the query so a new capture refetches; the
  // hook keeps stale responses from overwriting newer ones.
  const state = useApiQuery<ItemPageResult>('/api/items', {
    query: { sort: 'newest', limit },
    version: refreshToken,
  });
  const page = state.data;

  if (state.loading && page === null) {
    return <LoadingIndicator label="正在读取最近记录" />;
  }

  if (state.error) {
    return (
      <InlineError message={state.error.message}>
        <Button variant="secondary" onClick={state.reload}>
          重新读取
        </Button>
      </InlineError>
    );
  }

  if (page === null || page.items.length === 0) {
    return (
      <EmptyState
        title="还没有记录"
        description="上面写一句话就会出现在这里。即使没有配置模型，保存原文也能正常工作。"
      />
    );
  }

  return (
    <section className="flex flex-col gap-3" aria-label="最近记录">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-[var(--ink)]">最近记录</h2>
        <p className="text-xs text-[var(--ink-muted)]" data-testid="timeline-summary">
          {timelineSummary({ shown: page.items.length, totalMatched: page.totalMatched })}
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {page.items.map((item) => (
          /*
            The React key is the item id, never the title and never the index
            (T015-R03/C03): two records can share a title, and reordering a list
            keyed by index makes React reuse the wrong subtree.
          */
          <li key={item.id}>
            <KnowledgeCard
              item={item}
              {...(onOpen ? { onOpen } : {})}
              selection={{
                selected: selection.has(item.id),
                onToggle: selection.toggle,
                disabled: selection.isFull,
              }}
            />
          </li>
        ))}
      </ul>
      {page.totalMatched > page.items.length ? (
        <p className="text-xs text-[var(--ink-muted)]">更多记录请到资料库搜索与筛选。</p>
      ) : null}
    </section>
  );
}
