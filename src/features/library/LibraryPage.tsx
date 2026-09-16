'use client';

/**
 * Library (T016).
 *
 * Search is literal matching over raw text, title, summary and tag names — it is
 * not semantic understanding and it never calls a model (T016-R06), so the UI
 * says so instead of implying more.
 *
 * Staleness (T016-R05) is handled by `useApiQuery`, which discards a slow
 * earlier response instead of letting it overwrite a newer query. Changing a
 * filter resets to the first page; "load more" appends.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ItemPageResult } from '@/domain/api';
import type { ItemDTO, TagDTO } from '@/domain/knowledge';
import { ITEM_STATUSES, ITEM_STATUS_LABELS, ITEM_TYPES, ITEM_TYPE_LABELS } from '@/domain/knowledge';
import {
  EMPTY_LIBRARY_QUERY,
  activeFilterCount,
  resolvePageSize,
  type ItemSort,
  type LibraryQuery,
} from '@/domain/query';
import { PageHeader } from '@/components/AppShell';
import {
  Button,
  EmptyState,
  Field,
  InlineError,
  LoadingIndicator,
  Select,
  TextInput,
} from '@/components/ui/primitives';
import { apiRequest, type QueryParams } from '@/features/shared/apiClient';
import { EMPTY_STATES } from '@/features/shared/StatusLabel';
import { KnowledgeCard } from '@/features/shared/KnowledgeCard';
import { useApiQuery } from '@/features/shared/useApiQuery';
import { useSelection } from '@/features/shared/workspace';

const DEBOUNCE_MS = 250;
const PAGE_SIZE = resolvePageSize(null);

const SORT_LABELS: Record<ItemSort, string> = {
  newest: '最新优先',
  oldest: '最早优先',
  importance: '重要度优先',
};

export interface LibraryPageProps {
  onOpen?: (id: string) => void;
  /** Notified whenever the item set changes, e.g. after an edit or delete. */
  refreshToken?: number;
}

/** Additional pages fetched by "load more", kept separate from the first page. */
interface ExtraPage {
  items: ItemDTO[];
  nextCursor: string | null;
}

