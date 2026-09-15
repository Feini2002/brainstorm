'use client';

/**
 * Poll the currently active run (T040-R04).
 *
 * This is the *only* place that decides when to re-read a run, and every stop
 * condition exists because polling without one is a resource leak that also
 * produces misleading UI:
 *
 *   - **one run at a time** — the caller passes at most one id (`undefined` when
 *     there is nothing in flight), so a page with ten finished cards makes zero
 *     requests;
 *   - **stops on a terminal state** — `succeeded/failed/interrupted/conflict`
 *     ends the loop, and the final result is read exactly once (T040-C06);
 *   - **pauses while hidden** — a background tab stops issuing requests and
 *     re-reads immediately on return, so the user sees fresh state without
 *     unbounded background traffic (T040-C05);
 *   - **cleans up on unmount** — no timer survives navigation.
 *
 * The interval is the contract's 1500 ms, read from `LIMITS` rather than typed as
 * a literal so it cannot drift from the documented value.
 *
 * The hook never starts work. It reads `GET /api/runs/:id`, which by contract does
 * not call a model (T040-R05); retrying is a separate, explicit user action with a
 * fresh request key.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { LIMITS } from '@/domain/limits';
import { isTerminalRunState } from '@/domain/run';
import type { RunDTO } from '@/domain/knowledge';
import { ApiClientError, apiRequest } from './apiClient';

export interface RunStatusState {
  run: RunDTO | null;
  error: ApiClientError | null;
  /** True while `runId` is set and no terminal state has been reached. */
  polling: boolean;
  /** Re-read immediately; used by the manual refresh button. */
  refresh: () => void;
}

export interface RunStatusOptions {
  /** `null`/`undefined` means nothing is in flight: no request is made. */
  runId: string | null | undefined;
  /** Called once when the run first reaches a terminal state. */
  onSettled?: (run: RunDTO) => void;
  /** Disable polling entirely, e.g. while the caller is showing a form. */
  enabled?: boolean;
}

export function useRunStatus(options: RunStatusOptions): RunStatusState {
  const enabled = options.enabled !== false;
  const runId = options.runId ?? null;

  const [run, setRun] = useState<RunDTO | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [tick, setTick] = useState(0);

  /**
   * `onSettled` lives in a ref so a caller that rebuilds the callback on every
   * render cannot restart the polling effect and reset its interval endlessly.
   */
  const onSettledRef = useRef(options.onSettled);
  useEffect(() => {
    onSettledRef.current = options.onSettled;
  }, [options.onSettled]);

  /** Guards against calling `onSettled` twice for the same terminal run. */
  const settledRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || runId === null) {
      // Nothing to watch. Clearing here is correct: a stale run from a previous
      // id must not be shown as if it belonged to the new one.
      settledRef.current = null;
      queueMicrotask(() => {
        setRun(null);
        setError(null);
      });
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (): void => {
      if (cancelled) return;
      timer = setTimeout(() => {
        void read();
      }, LIMITS.activeRunPollMs);
    };

    const read = async (): Promise<void> => {
      if (cancelled) return;
      // A hidden tab stops issuing requests. `visibilitychange` below re-reads on
      // return, so nothing is missed — this only removes the idle traffic.
      if (typeof document !== 'undefined' && document.hidden) {
        schedule();
        return;
      }

      try {
        const next = await apiRequest<RunDTO>(`/api/runs/${runId}`);
        if (cancelled) return;
        setRun(next);
        setError(null);

        if (isTerminalRunState(next.state)) {
          // Terminal: stop scheduling and report the outcome exactly once.
          if (settledRef.current !== next.id) {
            settledRef.current = next.id;
            onSettledRef.current?.(next);
          }
          return;
        }
      } catch (caught) {
        if (cancelled) return;
        setError(
          caught instanceof ApiClientError
            ? caught
            : new ApiClientError({ code: 'INTERNAL', message: '读取运行状态失败', retryable: true }),
        );
        // A transient read failure must not permanently stop the loop; the run
        // itself is still whatever the server says it is.
      }
      schedule();
    };

    const onVisibility = (): void => {
      if (!document.hidden) void read();
    };

    void read();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // `onSettled` is intentionally excluded: it is read through a ref so a new
    // callback identity does not restart polling.
  }, [runId, enabled, tick]);

  const refresh = useCallback(() => {
    settledRef.current = null;
    setTick((value) => value + 1);
  }, []);

  const polling =
    enabled && runId !== null && (run === null || !isTerminalRunState(run.state));

  return { run, error, polling, refresh };
}
