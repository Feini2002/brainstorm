// Local launch wrapper (T004-R02/R05/R06).
//
// Responsibilities:
//   - resolve host/port/origin in ONE place so APP_ORIGIN cannot drift
//   - fail fast (before Next starts) when the port is already taken, instead of
//     letting Next pick a random port that would break origin checks
//   - forward the exit code and termination signals, and never auto-restart
//
// Uses only Node built-ins so it behaves the same on Windows and POSIX.
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;

export function resolveLaunchConfig(env = process.env) {
  const host = (env.APP_HOST ?? DEFAULT_HOST).trim();
  const port = Number.parseInt(env.APP_PORT ?? String(DEFAULT_PORT), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`APP_PORT 不是合法端口：${env.APP_PORT}`);
  }
  const origin = (env.APP_ORIGIN ?? `http://${host}:${port}`).trim();
  if (new URL(origin).hostname !== host || Number(new URL(origin).port || 80) !== port) {
    throw new Error(`APP_ORIGIN (${origin}) 与监听地址 ${host}:${port} 不一致`);
  }
  return { host, port, origin };
}

/** Try to bind the port; a successful bind proves it is free. */
function portIsFree(host, port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, host);
  });
}

async function main() {
  const mode = process.argv[2] === 'start' ? 'start' : 'dev';
  let config;
  try {
    config = resolveLaunchConfig();
  } catch (error) {
    console.error(`STARTUP_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }

  if (!(await portIsFree(config.host, config.port))) {
    console.error(
      `STARTUP_FAILED: ${config.host}:${config.port} 已被占用。请关闭已有实例，或同时修改 APP_PORT 与 APP_ORIGIN 后重试。`,
    );
    process.exitCode = 1;
    return;
  }

  // Keep APP_ORIGIN/HOST/PORT explicit in the child so the server and this
  // wrapper agree even if the user only set one of them.
  const childEnv = {
    ...process.env,
    APP_HOST: config.host,
    APP_PORT: String(config.port),
    APP_ORIGIN: config.origin,
    ...(mode === 'dev' ? { NODE_ENV: process.env.NODE_ENV ?? 'development' } : {}),
  };

  const nextBin = path.join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
  const args =
    mode === 'dev'
      ? [nextBin, 'dev', '--hostname', config.host, '--port', String(config.port)]
      : [nextBin, 'start', '--hostname', config.host, '--port', String(config.port)];

  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: childEnv,
    stdio: 'inherit',
  });

  // Forward termination signals so Ctrl+C reaches Next, then exit with the
  // child's real code — no restart loop that would hide a startup failure.
  const forward = (signal) => () => {
    if (!child.killed) child.kill(signal);
  };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });

  child.on('error', (error) => {
    console.error(`STARTUP_FAILED: 无法启动 Next：${error.message}`);
    process.exitCode = 1;
  });
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('scripts', 'start-local.mjs'));

if (isMain) await main();
