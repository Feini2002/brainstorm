'use client';

/**
 * Shared async read hook.
 *
 * Two problems recur on every page that loads from the API, and both are
 * correctness issues rather than style:
 *
 *  1. A slow earlier response must never overwrite a newer one. Each load takes
 *     a sequence number and only the newest one may commit its result.
 *  2. State is only written from the async continuation, never synchronously in
 *     the effect body — that keeps renders from cascading (the React compiler
 *     lint rule flags the synchronous form).
 *
 * `reload` re-runs the same read; callers expose it as an explicit "retry"
 * action. Nothing here retries on its own: a failed request stays failed until
 * the user asks again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiClientError, apiRequest, type RequestOptions } from './apiClient';

export interface ApiQueryState<T> {
  data: T | null;
  error: ApiClientError | null;
  /** True until the first successful or failed load completes. */
  loading: boolean;
  /** True while a `reload` is in flight; the previous data stays visible. */
  refreshing: boolean;
  reload: () => void;
  /** Replace the local copy after a local mutation, without a round trip. */
  setData: (updater: T | ((current: T | null) => T | null)) => void;
}

export interface ApiQueryOptions {
  method?: RequestOptions['method'];
  query?: RequestOptions['query'];
  body?: unknown;
  /** Skip the request entirely (e.g. the id is not known yet). */
  enabled?: boolean;
  /**
   * Extra dependency that refetches when it changes, without being sent to the
   * server. Used when a parent knows its data changed (e.g. a new capture) but
   * the request itself is identical.
   */
  version?: number;
}

export function useApiQuery<T>(
  path: string,
  options: ApiQueryOptions = {},
): ApiQueryState<T> {
  const enabled = options.enabled !== false;
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  // An initially disabled query is not loading; there is nothing to wait for.
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [token, setToken] = useState(0);

  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The query object is rebuilt on every render by callers, so it is keyed by
  // its serialized form to avoid a fetch loop.
  const queryKey = options.query ? JSON.stringify(options.query) : '';
  const bodyKey = options.body === undefined ? '' : JSON.stringify(options.body);

  useEffect(() => {
    if (!enabled) {
      // Nothing to fetch; release the loading state in the continuation so the
      // effect body never sets state synchronously.
      queueMicrotask(() => setLoading(false));
      return;
    }
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    const isReload = token > 0;

    void (async () => {
      try {
        const result = await apiRequest<T>(path, {
          method: options.method ?? 'GET',
          ...(queryKey.length > 0 ? { query: JSON.parse(queryKey) as RequestOptions['query'] } : {}),
          ...(bodyKey.length > 0 ? { body: JSON.parse(bodyKey) as unknown } : {}),
        });
        if (!mountedRef.current || seq !== seqRef.current) return;
        setDataState(result);
        setError(null);
      } catch (caught) {
        if (!mountedRef.current || seq !== seqRef.current) return;
        setError(
          caught instanceof ApiClientError
            ? caught
            : new ApiClientError({ code: 'INTERNAL', message: '读取失败', retryable: true }),
        );
      } finally {
        if (mountedRef.current && seq === seqRef.current) {
          setLoading(false);
          if (isReload) setRefreshing(false);
        }
      }
    })();
    // `options` is intentionally reduced to its serialized keys; re-running on
    // every render would refetch forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, queryKey, bodyKey, enabled, token, options.version ?? 0]);

  const reload = useCallback(() => {
    setRefreshing(true);
    setError(null);
    setToken((value) => value + 1);
  }, []);

  const setData = useCallback((updater: T | ((current: T | null) => T | null)) => {
    setDataState((current) =>
      typeof updater === 'function' ? (updater as (c: T | null) => T | null)(current) : updater,
    );
  }, []);

  return { data, error, loading, refreshing, reload, setData };
}
