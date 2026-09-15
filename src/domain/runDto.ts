/**
 * Run diagnostics DTO and its pure derivations (T041).
 *
 * This module is deliberately free of database and environment access: it takes
 * plain values and produces the *only* shape the diagnostics UI and the copyable
 * summary may contain. That is what makes rule T041-R06 structural rather than a
 * promise — there is no field in `RunDiagnostics` that can carry an API key, note
 * text, an absolute filesystem path or the local session token, so a future
 * caller cannot leak one by adding a key to an object.
 *
 * Two facts this module refuses to invent:
 *
 *   - **Token usage.** Only numbers the provider actually returned survive into
 *     `RunUsageView`; everything else is `null` and the UI prints 未知. Deriving
 *     an approximate count from characters would be a measurement we did not
 *     make, and T041-C01 exists to forbid exactly that. There is also no price
 *     table here: a cost estimate would be a guess dressed as a number.
 *   - **Repair attempts.** They are *derived from the recorded request count*,
 *     not tracked separately: one paid request is the operation, any further
 *     recorded request can only be the repair the contract permits (at most one).
 *
 * Error *categories* exist so the user can pick a next step (configuration,
 * authentication, rate limit, network, truncation, format, semantic validation,
 * local conflict, local storage) without the UI parsing Chinese text, which is
 * the same rule the API envelope already follows for `code`.
 */

export const RUN_ERROR_CATEGORIES = [
  'configuration',
  'auth',
  'rate_limit',
  'network',
  'truncated',
  'format',
  'semantic',
  'local_conflict',
  'local_storage',
  'unknown',
] as const;

export type RunErrorCategory = (typeof RUN_ERROR_CATEGORIES)[number];

export const RUN_ERROR_CATEGORY_LABELS: Record<RunErrorCategory, string> = {
  configuration: '本地配置',
  auth: '服务商鉴权',
  rate_limit: '限流或配额',
  network: '网络与服务商可用性',
  truncated: '输出被截断',
  format: '返回格式',
  semantic: '语义与证据校验',
  local_conflict: '本地版本或状态冲突',
  local_storage: '本地存储',
  unknown: '未分类',
};

/**
 * Map an error code to the category the user should act on.
 *
 * A code that is absent or unrecognised becomes `unknown` rather than being
 * forced into a nearby bucket: a wrong diagnosis sends the user to fix the wrong
 * thing, which is worse than saying "we could not classify this".
 *
 * `semantic` is currently unreachable from a stored run, and that is a true
 * statement about the pipeline rather than a gap here: a relation that fails
 * evidence or business validation is *dropped with a warning* and the run still
 * succeeds (docs/03_contracts/06 §6), so it never becomes a run error code. The
 * category stays defined because the classification is contractual, and a future
 * whole-output semantic rejection lands in it.
 */
export function classifyRunError(code: string | null | undefined): RunErrorCategory {
  switch (code) {
    case 'MODEL_NOT_CONFIGURED':
    case 'ENDPOINT_REJECTED':
    case 'VALIDATION':
      return 'configuration';

    case 'PROVIDER_AUTH':
      return 'auth';

    case 'PROVIDER_RATE_LIMIT':
      return 'rate_limit';

    case 'PROVIDER_NETWORK':
    case 'PROVIDER_TIMEOUT':
    case 'PROVIDER_UNAVAILABLE':
    case 'PROVIDER_ENDPOINT':
      return 'network';

    case 'PROVIDER_TRUNCATED':
      return 'truncated';

    case 'STRUCTURED_INVALID':
    case 'PROVIDER_PROTOCOL':
    case 'EMPTY_MODEL_OUTPUT':
    case 'PROVIDER_REFUSAL':
      return 'format';

    case 'REVISION_CONFLICT':
    case 'CAPTURE_KEY_CONFLICT':
    case 'RUN_KEY_CONFLICT':
    case 'RUN_BUSY':
    case 'SOURCE_CHANGED':
    case 'RUN_INTERRUPTED':
    case 'IMPORT_NONEMPTY':
      return 'local_conflict';

    case 'DATABASE_BUSY':
    case 'INTERNAL':
      return 'local_storage';

    default:
      return 'unknown';
  }
}

export interface RunUsageView {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /**
   * True only when the provider returned at least one usable number. When false
   * the UI must say 未知 and must not substitute an estimate (T041-R02).
   */
  reported: boolean;
}

