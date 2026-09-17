/**
 * Outbound transport seam.
 *
 * The adapter talks to a `Transport`, not to global fetch, so tests can inject
 * deterministic behaviour (success, timeout, 401, 429, malformed JSON, late
 * response) and assert request counts — especially that nothing was retried
 * silently. The production implementation is native fetch with redirect
 * disabled.
 *
 * Scripted-file replay for isolated acceptance runs lives in
 * `./testing/scriptedTransport`. Production FetchTransport never scans test
 * files; getTransport only consults that module when BRAIN_SCRIPTED_PROVIDER
 * is set, and the module itself refuses the user's real data directory.
 */
import 'server-only';

import { LIMITS } from '@/domain/limits';
import { AppError } from '@/domain/errors';
import { classifyTransportError } from './providerErrors';
import { scriptedTransportFromEnv } from './testing/scriptedTransport';

export { scriptedProviderPath } from './testing/scriptedTransport';

export interface TransportRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

export interface Transport {
  send(request: TransportRequest): Promise<TransportResponse>;
}

export class ResponseTooLargeError extends AppError {
  constructor(limit: number) {
    super('PROVIDER_PROTOCOL', `服务商响应超过 ${limit} 字节上限`);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * Read a response body with a hard byte cap. Applies to error responses too:
 * unbounded `response.text()` on a failing provider is exactly the hang this
 * guards against.
 */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number = LIMITS.modelResponseBytes,
): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(limit);
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
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

/** Production transport: native fetch, redirects refused, bounded read. */
export class FetchTransport implements Transport {
  async send(request: TransportRequest): Promise<TransportResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    const onExternalAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onExternalAbort);

    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'error',
        signal: controller.signal,
        cache: 'no-store',
      });

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      const bodyText = await readBoundedBody(response.body);
      return { status: response.status, headers, bodyText };
    } catch (error) {
      throw classifyTransportError(error);
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

let defaultTransport: Transport | null = null;

/**
 * Process-wide transport. Replaced in tests via `setTransport`.
 *
 * The scripted file is re-resolved on every call rather than cached. One server
 * process serves the whole acceptance suite, and each case points the variable at
 * its own answer file; caching the first one would make every later case replay
 * case 1's answer. With no variable set this is one environment lookup.
 */
export function getTransport(): Transport {
  const scripted = scriptedTransportFromEnv();
  if (scripted !== null) return scripted;
  if (defaultTransport === null) defaultTransport = new FetchTransport();
  return defaultTransport;
}

export function setTransport(transport: Transport | null): void {
  defaultTransport = transport;
}
