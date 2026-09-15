/**
 * Local diagnostics and observability (T074).
 *
 * Four things this module refuses to do, because each of them is the failure
 * mode the task exists to prevent:
 *
 *  1. **It does not invent a number it could not observe.** A table that cannot
 *     be read reports `null`, not `0`; a data directory that does not exist
 *     reports `writable: null`, not `true`. A plausible default reads exactly
 *     like a measurement once it is on screen (T074 §7「观测不到的数据应写未知」).
 *  2. **It does not reimplement redaction.** Everything that reaches an output
 *     goes through `logSafe` for the journal, `safeSettingsSummary` for the
 *     endpoint, and `registerSecret` for the live key — the T030 layer. The
 *     diagnostics DTO has no field an API key, note text or absolute path could
 *     be assigned to (T074-R05).
 *  3. **It performs no write.** The lock probe below reserves and immediately
 *     releases the write lock, which is the only way to answer "is another
 *     connection holding it right now?" (T074-C02). It writes no row, no
 *     knowledge, no run and no setting; the C02 case asserts the counts are
 *     unchanged across a locked read.
 *  4. **It reports missing latency as missing.** The HTTP layer does not yet
 *     time every route, so `apiLatency.routes` carries a note saying which reads
 *     it covers. Run latency, by contrast, is computed from the real ledger.
 *
 * ## Failure layers (T074-R06)
 *
 * Classification reuses T041's `classifyRunError` rather than introducing a
 * second vocabulary, and maps its categories onto the layers a user acts on:
 * a database lock becomes `storage` (never `model`), a provider failure becomes
 * `model`, a missing key becomes `config`. `render` is the one layer the server
 * cannot observe — only a browser knows its container has zero height — so it is
 * added by the panel, and the classification here never guesses at it.
 */
import 'server-only';

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import {
  FAILURE_LAYER_LABELS,
  type DiagnosticsReport,
  type FailureLayer,
  type FailureLayerEntry,
  type JournalStats,
  type LatencyStats,
  type ObservedErrorCode,
  type RendererIdentity,
  type RetentionPolicy,
  type RouteLatency,
  type RunLatencyReport,
} from '@/domain/api';
import { LIMITS } from '@/domain/limits';
import {
  classifyRunError,
  type RunErrorCategory,
} from '@/domain/runDto';
import {
  FLOW_RENDERER_VERSION,
  GRAPH_RENDERER_VERSION,
  MINDMAP_RENDERER_VERSION,
} from '@/domain/view';
import { LATEST_KNOWN_VERSION, readUserVersion } from '@/server/db/migrations';
import {
  detectRunMode,
  isUserDataDir,
  resolveDataDir,
} from '@/server/runtime/dataDir';
import {
  logSafe,
  redactSecrets,
  safeSettingsSummary,
  type SafeLogRecord,
} from '@/server/observability/redaction';
import { publicSettings } from '@/server/repositories/settings';

/** The one HTTP route whose latency this layer can honestly report. */
export const DIAGNOSTICS_READ_ROUTE = 'diagnostics.read';

/** Protocol version published by `GET /api/health`; read, not re-declared. */
const PROTOCOL_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* The journal: bounded retention and repeat suppression (T074-R04)           */
/* -------------------------------------------------------------------------- */

/**
 * One recorded diagnostic event.
 *
 * The type is a whitelist, exactly like `SafeLogRecord`: there is no field for
 * note text, a request body or a provider response, so no caller can put one in
 * a retained event even by accident.
 */
export interface DiagnosticEvent {
  level: SafeLogRecord['level'];
  /** Stable event name, e.g. `diagnostics.read`. Never interpolated content. */
  code: string;
  route?: string;
  requestId?: string;
  runId?: string;
  durationMs?: number;
  httpStatus?: number;
  /** Already-redacted provider summary, when one exists. */
  errorSummary?: string;
}

/** Identity of a repeat: same event name, route and request, same failure. */
function repeatKey(event: DiagnosticEvent): string {
  return `${event.level ?? 'info'}|${event.code}|${event.route ?? ''}|${event.requestId ?? ''}`;
}

