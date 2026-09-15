/**
 * Redaction and safe logging (T030).
 *
 * This module is the *only* filter, and it is double-layered on purpose, because
 * the two layers fail differently:
 *
 *   1. **Structural** — a log record is an allow-listed shape, so a caller cannot
 *      log a `Headers` object, a request body or a provider `Response` even by
 *      accident. Unknown fields are dropped, not serialised.
 *   2. **Value** — free-form text is scanned for the *literal current secret* and
 *      for credential-shaped substrings. Field-name filtering alone misses the
 *      case T030-C02 is about: a provider that echoes the key back inside its
 *      error message.
 *
 * Layer 2 is what makes `registerSecret` necessary. Redaction patterns cannot
 * recognise an arbitrary plaintext key, so anything that knows a live secret
 * registers it here for the process lifetime; nothing else can learn it.
 */
import 'server-only';

export const REDACTED = '[redacted]';

/** Hard cap for any user-visible provider text (T030-R03). */
export const PROVIDER_MESSAGE_LIMIT = 300;

/* -------------------------------------------------------------------------- */
/* Layer 2: literal live secrets                                              */
/* -------------------------------------------------------------------------- */

/**
 * Live secret values, held for the process lifetime.
 *
 * Deliberately a module-level set with no getter: the point is that values go in
 * and are never handed back out. Entries are kept even across a settings change
 * so a late provider response mentioning the *previous* key is still redacted.
 */
const liveSecrets = new Set<string>();

/** Shortest value worth tracking; below this a match is more likely noise. */
const MIN_SECRET_LENGTH = 8;

export function registerSecret(value: string): void {
  if (value.length >= MIN_SECRET_LENGTH) liveSecrets.add(value);
}

/** Test/maintenance hook. Never called by request paths. */
export function clearRegisteredSecrets(): void {
  liveSecrets.clear();
}

/* -------------------------------------------------------------------------- */
/* Layer 2: credential-shaped substrings                                      */
/* -------------------------------------------------------------------------- */

const SECRET_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]+/giu, replacement: `Bearer ${REDACTED}` },
  // `sk-...`, `sk-proj-...`, and the common `key-...`/`token-...` families.
  { pattern: /\b(?:sk|rk|pk|key|token)-[A-Za-z0-9._-]{6,}\b/gu, replacement: REDACTED },
  // `Authorization: ...`, `api_key=...`, `"apiKey": "..."`.
  {
    pattern:
      /\b(authorization|api[_-]?key|apikey|access[_-]?token|client[_-]?secret|bearer)\b\s*[:=]\s*["']?[^"',\s}]{4,}/giu,
    replacement: `$1=${REDACTED}`,
  },
];

/**
 * Remove credentials from free-form text.
 *
 * Order matters: the literal values go first, because a key that happens to look
 * like ordinary text must still be removed even though no pattern would match it.
 */
export function redactSecrets(input: string): string {
  let output = input;
  for (const secret of liveSecrets) {
    if (secret.length > 0) output = output.split(secret).join(REDACTED);
  }
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

/**
 * Sensitive *field names*. Used when a structure (not a string) has to be walked,
 * e.g. an error object handed to us from a provider SDK.
 */
const SENSITIVE_FIELD = /^(authorization|api[-_]?key|apikey|key|token|secret|password|credential)s?$/iu;

/**
 * Recursively copy a structure with sensitive fields dropped and every remaining
 * string redacted (T030-R02).
 *
 * Depth is bounded: a cyclic or pathologically nested object must not turn error
 * handling into a hang, and the redacted result is only ever destined for a log
 * line.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redactValue(entry, depth + 1));
  if (value instanceof Error) {
    // Only the message travels; `stack` is a development-only concern (T030-R04).
    return { name: value.name, message: redactSecrets(value.message) };
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_FIELD.test(key)) {
        output[key] = REDACTED;
        continue;
      }
      output[key] = redactValue(entry, depth + 1);
    }
    return output;
  }
  return '[unsupported]';
}

/** Convenience for assertions and for callers that need a flat string. */
export function redactJson(value: unknown): string {
  try {
    return redactSecrets(JSON.stringify(redactValue(value)));
  } catch {
    return '[unserializable]';
  }
}

/* -------------------------------------------------------------------------- */
/* Provider error text (T030-R03)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Extract a short, safe summary from a provider's error body.
 *
 * The raw body is never logged. A JSON body contributes only its
 * `error.message`/`error.type`/`error.code` (or `message`), each redacted and
 * capped; anything else — HTML error pages, a stack dump, an echo of the user's
 * note — becomes a plain truncated excerpt, still redacted. Both paths are
 * length-limited so an error path cannot become a data-exfiltration channel.
 */
export function summarizeProviderText(
  bodyText: string,
  limit = PROVIDER_MESSAGE_LIMIT,
): string {
  const trimmed = bodyText.trim();
  if (trimmed.length === 0) return '';

  let summary: string | null = null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      summary = extractErrorFields(parsed);
    } catch {
      summary = null;
    }
  }

  const chosen = summary ?? trimmed;
  const collapsed = chosen.replace(/\s+/gu, ' ').trim();
  const safe = redactSecrets(collapsed);
  return safe.length > limit ? `${safe.slice(0, limit)}…` : safe;
}

