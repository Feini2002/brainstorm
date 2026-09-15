import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

import { E2E_PORT, E2E_RESTART_DATA_DIR, E2E_SCRIPTED_DIR } from './env';

/**
 * A server process this test owns (T026-R03).
 *
 * T026 explicitly rules out "just refresh the browser" as evidence that data is
 * persisted, so the restart case has to stop the Node process and start a new
 * one. Playwright's `webServer` option owns one long-lived server and cannot be
 * restarted mid-run, so this case manages its own:
 *
 *  - its own **port**, so it never collides with the suite's main server;
 *  - its own **data directory**, so two processes never open the same SQLite file
 *    (which would make the restart assertion ambiguous rather than wrong);
 *  - a real **process tree kill**, verified by waiting for the port to free, so
 *    "the server restarted" is checked rather than assumed.
 *
 * This is deliberately the only test that spawns processes: for every other case
 * the managed `webServer` is simpler and faster.
 */

const PROJECT_ROOT = process.cwd();

/** Port used by the restart case; kept away from the shared 3100. */
export function restartPort(): number {
  return E2E_PORT + 1;
}

export function restartOrigin(): string {
  return `http://127.0.0.1:${restartPort()}`;
}

export function restartDataDir(): string {
  return E2E_RESTART_DATA_DIR;
}

/** Remove the restart case's database so each run starts from an empty library. */
export function resetRestartDataDir(): void {
  const dir = restartDataDir();
  if (path.basename(dir) !== '.data-restart') {
    throw new Error(`拒绝清理非预期目录 ${dir}`);
  }
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

async function waitForHealthy(origin: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`, {
        headers: { host: new URL(origin).host },
      });
      if (response.ok) return;
      lastError = new Error(`health 返回 ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `服务器未在 ${timeoutMs}ms 内就绪：${lastError instanceof Error ? lastError.message : '未知错误'}`,
  );
}

/** True when nothing is listening on the port any more. */
export async function isPortFree(port: number): Promise<boolean> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

export interface ManagedServer {
  origin: string;
  pid: number;
  stop: () => Promise<void>;
}

/**
 * Overrides for {@link startServer}.
 *
 * `scriptedProvider: false` exists for T042's live semantic cases. The shared
 * suite server always has the scripted seam on, so a case that configured a real
 * key there would still be answered by the replay file — a "semantic pass" that
 * was really a replay is precisely the forgery T042-R05 forbids. Such a case has
 * to run against a server where the seam is absent, and that server needs its own
 * data directory so it cannot disturb the suite's shared database.
 */
export interface StartServerOptions {
  port?: number;
  dataDir?: string;
  /** Set `false` to start a server that can reach a real provider. */
  scriptedProvider?: boolean;
  /** Extra environment for the child, e.g. nothing secret in the default path. */
  extraEnv?: Record<string, string>;
}

/**
 * Start one `next start` instance against the restart data directory.
 *
 * The child is spawned through the same `scripts/start-local.mjs` wrapper the user
 * runs, so the case exercises the real launch path — including its own port and
 * origin validation — instead of a hand-rolled `next start`.
 */
export async function startServer(options: StartServerOptions = {}): Promise<ManagedServer> {
  const port = options.port ?? restartPort();
  const origin = `http://127.0.0.1:${port}`;
  const dataDir = options.dataDir ?? restartDataDir();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_HOST: '127.0.0.1',
    APP_PORT: String(port),
    APP_ORIGIN: origin,
    BRAIN_DATA_DIR: dataDir,
    NODE_ENV: 'production',
    ...(options.extraEnv ?? {}),
  };
  if (options.scriptedProvider === false) {
    // Deleted rather than merely not set: the runner's own environment must not be
    // able to smuggle the seam back in, or the live case would replay silently.
    delete env.BRAIN_SCRIPTED_PROVIDER;
  } else {
    // The scripted provider directory, so this case's generation path can be
    // driven by a fixed answer without a real model (see transport.ts).
    env.BRAIN_SCRIPTED_PROVIDER = E2E_SCRIPTED_DIR;
  }

  const child: ChildProcess = spawn(
    process.execPath,
    [path.join(PROJECT_ROOT, 'scripts', 'start-local.mjs'), 'start'],
    {
      cwd: PROJECT_ROOT,
      env,
      stdio: 'ignore',
      windowsHide: true,
    },
  );

  const pid = child.pid;
  if (pid === undefined) throw new Error('无法取得服务器进程 pid');

  child.on('error', () => {
    // Recorded through the health-check timeout; an unhandled 'error' event would
    // otherwise crash the test runner with no useful message.
  });

  try {
    await waitForHealthy(origin);
  } catch (error) {
    await stopProcessTree(pid);
    throw error;
  }

  return {
    origin,
    pid,
    stop: async () => {
      await stopProcessTree(pid);
      // Verified, not assumed: the port must be free before the next instance
      // starts, otherwise the "restart" might silently talk to the old process.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (await isPortFree(port)) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`端口 ${port} 在停止后仍被占用，重启结果不可信`);
    },
  };
}

/**
 * Kill the wrapper *and* the `next start` child it forwarded to.
 *
 * `start-local.mjs` spawns Next as a child, so signalling only the wrapper would
 * leave the actual server holding the port. On Windows the tree kill is the only
 * reliable option; elsewhere the process group is addressed through the shell
 * Node already created.
 */
async function stopProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('exit', () => resolve());
      killer.once('error', () => resolve());
    });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone; nothing to clean up.
  }
}
