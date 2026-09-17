/**
 * Server runtime configuration (T004-R02).
 *
 * A single place resolves host, port and origin so `APP_ORIGIN` can never drift
 * from the port the server actually listens on. The launch wrapper and the
 * request guard both read from here.
 */
import 'server-only';

import { LIMITS } from '@/domain/limits';

export interface RuntimeConfig {
  host: string;
  port: number;
  /** Absolute origin string used for Origin/Host checks. */
  origin: string;
  /** True when the configured host is a loopback address. */
  loopbackOnly: boolean;
  dataDir: string | null;
  nodeEnv: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * Resolve the effective configuration.
 *
 * `APP_ORIGIN` may be supplied explicitly (for tests on a different port); it is
 * validated so a typo cannot silently disable origin checks.
 */
export function resolveRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const requestedHost = (env.APP_HOST ?? LIMITS.host).trim();
  if (requestedHost.length === 0) {
    throw new Error('APP_HOST 不能为空');
  }
  if (!isLoopbackHost(requestedHost)) {
    throw new Error(`本版本只监听本机地址，不支持 APP_HOST=${requestedHost}`);
  }
  const host = requestedHost.toLowerCase() === 'localhost' ? '127.0.0.1' : requestedHost;
  const portRaw = env.APP_PORT ?? String(LIMITS.appPort);
  const port = Number.parseInt(portRaw, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`APP_PORT 不是合法端口：${portRaw}`);
  }

  const origin = (env.APP_ORIGIN ?? `http://${host}:${port}`).trim();
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`APP_ORIGIN 不是合法地址：${origin}`);
  }

  // The origin must agree with the listening socket, otherwise Origin/Host
  // checks would reject the app's own requests.
  if (parsed.hostname !== host || Number(parsed.port || 80) !== port) {
    throw new Error(
      `APP_ORIGIN (${origin}) 与监听地址 ${host}:${port} 不一致，请同时修改`,
    );
  }

  return {
    host,
    port,
    origin,
    loopbackOnly: isLoopbackHost(host),
    dataDir: env.BRAIN_DATA_DIR ?? null,
    nodeEnv: env.NODE_ENV ?? 'development',
  };
}
