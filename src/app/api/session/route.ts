import { randomUUID } from 'node:crypto';

import type { SessionInfo } from '@/domain/api';
import { AppError } from '@/domain/errors';
import { guardError, logRequestFailure } from '@/server/http/errors';
import { jsonFailure, jsonSuccess, requestFacts, requestIdFrom } from '@/server/http/respond';
import {
  APP_ORIGIN,
  getSessionId,
  getSessionToken,
  guardBootstrap,
  noStoreHeaders,
} from '@/server/security/localGuard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/session — local bootstrap (T007-R02/R04).
 *
 * Host/origin/sec-fetch-site are validated, then the per-process token is
 * returned. No CORS headers are ever sent, so a cross-site page cannot read it.
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = requestIdFrom(request.headers.get('x-request-id'));
  const guard = guardBootstrap(requestFacts(request));
  if (!guard.ok) {
    const error = guardError(guard.failure ?? 'origin');
    logRequestFailure({ requestId, route: 'session', error, safe: error.toSafeError() });
    return jsonFailure(error, requestId);
  }

  const data: SessionInfo = {
    token: getSessionToken(),
    sessionId: getSessionId(),
    origin: APP_ORIGIN,
  };
  const response = jsonSuccess(data, requestId);
  for (const [key, value] of Object.entries(noStoreHeaders())) response.headers.set(key, value);
  return response;
}

/** session is read-only; anything else is a client bug, not a supported action. */
export async function POST(): Promise<Response> {
  return jsonFailure(new AppError('VALIDATION', 'session 只支持 GET'), randomUUID());
}