const RETENTION: RetentionPolicy = {
  policy:
    `日志按先进先出保留最近 ${LIMITS.diagnosticJournalCapacity} 条事件，超出即丢弃最旧的一条；` +
    `同一条目在 ${LIMITS.diagnosticRepeatWindowMs / 1000} 秒内最多打印 ${LIMITS.diagnosticRepeatLimit} 次，` +
    `之后的重复只计数不再打印。本版本日志输出到进程标准输出，不写日志文件。`,
  capacity: LIMITS.diagnosticJournalCapacity,
  repeatLimit: LIMITS.diagnosticRepeatLimit,
  windowMs: LIMITS.diagnosticRepeatWindowMs,
  sink: 'stdout',
};

/**
 * Bounded, process-lifetime event journal.
 *
 * A ring buffer rather than an array that grows: the retention cap is what makes
 * "the log does not grow without bound" a property of the data structure instead
 * of a promise about how often the code runs.
 *
 * `Date.now` is injectable so a test can drive the repeat window without waiting
 * a real minute.
 */
class DiagnosticJournal {
  private readonly events: DiagnosticEvent[] = [];
  private readonly prints = new Map<string, number[]>();
  private recorded = 0;
  private dropped = 0;
  private suppressed = 0;
  private emitted = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  record(event: DiagnosticEvent): { printed: boolean; suppressed: boolean } {
    this.recorded += 1;

    this.events.push(event);
    while (this.events.length > RETENTION.capacity) {
      this.events.shift();
      this.dropped += 1;
    }

    const key = repeatKey(event);
    const now = this.clock();
    const window = (this.prints.get(key) ?? []).filter(
      (at) => now - at < RETENTION.windowMs,
    );

    if (window.length >= RETENTION.repeatLimit) {
      // Beyond the limit the repeat is counted and swallowed: a transient error
      // firing every second must not re-print a full record every second.
      this.suppressed += 1;
      this.prints.set(key, window);
      return { printed: false, suppressed: true };
    }

    window.push(now);
    this.prints.set(key, window);
    this.emitted += 1;
    logSafe({
      level: event.level ?? 'info',
      message: event.code,
      ...(event.route === undefined ? {} : { stage: event.route }),
      ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
      ...(event.runId === undefined ? {} : { runId: event.runId }),
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      ...(event.httpStatus === undefined ? {} : { httpStatus: event.httpStatus }),
      ...(event.errorSummary === undefined ? {} : { errorSummary: event.errorSummary }),
    });
    return { printed: true, suppressed: false };
  }

  /** Retained events, newest last. Read-only copy. */
  retained(): readonly DiagnosticEvent[] {
    return [...this.events];
  }

  stats(): JournalStats {
    return {
      capacity: RETENTION.capacity,
      retained: this.events.length,
      recorded: this.recorded,
      droppedByRetention: this.dropped,
      suppressedRepeats: this.suppressed,
      emitted: this.emitted,
    };
  }

  /** Test hook: drop all state so a case starts from a known baseline. */
  reset(): void {
    this.events.length = 0;
    this.prints.clear();
    this.recorded = 0;
    this.dropped = 0;
    this.suppressed = 0;
    this.emitted = 0;
  }
}

const journal = new DiagnosticJournal();

/** Replace the journal for a test; returns the previous instance. */
export function resetDiagnosticJournal(): void {
  journal.reset();
}

export function journalStats(): JournalStats {
  return journal.stats();
}

export function retentionPolicy(): RetentionPolicy {
  return RETENTION;
}

/** Record one diagnostic event, subject to the retention and repeat policy. */
export function recordDiagnosticEvent(event: DiagnosticEvent): void {
  journal.record(event);
}

/* -------------------------------------------------------------------------- */
/* Latency: bounded samples, real percentiles (T074-R03)                      */
/* -------------------------------------------------------------------------- */

/** Per-route latency samples, bounded so memory cannot grow with uptime. */
const latencySamples = new Map<string, number[]>();

/** Percentile by nearest rank over the real samples; no interpolation. */
function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index] ?? null;
}

