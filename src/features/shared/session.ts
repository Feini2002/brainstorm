'use client';

/**
 * Browser session bootstrap (T007-R02/R05).
 *
 * The process-scoped token is fetched once per page load from the same-origin
 * `/api/session` endpoint and held **in memory only**: nothing here writes to
 * `localStorage`, `sessionStorage` or a cookie, because the token is not a
 * credential the user owns and a persisted copy would outlive the process that
 * minted it (T007-R02).
 *
 * After a server restart the previous token answers `403 SESSION_EXPIRED`.
 * `apiClient` reacts by calling `resetSession()`, so the next call re-bootstraps
 * instead of replaying a request that may already have been paid for
 * (T007-R05); nothing in this module retries anything on its own.
 *
 * Why this module and `apiClient` reference each other: the *state* (the
 * singleton, its reset, the one in-flight promise) is T007's responsibility,
 * while the envelope reading, the network-failure mapping and the `no-store`
 * fetch stay in `apiClient` so there is exactly one implementation of "how the
 * browser reads one API response" (T006-R03). The pair is safe because neither
 * module touches the other while its own body is evaluated: `loadSession` and
 * `resetSession` are hoisted function declarations, and `apiRequest` is only ever
 * called from an async continuation.
 */
import type { SessionInfo } from '@/domain/api';

import { apiRequest } from './apiClient';

/** In-memory session singleton; a page reload legitimately re-bootstraps it. */
let sessionPromise: Promise<SessionInfo> | null = null;

/**
 * Drop the cached session so the next read re-bootstraps.
 *
 * Called when the server reports `SESSION_EXPIRED` (the process token rotated) —
 * never as a retry: the failed request is surfaced to the caller untouched.
 */
export function resetSession(): void {
  sessionPromise = null;
}

/**
 * Resolve the current session, bootstrapping it once.
 *
 * Concurrent callers share the single in-flight promise, so opening several
 * views at once cannot issue several session requests. A failed bootstrap clears
 * the cache, so the failure is not remembered as if it were an answer.
 */
export function loadSession(): Promise<SessionInfo> {
  if (!sessionPromise) {
    sessionPromise = fetchSession().catch((error: unknown) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

/** Bootstrap read. `anonymous` is required: the session route needs no token. */
function fetchSession(): Promise<SessionInfo> {
  return apiRequest<SessionInfo>('/api/session', { method: 'GET', anonymous: true });
}
