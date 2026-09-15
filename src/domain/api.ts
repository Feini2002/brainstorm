/**
 * Wire envelope shared by the server and the browser client.
 *
 * Success: {ok:true,data,requestId}. Failure: {ok:false,error,requestId}.
 * The UI branches on `error.code`; localized messages are for humans only
 * (docs/03_contracts/04_api_contract.md §1, T006-R01).
 */
import type { SafeError } from './errors';

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  requestId: string;
}

export interface ApiFailure {
  ok: false;
  error: SafeError;
  requestId: string;
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

/** Field name -> messages, used to attach errors to inputs (T006-R01). */
export type FieldErrors = Record<string, string[]>;

export function isApiSuccess<T>(value: ApiEnvelope<T>): value is ApiSuccess<T> {
  return value.ok === true;
}

export function isApiFailure<T>(value: ApiEnvelope<T>): value is ApiFailure {
  return value.ok === false;
}

/** Sessions exposed by GET /api/session; the token is process-scoped only. */
export interface SessionInfo {
  token: string;
  sessionId: string;
  origin: string;
}

/** GET /api/health: fixed shape, no counts, paths or model addresses. */
export interface HealthInfo {
  application: 'feini-brain';
  healthy: boolean;
  protocolVersion: number;
}

export interface DeletedId {
  deletedId: string;
}

export interface RecoveredIds {
  recoveredIds: string[];
}

/** POST /api/graph response scope, so partial graphs cannot masquerade as whole. */
export interface GraphScope {
  matchedNodeCount: number;
  shownNodeCount: number;
  matchedEdgeCount: number;
  shownEdgeCount: number;
  /** Shown edges still awaiting confirmation (T050-R01). */
  suggestedEdgeCount: number;
  truncated: boolean;
}

export interface ViewPage {
  views: import('./knowledge').ViewSummaryDTO[];
  nextCursor: string | null;
}

export interface ItemPageResult {
  items: import('./knowledge').ItemDTO[];
  nextCursor: string | null;
  totalMatched: number;
}

export interface RunResult {
  runId: string;
  itemId?: string;
  viewId?: string;
  state?: import('./knowledge').RunState;
  connected?: boolean;
  latencyMs?: number;
  replyAccepted?: boolean;
  warnings: string[];
  resultMissing?: boolean;
}

export interface ImportValidation {
  valid: boolean;
  bundleHash: string;
  counts: {
    items: number;
    relations: number;
    views: number;
    tags: number;
  };
  warnings: string[];
}

export interface ImportResult {
  imported: {
    items: number;
    relations: number;
    views: number;
    tags: number;
  };
  bundleHash: string;
}

/* -------------------------------------------------------------------------- */
/* GET /api/diagnostics (T074)                                                */
/* -------------------------------------------------------------------------- */

/**
 * The failure layers a user is sent to fix (T074-R06).
 *
 * The vocabulary lives here, in the pure domain layer, because both sides name
 * it: the server classifies the layers it can observe (config, model, storage,
 * local runtime) and the settings panel adds the one only a browser can observe
 * (render sizing). A layer the app cannot classify honestly becomes `unknown`
 * rather than being forced into a nearby bucket — sending someone to fix the
 * wrong thing is worse than saying "unclassified".
 */
export const FAILURE_LAYERS = [
  'config',
  'model',
  'storage',
  'render',
  'local_runtime',
  'unknown',
] as const;

export type FailureLayer = (typeof FAILURE_LAYERS)[number];

/** Display name per layer; used verbatim by the panel. */
export const FAILURE_LAYER_LABELS: Record<FailureLayer, string> = {
  config: '本地配置',
  model: '模型服务',
  storage: '本地存储',
  render: '页面渲染',
  local_runtime: '运行环境',
  unknown: '未分类',
};

/** One implicated layer plus the single first thing to check for it. */
export interface FailureLayerEntry {
  layer: FailureLayer;
  label: string;
  /** A concrete first check, distinct per layer (never "reinstall everything"). */
  nextStep: string;
  /** The observations that put this layer on the list. */
  evidence: string[];
}

/**
 * Latency summary over retained samples.
 *
 * Percentiles use the nearest-rank definition on the actual samples — no
 * interpolation, so a reported p95 is a duration that really happened.
 */
export interface LatencyStats {
  count: number;
  lastMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface RouteLatency {
  route: string;
  stats: LatencyStats;
}

export interface ObservedErrorCode {
  code: string;
  layer: FailureLayer;
  /** `run` = read from the ai_runs ledger, `process` = this process's journal. */
  source: 'run' | 'process';
  count: number;
}

/** Retention and repeat-suppression state of the in-process diagnostic journal (T074-R04). */
export interface JournalStats {
  /** Hard cap on retained events; older events rotate out. */
  capacity: number;
  retained: number;
  /** Every event ever recorded in this process, retained or not. */
  recorded: number;
  /** Events evicted by the retention cap. */
  droppedByRetention: number;
  /** Identical repeats collapsed instead of printed again. */
  suppressedRepeats: number;
  /** Lines actually handed to the log sink. */
  emitted: number;
}

export interface RetentionPolicy {
  /** The rule, as one sentence the UI can render alongside the counters. */
  policy: string;
  capacity: number;
  repeatLimit: number;
  windowMs: number;
  /**
   * Where records go. This build logs to stdout and writes no log file, so the
   * bounded thing is the journal and the print rate — not a file on disk.
   */
  sink: 'stdout';
}

export interface RunLatencyReport {
  /** Finished runs the summary was computed over (bounded sample). */
  finished: number;
  /** Running rows: not a latency sample, reported so the gap is visible. */
  unfinished: number;
  stats: LatencyStats;
}

/**
 * Version and kind of each renderer this build ships (T074-R03).
 *
 * The versions come from `src/domain/view.ts`, the same constants recorded on a
 * saved view, so a renderer error can be matched to the version that produced it.
 */
export interface RendererIdentity {
  kind: string;
  version: string;
}

/**
 * Diagnostics deliberately expose host-only endpoint info, never the full URL,
 * and a data-directory *kind* rather than its absolute path (T074-R02).
 */
export interface DiagnosticsReport {
  application: 'feini-brain';
  version: string;
  node: string;
  platform: string;
  arch: string;
  protocolVersion: number;
  runMode: string;
  dataDir: {
    kind: 'default' | 'custom';
    exists: boolean;
    /** Writability as observed by a real probe file, or null when unobservable. */
    writable: boolean | null;
  };
  database: {
    /** `PRAGMA user_version`, or null when it could not be read. */
    schemaVersion: number | null;
    supportedSchemaVersion: number;
    datasetRevision: number;
    /**
     * Result of a real write-reservation probe: `locked` means another
     * connection holds the write lock right now (T074-C02).
     */
    lockProbe: 'ok' | 'locked' | 'unavailable';
    /** True when no lease recovery or journal write is performed by this read. */
    readOnly: true;
  };
  /** Row counts, or null where a table could not be read (never a made-up 0). */
  counts: {
    items: number | null;
    relations: number | null;
    views: number | null;
    tags: number | null;
    runs: number | null;
  };
  model: {
    adapter: string;
    /** Scheme + host only; the path and query are never reported. */
    endpointHost: string | null;
    model: string;
    apiKeyConfigured: boolean;
    structuredMode: string;
    tokenField: string;
    schemaRepairEnabled: boolean;
  };
  security: {
    host: string;
    loopbackOnly: boolean;
    requiresToken: true;
  };
  /** Implemented registry paths, derived from the filesystem; never a claim. */
  capabilities: string[];
  observability: {
    /** Explicit, checkable statement: this build calls no third-party service. */
    telemetry: 'none';
    apiLatency: {
      /** Latency is recorded by the diagnostics layer; other routes have no samples. */
      note: string;
      routes: RouteLatency[];
    };
    runLatency: RunLatencyReport;
    errorCodes: ObservedErrorCode[];
    renderers: RendererIdentity[];
    journal: JournalStats;
    retention: RetentionPolicy;
  };
  /** Layers currently implicated. Empty when nothing points at a failure. */
  layers: FailureLayerEntry[];
}