export function latencyStats(samples: readonly number[]): LatencyStats {
  if (samples.length === 0) {
    return { count: 0, lastMs: null, minMs: null, maxMs: null, p50Ms: null, p95Ms: null };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: samples.length,
    lastMs: samples[samples.length - 1] ?? null,
    minMs: sorted[0] ?? null,
    maxMs: sorted[sorted.length - 1] ?? null,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

/** Record one API latency sample for a route. */
export function recordApiLatency(route: string, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const samples = latencySamples.get(route) ?? [];
  samples.push(Math.trunc(durationMs));
  while (samples.length > LIMITS.diagnosticLatencySamples) samples.shift();
  latencySamples.set(route, samples);
}

export function apiLatencyReport(): RouteLatency[] {
  return [...latencySamples.entries()]
    .map(([route, samples]) => ({ route, stats: latencyStats(samples) }))
    .sort((left, right) => left.route.localeCompare(right.route));
}

/** Test hook: forget all latency samples. */
export function resetApiLatency(): void {
  latencySamples.clear();
}

/* -------------------------------------------------------------------------- */
/* Layer classification (T074-R06)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Which layer a T041 error category belongs to.
 *
 * The mapping direction is deliberate: `classifyRunError` already decides
 * *what kind of thing went wrong* from a stored code, and this only decides
 * *which component the user should look at*. A second code→meaning table would
 * be a second source of truth that could disagree with T041.
 */
const CATEGORY_LAYER: Record<RunErrorCategory, FailureLayer> = {
  configuration: 'config',
  auth: 'model',
  rate_limit: 'model',
  network: 'model',
  truncated: 'model',
  format: 'model',
  semantic: 'model',
  // A revision or state conflict is local bookkeeping, not the model.
  local_conflict: 'storage',
  local_storage: 'storage',
  unknown: 'unknown',
};

function layerForCode(code: string): FailureLayer {
  return CATEGORY_LAYER[classifyRunError(code)];
}

/** The single first check for each layer. Deliberately different per layer. */
const FIRST_STEP: Record<FailureLayer, string> = {
  config: '到设置页填写 Base URL、模型名与 API Key，然后点“测试当前草稿”。',
  model: '在设置页核对模型名与地址是否正确，再看下面的模型耗时；也可以换用响应更快的模型。',
  storage: '先关闭其他正在写入本库的窗口或进程，等写锁释放后重试；不要重装依赖。',
  render: '把窗口拉大到能容下内容，或取消会压扁容器高度的自定义样式后重新载入页面。',
  local_runtime: '到诊断摘要里核对 Node 与 schema 版本，并按提示重启本地服务。',
  unknown: '先看下面的错误码与最近运行，再决定改哪一处配置。',
};

function entry(
  layer: FailureLayer,
  evidence: readonly string[],
): FailureLayerEntry {
  return {
    layer,
    label: FAILURE_LAYER_LABELS[layer],
    nextStep: FIRST_STEP[layer],
    evidence: [...new Set(evidence)],
  };
}

/* -------------------------------------------------------------------------- */
/* Environment facts (T074-R02)                                               */
/* -------------------------------------------------------------------------- */

interface PackageIdentity {
  version: string;
}

let packageIdentity: PackageIdentity | null = null;

/**
 * Read the application version from `package.json`.
 *
 * Read rather than hard-coded so the report cannot claim a version the build is
 * not running. When the file cannot be read the version is `'unknown'` — an
 * absent value is reported as absent, never substituted.
 */
function appVersion(): string {
  if (packageIdentity === null) {
    try {
      const raw = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
        version?: unknown;
      };
      packageIdentity = { version: typeof raw.version === 'string' ? raw.version : 'unknown' };
    } catch {
      packageIdentity = { version: 'unknown' };
    }
  }
  return packageIdentity.version;
}

/**
 * Capabilities = the API routes this build actually ships.
 *
 * Derived from the App Router tree instead of a hand-written list, so a route
 * that was deleted cannot keep being advertised and a new one cannot be
 * forgotten. Dynamic segments are rendered back as `{id}` so the value matches
 * `reference/contracts/api_registry.json`'s notation.
 */
let capabilitiesCache: string[] | null = null;

export function implementedApiPaths(apiRoot = path.join(process.cwd(), 'src', 'app', 'api')): string[] {
  if (capabilitiesCache !== null && apiRoot === defaultApiRoot()) return capabilitiesCache;
  const found: string[] = [];
  const walk = (directory: string, segments: string[]): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const full = path.join(directory, entry);
      let isDirectory = false;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) {
        walk(full, [...segments, entry]);
        continue;
      }
      if (entry !== 'route.ts') continue;
      found.push(`/api/${segments.map(bracketToPlaceholder).join('/')}`);
    }
  };
  walk(apiRoot, []);
  const result = found.sort();
  if (apiRoot === defaultApiRoot()) capabilitiesCache = result;
  return result;
}

