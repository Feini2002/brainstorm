/**
 * Redaction helpers for logs, diagnostics and error payloads.
 *
 * The API key must never reach the browser, an export, a log line or an error
 * message. This module is the single filter; tests scan its output for a
 * sentinel secret.
 */
import 'server-only';

export const REDACTED = '[redacted]';

const SECRET_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  { pattern: /Bearer\s+[A-Za-z0-9._\-]+/giu, replacement: `Bearer ${REDACTED}` },
  { pattern: /\bsk-[A-Za-z0-9._\-]{8,}\b/gu, replacement: REDACTED },
  { pattern: /\b(api[_-]?key|apikey|authorization)\b\s*[:=]\s*["']?[^"',\s}]+/giu, replacement: `$1=${REDACTED}` },
];

/** Remove anything resembling a credential from a free-form string. */
export function redactSecrets(input: string): string {
  let output = input;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

/** Structured, allow-listed log record; note text never goes into logs. */
export interface SafeLogRecord {
  level?: 'debug' | 'info' | 'warn' | 'error';
  message?: string;
  requestId?: string;
  runId?: string;
  stage?: string;
  code?: string;
  retryable?: boolean;
  durationMs?: number;
  count?: number;
  hash?: string;
}

export function logSafe(record: SafeLogRecord): void {
  // A deliberately narrow shape: no notes, no prompts, no headers, no bodies.
  const { level = 'info', message, ...rest } = record;
  const parts = Object.entries(rest)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
  const line = `[brain] ${level}${message ? ` ${message}` : ''}${parts.length ? ` ${parts.join(' ')}` : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export interface SafeDiagnosticsInput {
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  apiKeyValue: string | null;
}

/**
 * Build the diagnostics settings summary. Only a host is shown, so tenant paths
 * embedded in a gateway URL are not disclosed.
 */
export function safeSettingsSummary(input: SafeDiagnosticsInput): {
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
    keyLength: null,
  };
}

/** Assert that a serialized payload contains no live secret. Used by tests. */
export function containsSecret(payload: string, secret: string): boolean {
  if (secret.length === 0) return false;
  return payload.includes(secret);
}
