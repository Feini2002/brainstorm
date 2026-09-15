/**
 * Outbound transport seam.
 *
 * The adapter talks to a `Transport`, not to global fetch, so tests can inject
 * deterministic behaviour (success, timeout, 401, 429, malformed JSON, late
 * response) and assert request counts — especially that nothing was retried
 * silently. The production implementation is native fetch with redirect
 * disabled.
 */
import 'server-only';

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { LIMITS } from '@/domain/limits';
import { AppError } from '@/domain/errors';
import { isUserDataDir, resolveDataDir } from '@/server/runtime/dataDir';
import { classifyTransportError } from './providerErrors';

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

/** Absolute path of the scripted-answer file, when this process was started with one. */
export function scriptedProviderPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.BRAIN_SCRIPTED_PROVIDER;
  return value !== undefined && value.trim().length > 0 ? path.resolve(value.trim()) : null;
}

/**
 * A process-level transport that replays fixed answers instead of calling a
 * provider, for the acceptance runs that must drive the *real* route, adapter and
 * transaction while the model answer is a fixed sample.
 *
 * Why this seam exists at all: `endpointPolicy` requires an HTTPS public host, so
 * a browser-driven case has no way to point the real adapter at a loopback stub.
 * The alternative — a test-only route that fabricates a projection — is what
 * T011-C03 rules out, and the alternative used by the per-task specs (injecting a
 * transport object) cannot cross a process boundary. Replacing *only the outbound
 * HTTP step* is exactly the substitution `docs/03_contracts/06_llm_pipeline.md §1`
 * permits; the guard, schema and database transaction all still run for real.
 *
 * The blast radius is deliberately tiny, and every limb of the check must hold:
 *
 *   - the variable must name a file or a directory that exists, and a directory
 *     must contain at least one `*.json` (a missing target is a hard failure
 *     rather than a silent fallback to the network: a run that asked for scripted
 *     answers and quietly got real ones would be an unrequested outbound call),
 *   - the effective data directory must not be the owner's `.data`. This is the
 *     discriminator, not `NODE_ENV`: the acceptance server is a production build,
 *     so `detectRunMode()` reports `USER` for it exactly as for a real run. The
 *     isolated `.data-restart` directory is what actually separates them,
 *   - setting the variable requires write access to this machine's environment, so
 *     it is not reachable through the HTTP surface.
 *
 * A **directory** is accepted because the suite's server is started by Playwright
 * and its environment cannot be changed from a spec. One worker runs the whole
 * suite, so the newest script in the directory is unambiguously the current case's.
 */
function scriptedTransportFromEnv(): Transport | null {
  const target = scriptedProviderPath();
  if (target === null) return null;
  if (isUserDataDir(resolveDataDir())) {
    throw new AppError(
      'INTERNAL',
      'BRAIN_SCRIPTED_PROVIDER 只允许在隔离数据目录的运行中使用，拒绝用户真实数据目录',
    );
  }
  if (!existsSync(target)) {
    throw new AppError('INTERNAL', `BRAIN_SCRIPTED_PROVIDER 指向的路径不存在：${target}`);
  }
  return new ScriptedFileTransport(target);
}

/** The script a request should replay: the target itself, or the directory's newest `*.json`. */
function currentScript(target: string): string {
  if (!statSync(target).isDirectory()) return target;
  const newest = readdirSync(target)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => {
      const file = path.join(target, entry);
      const stats = statSync(file);
      // Name breaks ties: two files written in the same millisecond still order,
      // which keeps the choice deterministic instead of filesystem-dependent.
      return { file, mtime: stats.mtimeMs, name: entry };
    })
    .sort((left, right) => right.mtime - left.mtime || right.name.localeCompare(left.name))[0];
  if (newest === undefined) {
    throw new AppError('INTERNAL', `BRAIN_SCRIPTED_PROVIDER 目录里没有脚本：${target}`);
  }
  return newest.file;
}

/**
 * Replays `replies` from a JSON file, in order, one per outbound request.
 *
 * The file is re-read on every call for two reasons: a case can point several
 * sequential operations at the same path and change the answer between them, and
 * the request index resets whenever the file's content changes. The reset matters
 * because one server process serves the whole acceptance suite — without it, the
 * second case would start at the previous case's last reply. The writer therefore
 * always stamps the script with a per-case token so consecutive cases differ.
 *
 * A request index past the end of the list reuses the last entry, which is what
 * makes a repair attempt (the contract's second call) answerable without listing
 * it twice.
 */
let scriptedFileState: { content: string; index: number } | null = null;

class ScriptedFileTransport implements Transport {
  constructor(private readonly target: string) {}

  async send(request: TransportRequest): Promise<TransportResponse> {
    // Reading the URL is not incidental: the contract's outbound step is a POST to
    // the resolved chat-completions endpoint carrying the credential, and a script
    // that answered a request the adapter never built would be proving the wrong
    // thing. The Authorization header is read for the same reason — and is never
    // returned or logged.
    void request.url;
    void request.headers.Authorization;
    const file = currentScript(this.target);
    const content = readFileSync(file, 'utf8');
    if (scriptedFileState === null || scriptedFileState.content !== content) {
      scriptedFileState = { content, index: 0 };
    }
    const index = scriptedFileState.index;
    scriptedFileState.index += 1;
    const script = parseScript(content);
    const reply = script.replies[Math.min(index, script.replies.length - 1)];
    if (reply === undefined) {
      throw new AppError('INTERNAL', 'BRAIN_SCRIPTED_PROVIDER 文件里没有任何回复');
    }
    return reply;
  }
}

interface ScriptedReply {
  status?: number;
  /** The provider's answer text, wrapped into a minimal chat-completions body. */
  content?: string;
  /** Escape hatch for protocol-level cases; used verbatim as the body. */
  bodyText?: string;
  headers?: Record<string, string>;
}

function parseScript(text: string): { replies: TransportResponse[] } {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new AppError(
      'INTERNAL',
      `BRAIN_SCRIPTED_PROVIDER 文件不是合法 JSON：${error instanceof Error ? error.message : ''}`,
    );
  }
  const replies = (payload as { replies?: unknown }).replies;
  if (!Array.isArray(replies) || replies.length === 0) {
    throw new AppError('INTERNAL', 'BRAIN_SCRIPTED_PROVIDER 需要非空的 replies 数组');
  }
  return {
    replies: replies.map((entry) => {
      const reply = entry as ScriptedReply;
      const status = reply.status ?? 200;
      const bodyText =
        reply.bodyText ??
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: reply.content ?? '' },
              finish_reason: 'stop',
            },
          ],
        });
      return {
        status,
        headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
        bodyText,
      };
    }),
  };
}

export function setTransport(transport: Transport | null): void {
  defaultTransport = transport;
}