function defaultApiRoot(): string {
  return path.join(process.cwd(), 'src', 'app', 'api');
}

function bracketToPlaceholder(segment: string): string {
  const match = /^\[(.+)\]$/u.exec(segment);
  return match ? `{${match[1]}}` : segment;
}

/* -------------------------------------------------------------------------- */
/* Database facts                                                             */
/* -------------------------------------------------------------------------- */

export type LockProbe = 'ok' | 'locked' | 'unavailable';

/**
 * Ask SQLite whether another connection holds the write lock right now.
 *
 * `BEGIN IMMEDIATE` takes the write reservation and `ROLLBACK` releases it, so
 * the probe reserves rather than waits: it answers the question in the state the
 * database is actually in, with no writes to any table and no new transaction
 * left open. A read (`BEGIN DEFERRED`, a `SELECT`) would not answer it — WAL
 * readers proceed happily while a writer holds the lock, which is exactly the
 * case T074-C02 is about.
 *
 * `busy_timeout` is set to 0 for the probe and restored afterwards, including on
 * the failure path: a diagnostics read must not change how the process talks to
 * SQLite afterwards.
 */
export function probeWriteLock(db: DatabaseSync): LockProbe {
  let previous: number | null = null;
  try {
    const row = db.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined;
    previous = row?.timeout ?? null;
  } catch {
    previous = null;
  }

  let reserved = false;
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('BEGIN IMMEDIATE');
    reserved = true;
    return 'ok';
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return /locked|busy/iu.test(message) ? 'locked' : 'unavailable';
  } finally {
    if (reserved) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The probe's own transaction must never mask the answer it produced.
      }
    }
    if (previous !== null) {
      try {
        db.exec(`PRAGMA busy_timeout = ${previous}`);
      } catch {
        // Restoring a timeout is best-effort; the value is re-read from the row.
      }
    }
  }
}

const COUNT_TABLES = {
  items: 'knowledge_items',
  relations: 'relations',
  views: 'views',
  tags: 'tags',
  runs: 'ai_runs',
} as const;

/**
 * Row counts, or `null` per table that cannot be read.
 *
 * A table that is missing because the schema is older is itself a fact worth
 * reporting; a hard failure would turn "one table is odd" into "no diagnostics
 * at all", and a substituted 0 would state that the library is empty.
 */
export function countRows(db: DatabaseSync): DiagnosticsReport['counts'] {
  const counts: DiagnosticsReport['counts'] = {
    items: null,
    relations: null,
    views: null,
    tags: null,
    runs: null,
  };
  for (const [key, table] of Object.entries(COUNT_TABLES) as [
    keyof typeof COUNT_TABLES,
    string,
  ][]) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number };
      counts[key] = typeof row?.n === 'number' ? row.n : null;
    } catch {
      counts[key] = null;
    }
  }
  return counts;
}

/** Latency over finished runs, from the real ledger. */
export function readRunLatency(db: DatabaseSync): RunLatencyReport {
  const rows = (() => {
    try {
      return db
        .prepare(
          `SELECT started_at AS startedAt, finished_at AS finishedAt, state AS state
             FROM ai_runs
            ORDER BY started_at DESC
            LIMIT ?`,
        )
        .all(LIMITS.diagnosticRecentRuns) as {
        startedAt: string;
        finishedAt: string | null;
        state: string;
      }[];
    } catch {
      return [];
    }
  })();

  const durations: number[] = [];
  let unfinished = 0;
  for (const row of rows) {
    if (row.finishedAt === null) {
      // A running row is not a latency sample — it has no end yet. Reported
      // separately so the gap between "runs" and "samples" is visible.
      unfinished += 1;
      continue;
    }
    const started = Date.parse(row.startedAt);
    const ended = Date.parse(row.finishedAt);
    if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
      durations.push(ended - started);
    }
  }

  return { finished: durations.length, unfinished, stats: latencyStats(durations) };
}