/** Pull only the documented error fields out of a provider payload. */
function extractErrorFields(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const nested =
    record.error !== null && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>)
      : record;

  const parts: string[] = [];
  for (const key of ['message', 'type', 'code', 'status']) {
    const entry = nested[key];
    if (typeof entry === 'string' && entry.trim().length > 0) parts.push(entry.trim());
    else if (typeof entry === 'number') parts.push(String(entry));
  }
  return parts.length > 0 ? parts.join(' / ') : null;
}

/* -------------------------------------------------------------------------- */
/* Layer 1: structured, allow-listed log records                              */
/* -------------------------------------------------------------------------- */

/**
 * The complete set of loggable fields (T030-R01).
 *
 * There is no `data`, no `payload`, no `body` and no `headers` member, so a
 * caller physically cannot log note text through this API.
 */
export interface SafeLogRecord {
  level?: 'debug' | 'info' | 'warn' | 'error';
  /** Stable event name, e.g. `api items.create`. Never interpolated content. */
  message?: string;
  requestId?: string;
  runId?: string;
  stage?: string;
  code?: string;
  kind?: string;
  state?: string;
  retryable?: boolean;
  httpStatus?: number;
  durationMs?: number;
  count?: number;
  /** Content hashes are fine; bodies are not. */
  hash?: string;
  /** Provider summary already passed through `summarizeProviderText`. */
  errorSummary?: string;
}

export interface LogSink {
  (record: SafeLogRecord, line: string): void;
}

let sink: LogSink | null = null;

/** Redirect log output. Tests use this to scan everything that was emitted. */
export function setLogSink(next: LogSink | null): void {
  sink = next;
}