/** Accept only finite, non-negative integers from the stored usage JSON. */
function usableTokens(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

/**
 * Normalize stored usage.
 *
 * `null` input, a malformed object, or an object whose every field is unusable
 * all produce the same explicit "unknown" view. A partially reported usage keeps
 * the reported fields and leaves the rest null, so `total: 120` without an input
 * count still shows something true.
 */
export function usageView(usage: unknown): RunUsageView {
  if (usage === null || typeof usage !== 'object') {
    return { inputTokens: null, outputTokens: null, totalTokens: null, reported: false };
  }
  const record = usage as Record<string, unknown>;
  const view: RunUsageView = {
    inputTokens: usableTokens(record.inputTokens),
    outputTokens: usableTokens(record.outputTokens),
    totalTokens: usableTokens(record.totalTokens),
    reported: false,
  };
  view.reported =
    view.inputTokens !== null || view.outputTokens !== null || view.totalTokens !== null;
  return view;
}

/** Human-readable duration; never a fabricated precision. */
export function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return '未知';
  if (durationMs < 1000) return `${durationMs} 毫秒`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes} 分 ${rest} 秒`;
}

export interface RunDiagnosticsError {
  code: string;
  message: string;
  retryable: boolean;
  category: RunErrorCategory;
  categoryLabel: string;
}

export interface RunDiagnostics {
  runId: string;
  kind: string;
  state: string;
  promptVersion: string;
  /** Model identifier exactly as configured; never a guessed capability. */
  model: string;
  /** Scheme + host of the endpoint, no path and no query (T030-R06). */
  endpointOrigin: string;
  structuredMode: string;
  tokenField: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /**
   * Provider requests this system actually issued (0..2). Exposed under both
   * names because the UI needs to distinguish "how many times we called" from
   * "how many of those were repairs".
   */
  providerRequestCount: number;
  repairAttempts: number;
  usage: RunUsageView;
  /** How many candidates were actually sent; not the retrieval ceiling. */
  candidateCount: number;
  /** Ids of the sources that were sent, for the "back to the source" entry. */
  candidateIds: string[];
  /** Item or view the run produced, when it produced one. */
  resultRef: string | null;
  subjectId: string | null;
  error: RunDiagnosticsError | null;
  /**
   * Set when ending a request locally cannot be claimed to have stopped the
   * provider from billing it (T041-R04/C05).
   */
  billingNote: string | null;
}

export interface RunDiagnosticsInput {
  runId: string;
  kind: string;
  state: string;
  promptVersion: string;
  startedAt: string;
  finishedAt: string | null;
  attemptCount: number;
  resultRef: string | null;
  subjectId: string | null;
  /** Raw stored usage JSON, or null. Parsed defensively. */
  usage: unknown;
  /** Parsed config snapshot; only allow-listed fields are read. */
  config: { model?: unknown; baseUrlOrigin?: unknown; structuredMode?: unknown; tokenField?: unknown };
  candidateIds: readonly string[];
  error: { code: string; message: string; retryable: boolean } | null;
}

/**
 * States and codes whose local termination does not prove the provider stopped
 * working.
 *
 * A timeout or a dropped connection happens *after* the request left this
 * machine, so the honest statement is "this request may have reached the
 * provider", never "you were not charged". `interrupted` is the same situation
 * seen from the recovery side: the row was swept, not the remote work.
 */
const MAY_HAVE_BEEN_BILLED = new Set<string>([
  'PROVIDER_NETWORK',
  'PROVIDER_TIMEOUT',
  'RUN_INTERRUPTED',
  'interrupted',
]);

const BILLING_NOTE =
  '这次调用是在本机结束的（超时或中断）。请求可能已经到达服务商，' +
  '无法承诺对方一定没有计费，也不能据此推算余额。';

/**
 * Assemble the diagnostics view.
 *
 * Every field is copied explicitly. Nothing is spread from the input, so a
 * column added to `ai_runs` later cannot appear in the DTO (or in the copyable
 * summary built from it) without someone deciding to expose it here.
 */
export function buildRunDiagnostics(input: RunDiagnosticsInput): RunDiagnostics {
  const requestCount = Number.isFinite(input.attemptCount)
    ? Math.max(0, Math.trunc(input.attemptCount))
    : 0;

  const error =
    input.error === null
      ? null
      : {
          code: input.error.code,
          message: input.error.message,
          retryable: input.error.retryable,
          ...(() => {
            const category = classifyRunError(input.error.code);
            return { category, categoryLabel: RUN_ERROR_CATEGORY_LABELS[category] };
          })(),
        };

  const started = Date.parse(input.startedAt);
  const ended = input.finishedAt === null ? Number.NaN : Date.parse(input.finishedAt);
  const durationMs =
    Number.isFinite(started) && Number.isFinite(ended) && ended >= started
      ? ended - started
      : null;

  // The finish reason also decides the billing note: a *successful* run needs no
  // caveat, and a configuration failure never left the machine at all.
  const billingNote =
    requestCount > 0 &&
    (MAY_HAVE_BEEN_BILLED.has(input.state) || MAY_HAVE_BEEN_BILLED.has(error?.code ?? ''))
      ? BILLING_NOTE
      : null;

  return {
    runId: input.runId,
    kind: input.kind,
    state: input.state,
    promptVersion: input.promptVersion,
    model: typeof input.config.model === 'string' ? input.config.model : '',
    endpointOrigin:
      typeof input.config.baseUrlOrigin === 'string' ? input.config.baseUrlOrigin : '（未配置）',
    structuredMode:
      typeof input.config.structuredMode === 'string' ? input.config.structuredMode : '',
    tokenField: typeof input.config.tokenField === 'string' ? input.config.tokenField : '',
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs,
    providerRequestCount: requestCount,
    // One request is the operation itself; anything beyond it can only be the
    // single schema repair the contract allows.
    repairAttempts: Math.max(0, requestCount - 1),
    usage: usageView(input.usage),
    candidateCount: input.candidateIds.length,
    candidateIds: [...input.candidateIds],
    resultRef: input.resultRef,
    subjectId: input.subjectId,
    error,
    billingNote,
  };
}

/**
 * Screen-reader and API name for a run kind, so the UI never invents wording.
 */
export const RUN_KIND_LABELS: Record<string, string> = {
  organize: '整理',
  mindmap: '脑图',
  flow: '流程',
  connection_test: '连接测试',
};

export function runKindLabel(kind: string): string {
  return RUN_KIND_LABELS[kind] ?? kind;
}

/** Display labels for run states, matching the item-status wording style. */
export const RUN_STATE_LABELS: Record<string, string> = {
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  interrupted: '已中断',
  conflict: '已放弃写入',
};

export function runStateLabel(state: string): string {
  return RUN_STATE_LABELS[state] ?? state;
}