/**
 * Error codes, from the two places they are actually recorded.
 *
 * `run` is authoritative — the stored `error_code` on the ledger, classified by
 * T041's own function. `process` is this process's journal, which only sees the
 * events routed through this module; the panel labels the source so the two are
 * never added together into one misleading total.
 */
export function observedErrorCodes(
  db: DatabaseSync,
  events: readonly DiagnosticEvent[],
): ObservedErrorCode[] {
  const seen = new Map<string, ObservedErrorCode>();

  const add = (code: string, source: 'run' | 'process'): void => {
    const safe = redactSecrets(code);
    if (safe.length === 0) return;
    const key = `${safe}|${source}`;
    const existing = seen.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    seen.set(key, { code: safe, layer: layerForCode(safe), source, count: 1 });
  };

  try {
    const rows = db
      .prepare(
        `SELECT error_code AS code, COUNT(*) AS n
           FROM ai_runs
          WHERE error_code IS NOT NULL
          GROUP BY error_code`,
      )
      .all() as { code: string; n: number }[];
    for (const row of rows) {
      const safe = redactSecrets(row.code);
      if (safe.length === 0) continue;
      const key = `${safe}|run`;
      const existing = seen.get(key);
      if (existing) existing.count += Math.max(0, row.n);
      else seen.set(key, { code: safe, layer: layerForCode(safe), source: 'run', count: Math.max(0, row.n) });
    }
  } catch {
    // No ledger to read; the process journal below still contributes.
  }

  for (const event of events) {
    if (event.level !== 'warn' && event.level !== 'error') continue;
    add(event.code, 'process');
  }

  return [...seen.values()].sort(
    (left, right) => right.count - left.count || left.code.localeCompare(right.code),
  );
}

/** Renderer versions this build ships, matched to the ids recorded on views. */
export function rendererIdentities(): RendererIdentity[] {
  return [
    { kind: 'graph', version: GRAPH_RENDERER_VERSION },
    { kind: 'mindmap', version: MINDMAP_RENDERER_VERSION },
    { kind: 'flow', version: FLOW_RENDERER_VERSION },
  ];
}

