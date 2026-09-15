'use client';

/**
 * Same-origin API client (T006-R03).
 *
 * One place handles the session token, the envelope, network failures, invalid
 * JSON and non-JSON responses, so no page copies fetch logic. It never retries a
 * request on its own: an explicit caller-provided idempotency key plus user
 * action is required to replay anything (T006-R05).
 */
import type { ApiEnvelope } from '@/domain/api';
import type { SafeError } from '@/domain/errors';
import { LIMITS } from '@/domain/limits';
import { loadSession, resetSession } from './session';

/**
 * Re-exported unchanged so every existing caller keeps importing the session
 * from `apiClient`; the bootstrap itself now lives in `session.ts` (T007-R02),
 * because the contract names that file as the owner of the session singleton.
 */
export { loadSession, resetSession };

export class ApiClientError extends Error {
  readonly code: SafeError['code'];
  readonly retryable: boolean;
  readonly fieldErrors?: Record<string, string[]>;
  readonly requestId: string | null;
  readonly httpStatus: number | null;

  constructor(
    error: SafeError,
    options: { requestId?: string | null; httpStatus?: number | null } = {},
  ) {
    super(error.message);
    this.name = 'ApiClientError';
    this.code = error.code;
    this.retryable = error.retryable;
    if (error.fieldErrors) this.fieldErrors = error.fieldErrors;
    this.requestId = options.requestId ?? null;
    this.httpStatus = options.httpStatus ?? null;
  }
}

const NETWORK_ERROR: SafeError = {
  code: 'PROVIDER_NETWORK',
  message: '本地服务没有响应，请确认应用仍在运行',
  retryable: true,
};

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Skip token acquisition (only /api/health and /api/session may). */
  anonymous?: boolean;
  /** Abort a long-running read when the user navigates away. */
  signal?: AbortSignal;
}
export type QueryParams = NonNullable<RequestOptions['query']>;

function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix.length > 0 ? `${path}?${suffix}` : path;
}

/**
 * Perform a request and unwrap the envelope. Throws `ApiClientError` for every
 * failure mode so callers branch on `error.code`.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return (await apiRequestFull<T>(path, options)).data;
}

/**
 * Same call, but also reports the HTTP status.
 *
 * One place needs it: creating a manual relation answers 201 when a new edge was
 * written and 200 when an existing AI suggestion was upgraded in place. The
 * status *is* the answer to "was this new?", so it cannot be inferred from the
 * response body afterwards.
 */
export async function apiRequestFull<T>(
  path: string,
  options: RequestOptions = {},
): Promise<{ data: T; status: number }> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (!options.anonymous) {
    const session = await loadSession();
    headers[LIMITS.tokenRequestHeader] = session.token;
  }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      cache: 'no-store',
      credentials: 'same-origin',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiClientError(NETWORK_ERROR);
  }

  if (response.status === 403) {
    // The process token rotated (server restart). Drop the cache so the next
    // call re-bootstraps, but never replay a paid generation automatically.
    const failure = await readFailure(response);
    if (failure.error.code === 'SESSION_EXPIRED') resetSession();
    throw new ApiClientError(failure.error, {
      requestId: failure.requestId,
      httpStatus: response.status,
    });
  }

  const data = await parseEnvelope<T>(response);
  return { data, status: response.status };
}

async function readFailure(response: Response): Promise<{ error: SafeError; requestId: string }> {
  try {
    const body = (await response.json()) as ApiEnvelope<unknown>;
    if (body && typeof body === 'object' && body.ok === false) {
      return { error: body.error, requestId: body.requestId };
    }
  } catch {
    // Fall through to the generic mapping below.
  }
  return {
    error: {
      code: 'INTERNAL',
      message: `本地服务返回了无法识别的响应（HTTP ${response.status}）`,
      retryable: false,
    },
    requestId: response.headers.get('x-request-id') ?? '',
  };
}

async function parseEnvelope<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    const failure = await readFailure(response);
    throw new ApiClientError(
      {
        code: 'INTERNAL',
        message: `本地服务返回了非 JSON 响应（HTTP ${response.status}）`,
        retryable: false,
      },
      { requestId: failure.requestId, httpStatus: response.status },
    );
  }

  let body: ApiEnvelope<T>;
  try {
    body = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new ApiClientError(
      { code: 'INTERNAL', message: '本地服务返回了无效 JSON', retryable: false },
      { httpStatus: response.status },
    );
  }

  if (body.ok === true) return body.data;
  throw new ApiClientError(body.error, { requestId: body.requestId, httpStatus: response.status });
}

/**
 * Download an attachment with the session token attached.
 *
 * The filename comes from the server's `Content-Disposition`, not from a name the
 * client rebuilds. The naming rule (view id + safe date, never a raw title) lives
 * in `domain/viewExport.ts` and is applied once, on the side that knows the view;
 * a second implementation here would drift and could start feeding a title into a
 * path (T060-R03).
 *
 * `Content-Disposition` is advisory from the browser's point of view, but it is
 * read here as data rather than trusted as a path: the value is only ever assigned
 * to `anchor.download`, which the browser sanitizes.
 */
export async function apiDownload(
  path: string,
  query?: RequestOptions['query'],
): Promise<{ blob: Blob; filename: string | null }> {
  const session = await loadSession();
  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/octet-stream, application/json',
        [LIMITS.tokenRequestHeader]: session.token,
      },
    });
  } catch {
    throw new ApiClientError(NETWORK_ERROR);
  }
  if (!response.ok) {
    // A failure is the normal JSON envelope. Surfacing it as an `ApiClientError`
    // is what keeps a failed export from being saved as a file that looks like a
    // successful one (docs/03_contracts/10_backup_bundle.md §2).
    const failure = await readFailure(response);
    throw new ApiClientError(failure.error, {
      requestId: failure.requestId,
      httpStatus: response.status,
    });
  }
  return { blob: await response.blob(), filename: filenameFromDisposition(response) };
}

/** Pull the quoted or bare filename out of a `Content-Disposition` header. */
function filenameFromDisposition(response: Response): string | null {
  const header = response.headers.get('content-disposition');
  if (!header) return null;
  const quoted = /filename="([^"]+)"/iu.exec(header);
  if (quoted?.[1]) return quoted[1];
  const bare = /filename=([^;]+)/iu.exec(header);
  return bare?.[1]?.trim() ?? null;
}

/** Create a temporary object URL for a downloaded file and click it once. */
export function saveBlobAs(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
