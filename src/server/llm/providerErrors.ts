/**
 * Provider error classification.
 *
 * HTTP status and transport failures are mapped onto contract error codes. No
 * provider response body is ever forwarded to the browser or written to logs:
 * only a bounded, redacted summary the user can act on.
 */
import { AppError, type ErrorCode } from '@/domain/errors';
import { redactSecrets } from '@/server/observability/redaction';

/**
 * Raised when a provider rejects the `response_format` parameter itself.
 * Lives here rather than in the adapter so `classifyHttpStatus` can raise it
 * without a circular import.
 */
export class StructuredModeRejectedError extends AppError {
  constructor(message: string) {
    super('PROVIDER_PROTOCOL', message);
    this.name = 'StructuredModeRejectedError';
  }
}

export interface ProviderErrorContext {
  /** Provider-supplied Retry-After, validated before display. */
  retryAfterSeconds?: number;
  /** Short, redacted provider hint (never the full body, never headers). */
  providerHint?: string;
  /**
   * Which JSON mode this request used. A 400 that names `response_format` is
   * almost always "this service does not implement that parameter", and the
   * user has to change the setting themselves: retrying in the other mode would
   * be a silent second paid request (T031-R02).
   */
  structuredMode?: 'prompt_json' | 'json_object';
}

/**
 * Does the provider hint read like a complaint about `response_format`?
 *
 * Matching is deliberately narrow — the parameter name (with or without
 * underscore) or the OpenAI help text about it. A generic 400 stays a generic
 * protocol error, because guessing would send users to the wrong setting.
 */
export function looksLikeUnsupportedJsonMode(hint: string): boolean {
  return /response[_ ]?format|json[_ ]?object/iu.test(hint);
}

export function classifyHttpStatus(status: number, context: ProviderErrorContext = {}): AppError {
  const hint = sanitizeHint(context.providerHint);
  const suffix = hint ? `（服务商提示：${hint}）` : '';

  if (status === 400 && context.structuredMode === 'json_object' && looksLikeUnsupportedJsonMode(hint)) {
    return new StructuredModeRejectedError(
      '服务商不接受 response_format 参数。请把「结构化输出方式」改为在提示词中要求 JSON，然后重试；' +
        `本次不会自动重发。${suffix}`,
    );
  }

  if (status === 401 || status === 403) {
    return new AppError('PROVIDER_AUTH', `服务商拒绝凭据，请检查 API Key 权限和模型访问${suffix}`);
  }
  if (status === 404) {
    return new AppError('PROVIDER_ENDPOINT', `地址或模型接口不匹配${suffix}`);
  }
  if (status === 408 || status === 504) {
    return new AppError('PROVIDER_TIMEOUT', `服务商请求超时${suffix}`);
  }
  if (status === 429) {
    const retry =
      context.retryAfterSeconds !== undefined
        ? `，建议 ${context.retryAfterSeconds} 秒后显式重试`
        : '';
    return new AppError('PROVIDER_RATE_LIMIT', `服务商限流${retry}${suffix}`);
  }
  if (status >= 500) {
    return new AppError('PROVIDER_UNAVAILABLE', `服务商暂时不可用（HTTP ${status}）${suffix}`);
  }
  if (status === 400) {
    return new AppError('PROVIDER_PROTOCOL', `服务商拒绝了请求参数${suffix}`);
  }
  return new AppError('PROVIDER_PROTOCOL', `服务商返回了未预期的状态码 ${status}${suffix}`);
}

/**
 * Keep at most a short, single-line hint. Provider bodies can echo request
 * content or credentials, so this is bounded and control characters removed.
 *
 * Secret removal is *not* re-implemented here. The rules live in
 * `observability/redaction.ts` and only there: the `Bearer`/`sk-` table this
 * function used to carry was a second, narrower rule set that missed every
 * other credential shape (an Azure or self-hosted gateway key, a Gemini
 * `AIzaSy…` key) and never consulted the registered live secrets — so a
 * provider echoing one of those survived this path while `redactSecrets` would
 * have removed it (T030-C02).
 */
export function sanitizeHint(value: string | undefined): string {
  if (!value) return '';
  const singleLine = value.replace(/[\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  const withoutSecrets = redactSecrets(singleLine);
  return withoutSecrets.length > 200 ? `${withoutSecrets.slice(0, 200)}…` : withoutSecrets;
}

/** Read a validated Retry-After header; malformed values are ignored. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600) return seconds;
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const delta = Math.round((date - Date.now()) / 1000);
    if (delta >= 0 && delta <= 3600) return delta;
  }
  return undefined;
}

/** Map an outbound transport exception (pre-response) to a safe code. */
export function classifyTransportError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';

  if (name === 'AbortError' || /aborted|timed? ?out/iu.test(message)) {
    return new AppError('PROVIDER_TIMEOUT', '等待服务商响应超时，本次请求可能已到达服务商');
  }
  if (/redirect/iu.test(message)) {
    return new AppError('PROVIDER_ENDPOINT', '服务商返回了重定向，已按安全设置拒绝跟随');
  }
  return new AppError('PROVIDER_NETWORK', '无法连接服务商，本次请求可能已到达服务商');
}

/** True for codes that mean "the request may have been billed". */
export function mayHaveBeenBilled(code: ErrorCode): boolean {
  return code === 'PROVIDER_NETWORK' || code === 'PROVIDER_TIMEOUT';
}