function defaultSink(record: SafeLogRecord, line: string): void {
  if (record.level === 'error') console.error(line);
  else if (record.level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * Emit one structured line.
 *
 * Both the line *and* the record handed to the sink are redacted. Passing the
 * caller's original object through would make the sink a leak: a future sink
 * that writes to a file or an error reporter would receive the raw provider text
 * that `redactSecrets` had only removed from the formatted string.
 */
export function logSafe(record: SafeLogRecord): void {
  const { level = 'info', ...rest } = record;
  const safe: SafeLogRecord = { level };
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    const redacted = redactValue(value);
    (safe as Record<string, unknown>)[key] = redacted;
  }

  const { message, ...fields } = safe;
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`);
  const line = `[brain] ${level}${message ? ` ${message}` : ''}${parts.length ? ` ${parts.join(' ')}` : ''}`;
  (sink ?? defaultSink)(safe, line);
}

/* -------------------------------------------------------------------------- */
/* Diagnostics allow-list (T030-R05/R06)                                      */
/* -------------------------------------------------------------------------- */

/** Environment keys that may appear in a shareable diagnostics summary. */
export const DIAGNOSTIC_ENV_KEYS = [
  'node',
  'platform',
  'arch',
  'appVersion',
  'dataDirKind',
] as const;

export interface DiagnosticsSummaryInput {
  node: string;
  platform: string;
  arch: string;
  appVersion: string;
  /** Whether the default `.data` is used, not the absolute path. */
  dataDirKind: 'default' | 'custom';
  endpointHost: string;
  model: string;
  apiKeyConfigured: boolean;
  recentRuns: { kind: string; state: string; code: string | null; durationMs: number | null }[];
  recentCodes: string[];
}

/**
 * The diagnostics payload is assembled from named fields, never by copying a log
 * file or a settings row. That is what keeps it from becoming "the whole
 * database under a different name" (T030-C06).
 */
export function buildDiagnosticsSummary(input: DiagnosticsSummaryInput): {
  environment: Record<string, string>;
  connection: { endpointHost: string; model: string; apiKeyConfigured: boolean };
  runs: DiagnosticsSummaryInput['recentRuns'];
  errorCodes: string[];
} {
  return {
    environment: {
      node: input.node,
      platform: input.platform,
      arch: input.arch,
      appVersion: input.appVersion,
      dataDirKind: input.dataDirKind,
    },
    connection: {
      endpointHost: input.endpointHost,
      model: input.model,
      apiKeyConfigured: input.apiKeyConfigured,
    },
    runs: input.recentRuns.map((run) => ({
      kind: run.kind,
      state: run.state,
      code: run.code === null ? null : redactSecrets(run.code),
      durationMs: run.durationMs,
    })),
    errorCodes: input.recentCodes.map((code) => redactSecrets(code)),
  };
}

export interface SafeSettingsInput {
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
}

/**
 * Settings summary for diagnostics: host only, so a gateway path carrying a
 * tenant identifier is not disclosed (T030-C04).
 */
export function safeSettingsSummary(input: SafeSettingsInput): {
  endpointHost: string;
  model: string;
  apiKeyConfigured: boolean;
  keyLength: null;
} {
  let host = '(未配置)';
  try {
    if (input.baseUrl.length > 0) host = new URL(input.baseUrl).hostname;
  } catch {
    host = '(未配置)';
  }
  return {
    endpointHost: host,
    model: input.model,
    apiKeyConfigured: input.apiKeyConfigured,
    // Present and always null: an earlier shape exposed a length, which is a
    // fingerprint of the secret. The field stays so callers cannot "re-add" it.
    keyLength: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Secret scanning (test + export guard)                                      */
/* -------------------------------------------------------------------------- */

/** True when the payload contains a live secret or a credential-shaped string. */
export function containsSecret(payload: string): boolean {
  for (const secret of liveSecrets) {
    if (secret.length > 0 && payload.includes(secret)) return true;
  }
  const probe = redactSecrets(payload);
  return probe !== payload;
}

/** Strip absolute paths from a user-visible message (T030-R04). */
export function stripAbsolutePaths(message: string): string {
  return message
    .replace(/[A-Za-z]:\\[^\s"']+/gu, '[path]')
    .replace(/\/(?:Users|home|var|tmp)\/[^\s"']+/gu, '[path]');
}

/* -------------------------------------------------------------------------- */
/* User-facing next steps (T030-R06)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Actionable guidance per provider error code.
 *
 * Each entry names something the user can check. None invents a billing balance
 * or a quota number: the app does not know those, and guessing would be worse
 * than saying less.
 */
export const NEXT_STEP_BY_CODE: Record<string, string> = {
  MODEL_NOT_CONFIGURED: '到设置页填写 Base URL、模型名与 API Key，然后点“测试当前草稿”。',
  EMPTY_MODEL_OUTPUT: '模型这次返回了空内容，可以重试一次；如果反复出现，换一个模型试试。',  PROVIDER_AUTH: '检查 API Key 是否有效、是否仍被服务商接受，或重新填写一次。',
  PROVIDER_ENDPOINT: '检查 Base URL 是否指向正确的 API 根地址，不要包含 /chat/completions。',
  PROVIDER_RATE_LIMIT: '稍后重试；也可以在设置页换用额度更充裕的模型。',
  PROVIDER_UNAVAILABLE: '服务商暂时不可用，稍后重试；本机记录不会丢失。',
  PROVIDER_NETWORK: '检查本机网络能否访问该地址；代理或防火墙可能拦截了出站请求。',
  PROVIDER_TIMEOUT: '本次请求超时，可以重试；如经常发生，换用响应更快的模型。',
  PROVIDER_REFUSAL: '模型拒绝了这次请求，可以调整输入内容后重试。',
  PROVIDER_TRUNCATED: '模型输出被截断，可在设置页提高最多输出 token 数后重试。',
  PROVIDER_PROTOCOL: '服务商返回的内容不是预期格式，确认地址指向的是聊天补全接口。',
  STRUCTURED_INVALID: '模型没有按要求的 JSON 格式返回；可开启“允许一次格式修复”后重试。',
};

export function nextStepFor(code: string): string {
  return NEXT_STEP_BY_CODE[code] ?? '可以重试；如果反复失败，到设置页重新测试连接。';
}
