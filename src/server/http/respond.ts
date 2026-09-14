/**
 * HTTP envelope and request reading.
 *
 * Success: {ok:true,data,requestId}. Failure: {ok:false,error:{code,message,
 * retryable,fieldErrors?},requestId}. Bodies are read with a streaming byte
 * counter — Content-Length is only an early hint, never proof.
 */
import 'server-only';

import { randomUUID } from 'node:crypto';

import { AppError, httpStatusForError, toSafeError, type SafeError } from '@/domain/errors';
import { ROUTE_BODY_LIMITS } from '@/domain/limits';

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  requestId: string;
}

export interface ApiFailure {
  ok: false;
  error: SafeError;
  requestId: string;
}

export function requestIdFrom(header: string | null): string {
  return header && header.length > 0 ? header : randomUUID();
}

export function jsonSuccess<T>(data: T, requestId: string, status = 200): Response {
  const body: ApiSuccess<T> = { ok: true, data, requestId };
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

export function jsonFailure(error: unknown, requestId: string): Response {
  const safe = toSafeError(error);
  const status = httpStatusForError(safe.code);
  const body: ApiFailure = { ok: false, error: safe, requestId };
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

export class BodyTooLargeError extends AppError {
  constructor(limit: number) {
    super('BODY_TOO_LARGE', `请求体超过 ${limit} 字节上限`);
    this.name = 'BodyTooLargeError';
  }
}

export type BodyLimitKind = keyof typeof ROUTE_BODY_LIMITS;

/**
 * Read a JSON request body with a hard byte cap.
 *
 * The limit is chosen per route family so the import route cannot force every
 * other route to accept 20 MiB.
 */
export async function readJsonBody(
  request: Request,
  kind: BodyLimitKind = 'default',
): Promise<unknown> {
  const limit = ROUTE_BODY_LIMITS[kind];

  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const declaredBytes = Number.parseInt(declared, 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > limit) {
      throw new BodyTooLargeError(limit);
    }
  }

  if (!request.body) {
    throw new AppError('VALIDATION', '请求体为空');
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        throw new BodyTooLargeError(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder('utf-8', { fatal: false }).decode(merged);
  if (text.trim().length === 0) {
    throw new AppError('VALIDATION', '请求体为空');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError('VALIDATION', '请求体不是合法 JSON');
  }
}

/** Extract request facts used by the local guard. */
export function requestFacts(request: Request): {
  method: string;
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
  contentType: string | null;
  token: string | null;
} {
  return {
    method: request.method,
    host: request.headers.get('host'),
    origin: request.headers.get('origin'),
    secFetchSite: request.headers.get('sec-fetch-site'),
    contentType: request.headers.get('content-type'),
    token: request.headers.get('x-brain-token'),
  };
}