export function isDataDirWritable(dataDir: string): boolean | null {
  if (!existsSync(dataDir)) return null;
  const probe = path.join(dataDir, '.write-probe');
  try {
    writeFileSync(probe, 'ok', { encoding: 'utf8' });
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

export interface BuildDiagnosticsOptions {
  /** Override the data directory (tests point this at a throwaway folder). */
  dataDir?: string;
  /** Override the app version (tests pin it). */
  version?: string;
  /** Override the Node version (tests pin it). */
  node?: string;
  /** Skip the write-lock probe, for a caller that must not reserve the lock. */
  skipLockProbe?: boolean;
}

/**
 * Assemble the report.
 *
 * Every field is copied explicitly and no configured secret is read: the model
 * section comes from `publicSettings` plus `safeSettingsSummary`, so the key can
 * only ever appear as the boolean `apiKeyConfigured` (T074-R05). The endpoint is
 * reduced to its host — the panel and the copyable summary therefore have no
 * path or query to leak (T074-R05「不完整 endpoint query」).
 */
export function buildDiagnosticsReport(
  db: DatabaseSync,
  options: BuildDiagnosticsOptions = {},
): DiagnosticsReport {
  const dataDir = options.dataDir ?? resolveDataDir();
  const runMode = detectRunMode();
  const settings = publicSettings(db);
  const summary = safeSettingsSummary({
    baseUrl: settings.config.baseUrl,
    model: settings.config.model,
    apiKeyConfigured: settings.apiKeyConfigured,
  });

  const lockProbe: LockProbe =
    options.skipLockProbe === true ? 'unavailable' : probeWriteLock(db);

  let schemaVersion: number | null = null;
  try {
    schemaVersion = readUserVersion(db);
  } catch {
    schemaVersion = null;
  }

  const events = journal.retained();
  const errorCodes = observedErrorCodes(db, events);
  const runLatency = readRunLatency(db);

  const layers: FailureLayerEntry[] = [];
  if (lockProbe === 'locked') {
    // T074-C02: a write lock is a storage problem. Saying "the model is slow"
    // here would send the user to fix the wrong component.
    layers.push(
      entry('storage', [
        `写锁探测返回 database is locked：另一个连接正持有写事务`,
        `数据库计数：条目 ${countOf('items')}、运行 ${countOf('runs')}`,
      ]),
    );
  }
  for (const observed of errorCodes) {
    if (observed.source !== 'run') continue;
    layers.push(
      entry(observed.layer, [
        `最近运行记录中的错误码 ${observed.code}（出现 ${observed.count} 次）`,
      ]),
    );
  }
  if (!settings.apiKeyConfigured) {
    layers.push(entry('config', ['尚未配置模型 Key：任何整理/生成操作都会在发请求前失败']));
  }
  if (schemaVersion !== null && schemaVersion > LATEST_KNOWN_VERSION) {
    layers.push(
      entry('local_runtime', [
        `数据库 schema 版本 ${schemaVersion} 高于本程序支持的 ${LATEST_KNOWN_VERSION}`,
      ]),
    );
  }

  return {
    application: 'feini-brain',
    version: options.version ?? appVersion(),
    node: options.node ?? process.version,
    platform: process.platform,
    arch: process.arch,
    protocolVersion: PROTOCOL_VERSION,
    runMode,
    dataDir: {
      // The *kind* and the two booleans, never the absolute path (T074-R02).
      // This is a local tool, but the report is designed to be copyable and
      // pasted elsewhere, and a home directory is not the sharer's to give away.
      kind: isUserDataDir(dataDir) ? 'default' : 'custom',
      exists: existsSync(dataDir),
      writable: isDataDirWritable(dataDir),
    },
    database: {
      schemaVersion,
      supportedSchemaVersion: LATEST_KNOWN_VERSION,
      datasetRevision: readDatasetRevision(db),
      lockProbe,
      readOnly: true,
    },
    counts: countRows(db),
    model: {
      adapter: settings.config.adapter,
      endpointHost: summary.endpointHost,
      model: summary.model,
      apiKeyConfigured: summary.apiKeyConfigured,
      structuredMode: settings.config.structuredMode,
      tokenField: settings.config.tokenField,
      schemaRepairEnabled: settings.config.schemaRepairEnabled,
    },
    security: {
      host: new URL(process.env.APP_ORIGIN ?? `http://127.0.0.1:${LIMITS.appPort}`).host,
      loopbackOnly: true,
      requiresToken: true,
    },
    capabilities: implementedApiPaths(),
    observability: {
      telemetry: 'none',
      apiLatency: {
        note:
          `本版本只为诊断读取（${DIAGNOSTICS_READ_ROUTE}）记录耗时；其它路由还没有样本，` +
          `没有样本时显示未知而不是 0。本次读取的耗时会在下一次读取时出现。`,
        routes: apiLatencyReport(),
      },
      runLatency,
      errorCodes,
      renderers: rendererIdentities(),
      journal: journal.stats(),
      retention: RETENTION,
    },
    layers,
  };

  function countOf(key: keyof DiagnosticsReport['counts']): number | string {
    const table = COUNT_TABLES[key];
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number };
      return typeof row?.n === 'number' ? row.n : '未知';
    } catch {
      return '未知';
    }
  }
}

function readDatasetRevision(db: DatabaseSync): number {
  try {
    const row = db
      .prepare("SELECT value FROM app_meta WHERE key = 'dataset_revision'")
      .get() as { value?: string } | undefined;
    return row?.value === undefined ? 0 : Number.parseInt(row.value, 10);
  } catch {
    return 0;
  }
}

/**
 * Record one diagnostics read.
 *
 * Called by the route *after* the report is built, so the latency reported
 * inside a response is the previous read's. That is stated in
 * `apiLatency.note` rather than papered over by recording a half-measured value.
 */
export function recordDiagnosticsRead(durationMs: number, httpStatus = 200): void {
  recordApiLatency(DIAGNOSTICS_READ_ROUTE, durationMs);
  journal.record({
    level: 'info',
    code: DIAGNOSTICS_READ_ROUTE,
    route: DIAGNOSTICS_READ_ROUTE,
    durationMs,
    httpStatus,
  });
}

/** Exported for the panel's wording, so both sides name a layer the same way. */
export { FAILURE_LAYER_LABELS };
