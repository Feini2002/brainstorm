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

/** Diagnostics deliberately expose host-only endpoint info, never the full URL. */
export interface DiagnosticsReport {
  application: 'feini-brain';
  version: string;
  node: string;
  protocolVersion: number;
  runMode: string;
  dataDir: string;
  database: {
    userVersion: number;
    datasetRevision: number;
    writable: boolean;
  };
  model: {
    adapter: string;
    endpointHost: string | null;
    model: string;
    apiKeyConfigured: boolean;
    structuredMode: string;
    tokenField: string;
    schemaRepairEnabled: boolean;
  };
  counts: {
    items: number;
    relations: number;
    views: number;
    tags: number;
    runs: number;
  };
  security: {
    host: string;
    origin: string;
    loopbackOnly: boolean;
    tokenHeader: string;
  };
  capabilities: string[];
}
