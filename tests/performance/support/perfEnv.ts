/**
 * Performance-run environment and helpers (T079).
 *
 * These cases are deliberately **not** part of `npm test`: the 10 000-note scale
 * takes tens of seconds to seed and the numbers are only meaningful on a quiet
 * machine, so folding them into the unit suite would make every ordinary run pay
 * for a measurement nobody asked for. They live behind `npm run test:perf`.
 *
 * Four decisions worth stating:
 *
 *  1. **A separate port and separate data directories.** Reusing the e2e port
 *     (3100) would mean a perf run and an acceptance run cannot coexist, and the
 *     perf run writes a 10 000-row database that must never be confused with the
 *     suite's own fixtures. `start-local.mjs` fails fast when the port is taken,
 *     which is what makes "the number I measured came from *my* server" true.
 *
 *  2. **One server per scale, started and stopped by the case.** Playwright's
 *     `webServer` starts one server with one `BRAIN_DATA_DIR`, but R03 needs the
 *     same queries at 100 / 1 000 / 10 000 notes. So the server is a resource the
 *     case owns, not a config constant.
 *
 *  3. **Medians and tails, never a single number.** R05 asks for the median *and*
 *     the tail, and a single sample cannot distinguish "this is the cost" from
 *     "the first request paid for the JIT". Every helper reports the whole sample
 *     set plus median/p95/max.
 *
 *  4. **Cold and warm are separated by construction.** A JIT/SQLite-page-cache
 *     warm-up sample is discarded before the measured ones, so a "warm median"
 *     does not secretly include a cold outlier.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Page } from '@playwright/test';

/** Dedicated port so a perf run never displaces, or is displaced by, the e2e suite. */
export const PERF_HOST = '127.0.0.1';
export const PERF_PORT = 3210;
export const PERF_ORIGIN = `http://${PERF_HOST}:${PERF_PORT}`;

const projectRoot = process.cwd();

/** Where a scale's throwaway database lives. Never the user's `.data`. */
export function benchDataDir(name: string): string {
  return path.resolve(projectRoot, '.tmp-bench-data', name);
}

export interface LaunchConfig {
  host: string;
  port: number;
  origin: string;
}

export const PERF_LAUNCH: LaunchConfig = {
  host: PERF_HOST,
  port: PERF_PORT,
  origin: PERF_ORIGIN,
};

/**
 * The scale each case measures, from `scripts/seed-benchmark.mjs`'s defaults.
 *
 * Kept in one place so a case names a scale instead of repeating five numbers —
 * a "200-node graph" that was seeded with 150 nodes would make the measurement
 * describe something other than what the report claims.
 */
export const SCALES = {
  /** R01/R02's everyday library, and R03's smallest trend point. */
  small: { items: 100, graph: 40, graphEdges: 80, mindmap: 30, flow: 12, flowEdges: 16 },
  /** R01's target scale: 1 000 notes and every projection at its documented cap. */
  target: { items: 1_000, graph: 200, graphEdges: 600, mindmap: 120, flow: 40, flowEdges: 80 },
  /** R03's trend endpoint. Deliberately not asked to draw 10 000 nodes (R03). */
  large: { items: 10_000, graph: 200, graphEdges: 600, mindmap: 120, flow: 40, flowEdges: 80 },
} as const;

export type ScaleName = keyof typeof SCALES;

export function seedArgs(scale: ScaleName, dataDir: string): string[] {
  const spec = SCALES[scale];
  return [
    'scripts/seed-benchmark.mjs',
    '--data-dir',
    dataDir,
    '--items',
    String(spec.items),
    '--graph',
    String(spec.graph),
    '--graph-edges',
    String(spec.graphEdges),
    '--mindmap',
    String(spec.mindmap),
    '--flow',
    String(spec.flow),
    '--flow-edges',
    String(spec.flowEdges),
    '--reset',
  ];
}

