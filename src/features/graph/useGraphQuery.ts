'use client';

/**
 * Graph read hook (T048).
 *
 * Two problems the plain `useApiQuery` does not solve for a graph:
 *
 *  1. **Filter changes race.** Clicking three filters quickly issues three POSTs;
 *     if the first is slowest it must not win. Every read takes a sequence number
 *     and only the newest may commit, so the canvas cannot flicker back to an
 *     older subgraph (T048-R05).
 *  2. **A filter change must not delete anything.** This hook only ever sends a
 *     read body. Raising `minimumScore` narrows what is *shown*; the server's
 *     relation rows are untouched (T048-R01).
 *
 * The previous result stays on screen while a new one is in flight (`refreshing`),
 * so a threshold change does not blank the canvas the user is reading.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { GraphReadResponse } from '@/domain/graph';
import type { GraphFilter } from '@/domain/knowledge';
import { ApiClientError, apiRequest } from '@/features/shared/apiClient';

export interface GraphQueryResult {
  data: GraphReadResponse | null;
  error: ApiClientError | null;
  loading: boolean;
  refreshing: boolean;
  reload: () => void;
  /** Bumped whenever a committed response lands, for effects that follow a read. */
  revisionOfQuery: number;
}

export interface UseGraphQueryInput {
  filter: GraphFilter;
  itemIds?: readonly string[];
  /** Skip the request entirely (e.g. no view is open yet). */
  enabled?: boolean;
}

/** Stable key so an equal-but-new object literal does not refetch. */
function filterKey(filter: GraphFilter, itemIds?: readonly string[]): string {
  const parts = [
    filter.tagId ?? '-',
    filter.type ?? '-',
    (filter.reviewStatuses ?? []).slice().sort().join('+') || '-',
    filter.minimumScore === undefined ? '-' : filter.minimumScore.toFixed(3),
    filter.includeStale === true ? 'stale' : 'fresh',
    itemIds ? itemIds.slice().sort().join(',') : '-',
  ];
  return parts.join('|');
}

export function useGraphQuery(input: UseGraphQueryInput): GraphQueryResult {
  const enabled = input.enabled !== false;
  const key = filterKey(input.filter, input.itemIds);
  const [data, setData] = useState<GraphReadResponse | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [committed, setCommitted] = useState(0);
  const [token, setToken] = useState(0);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      queueMicrotask(() => setLoading(false));
      return;
    }
    const seq = seqRef.current + 1;
    seqRef.current = seq;

    // The body is rebuilt from the current filter inside the effect so the
    // request always matches the key it was scheduled for.
    const body: Record<string, unknown> = { filter: input.filter };
    if (input.itemIds) body.itemIds = [...input.itemIds];

    void (async () => {
      // `refreshing` is set in the async continuation rather than synchronously
      // in the effect body: a request always settles in a later microtask, so the
      // state change never cascades into another render pass of this effect.
      setRefreshing(true);
      try {
        const result = await apiRequest<GraphReadResponse>('/api/graph', {
          method: 'POST',
          body,
        });
        // A stale response is dropped, not merged: mixing two subgraphs would
        // show edges whose endpoints came from different reads (T048-R05).
        if (!mountedRef.current || seq !== seqRef.current) return;
        setData(result);
        setError(null);
        setCommitted((value) => value + 1);
      } catch (caught) {
        if (!mountedRef.current || seq !== seqRef.current) return;
        setError(
          caught instanceof ApiClientError
            ? caught
            : new ApiClientError({ code: 'INTERNAL', message: '读取关系图失败', retryable: true }),
        );
      } finally {
        if (mountedRef.current && seq === seqRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();
    // The filter is keyed by its serialized form; re-running per render would
    // refetch forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, token]);

  const reload = useCallback(() => {
    setError(null);
    setToken((value) => value + 1);
  }, []);

  return { data, error, loading, refreshing, reload, revisionOfQuery: committed };
}
