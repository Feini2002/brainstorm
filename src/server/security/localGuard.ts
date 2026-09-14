/**
 * Local request protection.
 *
 * The threat model is a malicious web page in the user's own browser reaching
 * http://127.0.0.1:3000. Protection is therefore: an explicit loopback bind,
 * an exact Origin/Host match, no CORS, and a per-process random token that only
 * same-origin pages can read. It is not authentication against a hostile local
 * process, and is never intended for LAN or public exposure.
 */
import 'server-only';

import { randomBytes, timingSafeEqual } from 'node:crypto';

import { LIMITS } from '@/domain/limits';

export const APP_ORIGIN = process.env.APP_ORIGIN ?? `http://127.0.0.1:${LIMITS.appPort}`;
export const APP_HOST = process.env.APP_HOST ?? LIMITS.host;

/** 32 cryptographically random bytes, regenerated per process start. */
const sessionToken = randomBytes(LIMITS.tokenBytes).toString('base64url');
const sessionId = randomBytes(8).toString('hex');

export function getSessionToken(): string {
  return sessionToken;
}

export function getSessionId(): string {
  return sessionId;
}

export function isSessionToken(value: string): boolean {
  if (value.length !== sessionToken.length) return false;
  const provided = Buffer.from(value, 'utf8');
  const expected = Buffer.from(sessionToken, 'utf8');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export interface RequestFacts {
  method: string;
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
  contentType: string | null;
  token: string | null;
}

export type GuardFailure = 'host' | 'origin' | 'cross_site' | 'token' | 'content_type';

export interface GuardResult {
  ok: boolean;
  failure?: GuardFailure;
}

export function expectedHost(): string {
  const url = new URL(APP_ORIGIN);
  return url.host;
}

/**
 * Host check. X-Forwarded-Host is deliberately ignored: proxy deployments are
 * out of scope for this version.
 */
export function checkHost(host: string | null): boolean {
  if (!host) return false;
  return host === expectedHost();
}

/** Exact origin match; a missing Origin is allowed for non-browser callers. */
export function checkOrigin(origin: string | null): boolean {
  if (origin === null) return true;
  return origin === APP_ORIGIN;
}

/** Reject explicit cross-site browser requests. */
export function checkSecFetchSite(secFetchSite: string | null): boolean {
  if (secFetchSite === null) return true;
  return secFetchSite === 'same-origin' || secFetchSite === 'none';
}

export function checkContentType(method: string, contentType: string | null): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'DELETE') return true;
  if (contentType === null) return false;
  return contentType.toLowerCase().startsWith('application/json');
}

/** Guard for the read-only bootstrap endpoints (health, session). */
export function guardBootstrap(facts: RequestFacts): GuardResult {
  if (!checkHost(facts.host)) return { ok: false, failure: 'host' };
  if (!checkOrigin(facts.origin)) return { ok: false, failure: 'origin' };
  if (!checkSecFetchSite(facts.secFetchSite)) return { ok: false, failure: 'cross_site' };
  return { ok: true };
}

/** Guard for every private read. */
export function guardRead(facts: RequestFacts): GuardResult {
  const base = guardBootstrap(facts);
  if (!base.ok) return base;
  if (facts.token === null || !isSessionToken(facts.token)) {
    return { ok: false, failure: 'token' };
  }
  return { ok: true };
}

/** Guard for mutations: everything a read needs plus origin and JSON body. */
export function guardMutation(facts: RequestFacts): GuardResult {
  const read = guardRead(facts);
  if (!read.ok) return read;
  if (facts.origin === null || facts.origin !== APP_ORIGIN) {
    return { ok: false, failure: 'origin' };
  }
  if (facts.secFetchSite !== null && !checkSecFetchSite(facts.secFetchSite)) {
    return { ok: false, failure: 'cross_site' };
  }
  if (!checkContentType(facts.method, facts.contentType)) {
    return { ok: false, failure: 'content_type' };
  }
  return { ok: true };
}

/** Map a guard failure to the contract error code the client branches on. */
export function guardFailureCode(failure: GuardFailure): 'LOCAL_ORIGIN_REJECTED' | 'SESSION_EXPIRED' {
  if (failure === 'token') return 'SESSION_EXPIRED';
  return 'LOCAL_ORIGIN_REJECTED';
}

/** Response headers reused by every API route. */
export function noStoreHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}