export function LibraryPage({ onOpen, refreshToken = 0 }: LibraryPageProps) {
  const selection = useSelection();
  const { setVisible, prune } = selection;
  const [query, setQuery] = useState<LibraryQuery>(EMPTY_LIBRARY_QUERY);
  const [searchText, setSearchText] = useState('');
  const [extra, setExtra] = useState<ExtraPage>({ items: [], nextCursor: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  // Debounce the free-text field so typing does not fire a request per keystroke.
  useEffect(() => {
    const handle = setTimeout(() => {
      setQuery((current) => (current.q === searchText ? current : { ...current, q: searchText }));
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchText]);

  const params: QueryParams = useMemo(
    () => ({
      q: query.q.trim().length > 0 ? query.q.trim() : undefined,
      type: query.type ?? undefined,
      status: query.status ?? undefined,
      tagId: query.tagId ?? undefined,
      sort: query.sort,
      limit: PAGE_SIZE,
    }),
    [query],
  );

  const state = useApiQuery<ItemPageResult>('/api/items', {
    query: params,
    version: refreshToken,
  });

  // A new query invalidates every appended page.
  const queryKey = JSON.stringify(params);
  const lastQueryKey = useRef(queryKey);
  useEffect(() => {
    if (lastQueryKey.current !== queryKey) {
      lastQueryKey.current = queryKey;
      setExtra({ items: [], nextCursor: null });
      setMoreError(null);
    }
  }, [queryKey]);

  const tagsState = useApiQuery<{ tags: TagDTO[] }>('/api/tags');
  const tags = tagsState.data?.tags ?? [];

  const firstPage = state.data;
  const items = useMemo(
    () => [...(firstPage?.items ?? []), ...extra.items],
    [firstPage, extra.items],
  );
  // The first page's cursor is superseded once extra pages load.
  const nextCursor = extra.nextCursor ?? firstPage?.nextCursor ?? null;

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await apiRequest<ItemPageResult>('/api/items', {
        query: { ...params, cursor: nextCursor },
      });
      setExtra((current) => ({
        items: [...current.items, ...page.items],
        nextCursor: page.nextCursor,
      }));
    } catch (error) {
      // Keep what is already displayed; report the failed page specifically.
      setMoreError(error instanceof Error ? error.message : '加载下一页失败');
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, params]);

  const resetFilters = useCallback(() => {
    setSearchText('');
    setQuery(EMPTY_LIBRARY_QUERY);
  }, []);

  /**
   * Report the ids the current filter renders, and reconcile the selection with
   * the server.
   *
   * Both halves must happen together: `setVisible` lets the tray explain which
   * selected items are off-screen, and `prune` drops ids the server no longer
   * has. Reconciling runs on every successful page read (including the refresh
   * after a delete), so a note removed in another window never stays selected
   * silently (T021-R04).
   */
  useEffect(() => {
    if (state.loading) return;
    const page = state.data;
    if (!page) return;
    const ids = page.items.map((item) => item.id);
    if (page.nextCursor === null) {
      // Every matching row is loaded: the visible set is the whole result, so
      // "hidden" and "deleted" can both be stated as facts.
      setVisible(ids);
      prune(ids);
    } else {
      // A partial result cannot prove an item is hidden or gone; claiming either
      // would be a guess, so the tray is told nothing until the set is complete.
      setVisible(null);
    }
  }, [prune, setVisible, state.data, state.loading]);

  const filtersActive = activeFilterCount(query) > 0 || searchText.length > 0;

  return (
    <>
      <PageHeader
        title="资料库"
        description="按关键字、类型、状态和标签检索已保存的记录。搜索是字面匹配，不会自动理解同义表达。"
      />

      <section
        className="flex flex-col gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4"
        aria-label="搜索与筛选"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="关键字" htmlFor="library-q" hint="匹配原文、标题、摘要和标签名">
            <TextInput
              id="library-q"
              data-testid="library-search"
              type="search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="例如：注意力"
            />
          </Field>
          <Field label="类型" htmlFor="library-type">
            <Select
              id="library-type"
              data-testid="library-type"
              value={query.type ?? ''}
              onChange={(event) =>
                setQuery((current) => ({
                  ...current,
                  type: (event.target.value || null) as LibraryQuery['type'],
                }))
              }
            >
              <option value="">全部类型</option>
              {ITEM_TYPES.map((value) => (
                <option key={value} value={value}>
                  {ITEM_TYPE_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="状态" htmlFor="library-status">
            <Select
              id="library-status"
              data-testid="library-status"
              value={query.status ?? ''}
              onChange={(event) =>
                setQuery((current) => ({
                  ...current,
                  status: (event.target.value || null) as LibraryQuery['status'],
                }))
              }
            >
              <option value="">全部状态</option>
              {ITEM_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {ITEM_STATUS_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="标签" htmlFor="library-tag">
            <Select
              id="library-tag"
              data-testid="library-tag"
              value={query.tagId ?? ''}
              onChange={(event) =>
                setQuery((current) => ({ ...current, tagId: event.target.value || null }))
              }
            >
              <option value="">全部标签</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor="library-sort" className="text-sm text-[var(--ink-muted)]">
              排序
            </label>
            <Select
              id="library-sort"
              data-testid="library-sort"
              className="w-auto"
              value={query.sort}
              onChange={(event) =>
                setQuery((current) => ({ ...current, sort: event.target.value as ItemSort }))
              }
            >
              {(Object.keys(SORT_LABELS) as ItemSort[]).map((value) => (
                <option key={value} value={value}>
                  {SORT_LABELS[value]}
                </option>
              ))}
            </Select>
          </div>
          {filtersActive ? (
            <Button variant="ghost" data-testid="library-reset" onClick={resetFilters}>
              清除筛选
            </Button>
          ) : null}
        </div>
      </section>

      {state.error ? (
        <InlineError message={state.error.message}>
          <Button variant="secondary" onClick={state.reload}>
            重新搜索
          </Button>
        </InlineError>
      ) : null}

      {state.loading && items.length === 0 && !state.error ? (
        <LoadingIndicator label="正在搜索" />
      ) : null}

      {!state.loading && !state.error && items.length === 0 ? (
        <EmptyState
          title={query.q.trim().length > 0 ? '没有匹配的记录' : '资料库还是空的'}
          description={query.q.trim().length > 0 ? EMPTY_STATES.noMatches : EMPTY_STATES.noItems}
        />
      ) : null}

      {items.length > 0 ? (
        <section className="flex flex-col gap-3" aria-label="检索结果">
          <p className="text-xs text-[var(--ink-muted)]" data-testid="library-count">
            共 {firstPage?.totalMatched ?? items.length} 条匹配，已显示 {items.length} 条
          </p>
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
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
          {moreError ? (
            <InlineError message={moreError}>
              <Button variant="secondary" onClick={() => void loadMore()}>
                重试这一页
              </Button>
            </InlineError>
          ) : null}
          {nextCursor ? (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                data-testid="library-load-more"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? '加载中…' : '加载更多'}
              </Button>
            </div>
          ) : (
            <p className="text-center text-xs text-[var(--ink-muted)]">已经到底了</p>
          )}
        </section>
      ) : null}
    </>
  );
}
