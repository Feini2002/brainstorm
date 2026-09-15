/**
 * A real loopback HTTP server, for the security cases that must observe an actual
 * outbound connection rather than a stubbed `fetch`.
 *
 * Why a shared fixture: two T075 cases need a *reachable* server (C04's redirect
 * chain, C05's egress ledger). If each file kept its own copy, the port/close
 * handling could drift between them and a leaked listener in one file would show
 * up as a flake in the other.
 *
 * Everything binds `127.0.0.1` on an ephemeral port. Nothing here resolves or
 * contacts an external host — that is a hard T075 rule, so the fixture makes the
 * local-only property structural rather than a convention.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  body: string;
}

export interface LoopbackServer {
  /** e.g. `http://127.0.0.1:53124`. */
  origin: string;
  port: number;
  /** Every request the server received, in order. */
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

export type LoopbackHandler = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
) => void;

/** Start a real loopback HTTP server. Requests are recorded before the handler runs. */
export async function startLoopbackServer(handler: LoopbackHandler): Promise<LoopbackServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization ?? null,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      handler(request, response);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    requests,
    // Idempotent: a case may close a server itself (to free the port and prove a
    // refusal) and `afterEach` closes every server again. `ERR_SERVER_NOT_RUNNING`
    // means "already closed", not "failed to close".
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

/** A server that answers every request with a minimal valid chat-completions body. */
export async function startChatServer(
  content = '{"ok":true}',
): Promise<LoopbackServer> {
  return startLoopbackServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }),
    );
  });
}

/** A server that answers every request with 302 to `location`. */
export async function startRedirectServer(location: string): Promise<LoopbackServer> {
  return startLoopbackServer((_request, response) => {
    response.writeHead(302, { location });
    response.end();
  });
}
