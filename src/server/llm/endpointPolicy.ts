/**
 * Outbound endpoint policy.
 *
 * This is a "user chooses a trusted destination" policy for a local tool, not a
 * full SSRF sandbox: HTTPS only, no embedded credentials, no query/fragment, and
 * no loopback or private-IP literals. The declared limit is that a public
 * hostname may still resolve into a private network; that deeper case is
 * documented rather than falsely claimed as blocked.
 */
import 'server-only';

import { AppError } from '@/domain/errors';
import { LIMITS } from '@/domain/limits';
import { codePointLength } from '@/domain/text';

export const CHAT_COMPLETIONS_PATH = '/chat/completions';

export interface EndpointDecision {
  ok: boolean;
  /** Final endpoint used for the request; only set when ok. */
  endpoint?: string;
  /** Origin of the endpoint, used for key-transfer confirmation. */
  origin?: string;
  reason?: string;
}

const LOOPBACK_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

const PRIVATE_IPV4 = [
  /^0\./u,
  /^10\./u,
  /^127\./u,
  /^169\.254\./u,
  /^172\.(1[6-9]|2\d|3[01])\./u,
  /^192\.168\./u,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u,
  /^198\.1[89]\./u,
];

function isPrivateIpv4(host: string): boolean {
  return PRIVATE_IPV4.some((pattern) => pattern.test(host));
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/gu, '').toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fe80:')) return true;
  if (/^f[cd][0-9a-f]{2}:/u.test(normalized)) return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

/**
 * Validate and normalize a base URL, then append the chat completions path.
 *
 * A trailing `/v1` is preserved (compatible services have their own version
 * paths); a URL that already ends in `/chat/completions` is rejected so the
 * user does not end up with a doubled path.
 */
export function resolveEndpoint(baseUrl: string): EndpointDecision {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: '请填写 Base URL' };
  }
  if (codePointLength(trimmed) > LIMITS.baseUrlCodePoints) {
    return { ok: false, reason: `Base URL 不能超过 ${LIMITS.baseUrlCodePoints} 个字符` };
  }
  if (trimmed.includes('\\')) {
    return { ok: false, reason: 'Base URL 不能包含反斜杠' };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'Base URL 不是合法地址' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'Base URL 必须使用 HTTPS' };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, reason: 'Base URL 不能包含用户名或密码' };
  }
  if (url.search.length > 0) {
    return { ok: false, reason: 'Base URL 不能包含查询参数' };
  }
  if (url.hash.length > 0) {
    return { ok: false, reason: 'Base URL 不能包含片段标识' };
  }

  const host = url.hostname.toLowerCase();
  if (host.length === 0) {
    return { ok: false, reason: 'Base URL 缺少主机名' };
  }
  if (LOOPBACK_NAMES.has(host) || host.endsWith('.localhost')) {
    return { ok: false, reason: '不能使用 localhost，本版本只接受 HTTPS 公网地址' };
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    return { ok: false, reason: '不能使用回环或内网地址' };
  }

  const path = url.pathname.replace(/\/+$/u, '');
  if (path.endsWith(CHAT_COMPLETIONS_PATH)) {
    return {
      ok: false,
      reason: '请填写基础地址，不要包含 /chat/completions 端点路径',
    };
  }

  const endpoint = `${url.origin}${path}${CHAT_COMPLETIONS_PATH}`;
  return { ok: true, endpoint, origin: url.origin };
}

export class EndpointRejectedError extends AppError {
  constructor(message: string) {
    super('ENDPOINT_REJECTED', message);
    this.name = 'EndpointRejectedError';
  }
}

export function requireEndpoint(baseUrl: string): { endpoint: string; origin: string } {
  const decision = resolveEndpoint(baseUrl);
  if (!decision.ok || !decision.endpoint || !decision.origin) {
    throw new EndpointRejectedError(decision.reason ?? 'Base URL 不符合出站要求');
  }
  return { endpoint: decision.endpoint, origin: decision.origin };
}

/**
 * Key-transfer rule: changing the origin while keeping the existing secret
 * requires an explicit confirmation. Path-only changes stay on the same origin
 * and do not need it.
 */
export function requiresKeyTransferConfirmation(
  previousBaseUrl: string,
  nextBaseUrl: string,
): boolean {
  const previous = resolveEndpoint(previousBaseUrl);
  const next = resolveEndpoint(nextBaseUrl);
  if (!previous.ok || !next.ok) return false;
  return previous.origin !== next.origin;
}

/** Host-only display for diagnostics (avoids leaking tenant paths). */
export function displayEndpointHost(baseUrl: string): string {
  const decision = resolveEndpoint(baseUrl);
  if (!decision.ok || !decision.origin) return '(未配置)';
  try {
    return new URL(decision.origin).hostname;
  } catch {
    return '(未配置)';
  }
}