/** Run the seeder synchronously and fail loudly instead of measuring an empty library. */
export async function seedScale(scale: ScaleName, dataDir: string): Promise<void> {
  const child = spawn(process.execPath, seedArgs(scale, dataDir), {
    cwd: projectRoot,
    stdio: 'pipe',
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const code = await new Promise<number>((resolve) => child.on('exit', (value) => resolve(value ?? 1)));
  if (code !== 0) {
    throw new Error(`基准种子失败（exit ${code}）：${output}`);
  }
}

export interface BenchServer {
  origin: string;
  /** Session token + origin/host headers for this process, as the browser would send. */
  headers: Record<string, string>;
  /** How long `next start` took to answer `/api/health` with 200. */
  coldStartMs: number;
  stop: () => Promise<void>;
}

/**
 * Start one production server against a scale's database and wait for health.
 *
 * The cold-start time is measured here rather than in the browser: R02 asks for
 * "冷启动" as its own number, and the server becoming reachable is what that
 * means — a browser cannot observe it from inside a page load.
 */
export async function startBenchServer(dataDir: string): Promise<BenchServer> {
  const started = Date.now();
  const child: ChildProcess = spawn(process.execPath, ['scripts/start-local.mjs', 'start'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      APP_HOST: PERF_HOST,
      APP_PORT: String(PERF_PORT),
      APP_ORIGIN: PERF_ORIGIN,
      BRAIN_DATA_DIR: dataDir,
      NODE_ENV: 'production',
      // A real provider must not be reachable from a benchmark: R07's "no local
      // performance mixed with real model spend" is enforced by not configuring one.
      ...(process.env.BRAIN_SCRIPTED_PROVIDER ? { BRAIN_SCRIPTED_PROVIDER: process.env.BRAIN_SCRIPTED_PROVIDER } : {}),
    },
    stdio: 'pipe',
  });
  let log = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    log += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    log += chunk.toString();
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    child.kill();
    // Wait for the process to actually go away so the next scale can bind the port.
    await Promise.race([
      new Promise<void>((resolve) => child.on('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  };

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`基准服务启动即退出（exit ${child.exitCode}）：\n${log.slice(-2000)}`);
    }
    try {
      const response = await fetch(`${PERF_ORIGIN}/api/health`);
      if (response.ok) {
        const coldStartMs = Date.now() - started;
        const headers = await sessionHeaders();
        return { origin: PERF_ORIGIN, headers, coldStartMs, stop };
      }
    } catch {
      // Not listening yet; the loop is the retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await stop();
  throw new Error(`基准服务 90 秒内没有就绪：\n${log.slice(-2000)}`);
}

async function sessionHeaders(): Promise<Record<string, string>> {
  const response = await fetch(`${PERF_ORIGIN}/api/session`, {
    headers: { host: `${PERF_HOST}:${PERF_PORT}`, origin: PERF_ORIGIN },
  });
  if (!response.ok) throw new Error(`GET /api/session 失败：${response.status}`);
  const envelope = (await response.json()) as { data: { token: string } };
  return {
    host: `${PERF_HOST}:${PERF_PORT}`,
    origin: PERF_ORIGIN,
    'content-type': 'application/json',
    'x-brain-token': envelope.data.token,
  };
}

export interface Sample {
  label: string;
  unit: string;
  samples: number[];
  median: number;
  p95: number;
  max: number;
  min: number;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

/**
 * Run one operation several times and report the distribution.
 *
 * `warmup` iterations run first and are discarded, which is what separates R02's
 * "暖请求" from a first-call outlier. The raw samples are returned as well:
 * R05 wants the tail reported, and a reader who only sees a median cannot tell
 * a stable 40 ms from a 20/120 ms spread.
 */
export async function sample(
  label: string,
  unit: string,
  iterations: number,
  operation: (index: number) => Promise<void>,
  warmup = 1,
): Promise<Sample> {
  for (let index = 0; index < warmup; index += 1) await operation(-1 - index);
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await operation(index);
    samples.push(performance.now() - started);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    label,
    unit,
    samples,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? Number.NaN,
    min: sorted[0] ?? Number.NaN,
  };
}

export interface EnvironmentFacts {
  platform: string;
  osRelease: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryGiB: number;
  nodeVersion: string;
  browserVersion: string;
  buildType: 'production';
  buildId: string | null;
}

/**
 * The metadata R05/C06 requires on every reported number.
 *
 * A number without these cannot be compared with anything later, which is the
 * exclusion C06 asks for.
 */
export async function environmentFacts(page: Page): Promise<EnvironmentFacts> {
  const buildIdPath = path.join(projectRoot, '.next', 'BUILD_ID');
  const cpu = os.cpus()[0];
  return {
    platform: `${os.platform()} ${os.arch()}`,
    osRelease: os.release(),
    cpuModel: cpu?.model?.trim() ?? '未知',
    cpuCount: os.cpus().length,
    totalMemoryGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    nodeVersion: process.version,
    browserVersion: page.context().browser()?.version() ?? '未知',
    buildType: 'production',
    buildId: existsSync(buildIdPath) ? statSync(buildIdPath).mtime.toISOString() : null,
  };
}

/** A rich line for the report's environment block. */
export function formatEnvironment(facts: EnvironmentFacts): string {
  return [
    `平台：${facts.platform}（${facts.osRelease}）`,
    `CPU：${facts.cpuModel} × ${facts.cpuCount}`,
    `内存：${facts.totalMemoryGiB} GiB`,
    `Node：${facts.nodeVersion}`,
    `Chromium：${facts.browserVersion}`,
    `构建：${facts.buildType}（BUILD_ID mtime ${facts.buildId ?? '未知'}）`,
  ].join('\n');
}

/** One `| 场景 | 中位数 | p95 | 最大 | 样本 |` row, in ms. */
export function formatSampleRow(result: Sample): string {
  const ms = (value: number): string => `${value.toFixed(1)}`;
  return `| ${result.label} | ${ms(result.median)} | ${ms(result.p95)} | ${ms(result.max)} | n=${result.samples.length}（min ${ms(result.min)}） |`;
}
