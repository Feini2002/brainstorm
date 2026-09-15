/**
 * Flow generation (T063).
 *
 * The same three-phase shape as `organizeItem` and `generateMindmap`, for the same
 * reasons:
 *
 *   1. **register** (short transaction) — replay lookup, lease recovery, the
 *      shared paid-operation slot. Nothing network-shaped happens inside;
 *   2. **provider call** (no transaction) — the database stays writable while a
 *      paid call is in flight;
 *   3. **commit** (short transaction) — re-read every source, compare the whole
 *      snapshot, then write the new View.
 *
 * What is specific to a flow is the *evidence gate* between those last two steps.
 * The model returns five kinds of edge, and only one of them — `causal` — asserts
 * that something made something else happen. That claim is checked against the
 * relation table, not against the model's confidence: a `causal` edge must cite an
 * accepted, non-stale `causes` relation whose endpoints fall inside the two nodes'
 * sources, and anything short of that is **downgraded to a hypothesis** and
 * reported (T063-R02, T063-C01). Downgrading rather than rejecting is deliberate:
 * the material may well be worth drawing, and the honest outcome is a dashed
 * "推测" edge instead of a failed generation or a fabricated fact.
 *
 * Relations are read here rather than through `captureSources` because the prompt
 * needs more than an id and a revision: the model has to see each relation's type,
 * review status and staleness to know what it is allowed to cite as causal, and
 * `validateFlow` needs the same objects to enforce it. One read serves both.
 *
 * A failed generation never touches an existing View: the commit is the only
 * writer, and it only ever inserts.
 */
import 'server-only';

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { AppError, type SafeError } from '@/domain/errors';
import { validateFlow } from '@/domain/flow';
import type { ItemDTO, FlowContent, RelationDTO, SelectionSpec, UUID, ViewDTO } from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import { attemptTimeoutMs, canStartAttempt } from '@/domain/run';
import {
  FLOW_REPAIR_INSTRUCTION,
  flowOutputSchema,
  readFlowNodeCount,
  summarizeFlowSchemaError,
} from '@/domain/schemas/flow';
import { sourceInputHash } from '@/domain/sourceSnapshot';
import { FLOW_PROMPT_VERSION, validateViewName } from '@/domain/view';
import { bumpDatasetRevision, withTransaction } from '@/server/db/database';
import {
  OpenAICompatibleAdapter,
  assertConfigured,
  configSnapshot,
  type LLMAdapter,
} from '@/server/llm/adapter';
import { buildRepairMessages } from '@/server/llm/parseStructured';
import { buildFlowMessages, estimateFlowCodePoints } from '@/server/llm/prompts/flow';
import { assertBoundedJsonShape, parseModelJson } from '@/server/llm/protocol';
import type { LlmCallSnapshot } from '@/server/llm/types';
import { logSafe } from '@/server/observability/redaction';
import { listRelations } from '@/server/repositories/relations';
import {
  completeRun,
  finishRun,
  getRun,
  getRunInputHash,
  incrementAttemptCount,
} from '@/server/repositories/runs';
import { nowIso } from '@/server/repositories/shared';
import { insertView } from '@/server/repositories/views';
import { findReplayRun, registerRun, runRequestHash } from './runs/registerRun';
import { assertWithinBudget, captureSources, type CapturedSources } from './views/captureSources';
import { getView, viewContentHash } from './views/views';

export interface GenerateFlowInput {
  requestKey: UUID;
  selection: SelectionSpec;
  /** The user's observation question. Required: an empty intent is refused earlier. */
  intent: string;
  /** Layout choice only. It never changes which edges the model may draw. */
  direction: 'LR' | 'TB';
  /** Becomes the view's name; the model's own title is kept as the content title. */
  name?: string;
  config: LlmCallSnapshot;
  configRevision: number;
  schemaRepairEnabled: boolean;
  adapter?: LLMAdapter;
}

export interface GenerateFlowResult {
  runId: UUID;
  viewId: UUID | null;
  state: 'succeeded' | 'conflict' | 'failed';
  view: ViewDTO | null;
  warnings: string[];
  replayed: boolean;
  /** Ids the user selected that no longer exist (T054-R01). */
  missingSourceIds: UUID[];
}

export async function generateFlow(
  db: DatabaseSync,
  input: GenerateFlowInput,
): Promise<GenerateFlowResult> {
  // Configuration is checked first: it is the one failure that must cost no run
  // row, no slot and no request.
  assertConfigured(input.config);

  // ---- Capture: re-read the material from the database --------------------
  let estimatedCodePoints = 0;
  const captured = captureSources(db, {
    selection: input.selection,
    estimateCodePoints: (items) => {
      // Measured with the relations block included, because for a flow that block
      // is not overhead — it is the evidence the model is asked to cite.
      const { relations } = readRelationContext(db, items);
      estimatedCodePoints = estimateFlowCodePoints(
        '',
        [
          { label: 'SELECTED ITEMS', text: items.map((item) => briefText(item)).join('\n\n') },
          {
            label: 'RELATIONS',
            text: relations.map((relation) => briefRelation(relation)).join('\n\n'),
          },
        ],
      );
      return estimatedCodePoints;
    },
  });

  // An empty or over-budget selection is refused here, before a run exists.
  assertWithinBudget(captured.budget);

  const { relationsById } = readRelationContext(db, captured.items);

  const inputHash = sourceInputHash({
    kind: 'flow',
    promptVersion: FLOW_PROMPT_VERSION,
    // The direction participates in the input hash because it is written into the
    // stored `FlowContent`: re-sending the same request key with the other
    // direction is different work, not a replay of the same work. The selection
    // itself is nested rather than spread so the two cannot be confused for one
    // another by a later reader.
    selection: { selection: input.selection, direction: input.direction },
    intent: input.intent,
    snapshot: captured.snapshot,
  });

  const fingerprint = {
    kind: 'flow' as const,
    subjectId: null,
    inputRevision: null,
    inputHash,
    selectionItemIds: captured.items.map((item) => item.id),
    intent: input.intent,
    configRevision: input.configRevision,
    promptVersion: FLOW_PROMPT_VERSION,
  };

  // A replay is resolved before anything else so a re-sent request is answered
  // from history without a second paid call.
  const replay = findReplayRun(db, {
    requestKey: input.requestKey,
    requestHash: runRequestHash(fingerprint),
  });
  if (replay) return replayFlowOutcome(db, replay.id);

  // ---- Step 1: register (short transaction; no network inside) ------------
  const registered = registerRun(db, {
    ...fingerprint,
    requestKey: input.requestKey,
    configSnapshot: configSnapshot(input.config),
    candidateIds: captured.items.map((item) => item.id),
  });
  if (!registered.shouldExecute) return replayFlowOutcome(db, registered.run.id);

  const runId = registered.run.id;

  // ---- Step 2: provider call (no transaction held) ------------------------
  let content: string;
  let usageJson: string | null;
  try {
    const attempt = runAttempt(db, runId, registered.run.startedAt);
    const first = await callModel(input, captured.items, relationsById, attempt);
    content = first.content;
    usageJson = first.usageJson;
  } catch (error) {
    throw terminalizeFailure(db, runId, error);
  }

  let outcome = parseFlowOutput(content, captured, relationsById);

  // One repair, only for a complete-but-malformed answer, only with time left.
  if (!outcome.ok && outcome.repairable && input.schemaRepairEnabled) {
    const repair = await attemptRepair(db, runId, input, content, outcome.detail ?? '');
    if (repair !== null) {
      content = repair.content;
      usageJson = mergeUsage(usageJson, repair.usageJson);
      outcome = parseFlowOutput(content, captured, relationsById);
    }
  }

  if (!outcome.ok || !outcome.content) {
    throw terminalizeFailure(
      db,
      runId,
      new AppError(
        outcome.errorCode ?? 'STRUCTURED_INVALID',
        outcome.errorMessage ?? '模型返回的内容无法组成流程图',
      ),
    );
  }

  // ---- Step 3: commit (one short transaction) -----------------------------
  return commitFlow(db, {
    runId,
    inputHash,
    captured,
    content: outcome.content,
    name: input.name,
    intent: input.intent,
    usageJson,
    compilerWarnings: outcome.warnings,
  });
}

interface AttemptInfo {
  startedAt: string;
  deadlineAt: string;
  attemptCount: number;
}

function runAttempt(db: DatabaseSync, runId: UUID, startedAt: string): AttemptInfo {
  const run = getRun(db, runId);
  const count = incrementAttemptCount(db, runId);
  if (count === null) {
    throw new AppError('RUN_INTERRUPTED', '这次生成已经结束或超出尝试次数，请重新发起');
  }
  return { startedAt, deadlineAt: run.deadlineAt, attemptCount: count };
}

/**
 * The relations the model may cite, keyed by id.
 *
 * Filtered to those *between* the selected items, with rejected ones included so
 * the prompt can say a relation exists but was rejected. A relation with one
 * endpoint outside the selection describes material the model was never shown.
 */
function readRelationContext(
  db: DatabaseSync,
  items: readonly ItemDTO[],
): { relations: RelationDTO[]; relationsById: Map<string, RelationDTO> } {
  const selected = new Set(items.map((item) => item.id));
  const relations = listRelations(db, { includeStale: true, includeRejected: true }).filter(
    (relation) => selected.has(relation.sourceId) && selected.has(relation.targetId),
  );
  return { relations, relationsById: new Map(relations.map((relation) => [relation.id, relation])) };
}

async function callModel(
  input: GenerateFlowInput,
  items: readonly ItemDTO[],
  relationsById: ReadonlyMap<string, RelationDTO>,
  attempt: AttemptInfo,
): Promise<{ content: string; usageJson: string | null }> {
  const adapter = input.adapter ?? new OpenAICompatibleAdapter();

  const prompt = buildFlowMessages({
    sources: items.map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      tags: item.tags,
      rawText: item.rawText,
      type: item.type,
    })),
    relations: [...relationsById.values()].map((relation) => ({
      id: relation.id,
      sourceId: relation.sourceId,
      targetId: relation.targetId,
      type: relation.type,
      reviewStatus: relation.reviewStatus,
      isStale: relation.isStale,
      reason: relation.reason,
    })),
    intent: input.intent,
    direction: input.direction,
  });

  const timeoutMs = attemptTimeoutMs(
    LIMITS.providerCallTimeoutMs,
    attempt.startedAt,
    LIMITS.operationDeadlineMs,
    Date.now(),
  );
  if (timeoutMs <= 0) {
    throw new AppError('PROVIDER_TIMEOUT', '本次操作已经没有剩余时间');
  }

  const completion = await adapter.complete({
    config: input.config,
    messages: prompt.messages,
    timeoutMs,
  });

  logSafe({
    level: 'info',
    message: 'flow.request_sent',
    count: items.length,
    stage: `${prompt.estimatedCodePoints}cp/${relationsById.size}rel/${input.direction}`,
  });

  return {
    content: completion.content,
    usageJson: completion.usage === null ? null : JSON.stringify(completion.usage),
  };
}

async function attemptRepair(
  db: DatabaseSync,
  runId: UUID,
  input: GenerateFlowInput,
  previousContent: string,
  detail: string,
): Promise<{ content: string; usageJson: string | null } | null> {
  const run = getRun(db, runId);
  const decision = canStartAttempt({
    attemptCount: run.attemptCount,
    maxAttempts: LIMITS.maxAttemptCount,
    operationStartedAt: run.startedAt,
    operationDeadlineMs: LIMITS.operationDeadlineMs,
    now: Date.now(),
  });
  if (!decision.allowed) return null;

  const count = incrementAttemptCount(db, runId);
  if (count === null) return null;

  try {
    const adapter = input.adapter ?? new OpenAICompatibleAdapter();
    const timeoutMs = attemptTimeoutMs(
      LIMITS.providerCallTimeoutMs,
      run.startedAt,
      LIMITS.operationDeadlineMs,
      Date.now(),
    );
    if (timeoutMs <= 0) return null;

    const completion = await adapter.complete({
      config: input.config,
      messages: buildRepairMessages(FLOW_REPAIR_INSTRUCTION, previousContent, detail),
      timeoutMs,
    });
    return {
      content: completion.content,
      usageJson: completion.usage === null ? null : JSON.stringify(completion.usage),
    };
  } catch (error) {
    // A failed repair is not a new failure class: the original parse failure
    // stands, and the run keeps the first error classification.
    logSafe({ level: 'warn', message: 'flow.repair_failed', runId, code: safeCode(error) });
    return null;
  }
}

interface FlowOutcome {
  ok: boolean;
  content?: FlowContent;
  /** Sources actually referenced by the accepted document, for the snapshot. */
  usedItemIds: UUID[];
  warnings: string[];
  errorCode?: SafeError['code'];
  errorMessage?: string;
  repairable: boolean;
  detail?: string;
}

/**
 * Validate a model answer: bounded bytes -> JSON -> shape -> strict schema ->
 * structure and evidence.
 *
 * The evidence stage is the reason this is not just `parseStructured`, and the
 * reason it is not merely a schema: a flow that parses is not yet a flow whose
 * arrows are honest. `validateFlow` is the authority on the two things JSON Schema
 * cannot say — "these endpoints are nodes in this document" and "this causal claim
 * is backed by an accepted relation" — and it is called with exactly the captured
 * selection and the relation set the prompt was given, so a citation of material
 * the model never saw is refused rather than stored (T063-C04/C05).
 */
export function parseFlowOutput(
  content: string,
  captured: CapturedSources,
  relationsById: ReadonlyMap<string, RelationDTO>,
): FlowOutcome {
  let parsed: unknown;
  try {
    parsed = parseModelJson(content);
  } catch (error) {
    return {
      ok: false,
      repairable: true,
      usedItemIds: [],
      warnings: [],
      errorCode: 'STRUCTURED_INVALID',
      errorMessage: '模型返回的内容不是合法 JSON，可以尝试一次格式修复',
      detail: error instanceof Error ? error.message : '解析失败',
    };
  }

  try {
    assertBoundedJsonShape(parsed);
  } catch (error) {
    return {
      ok: false,
      repairable: false,
      usedItemIds: [],
      warnings: [],
      errorCode: 'STRUCTURED_INVALID',
      errorMessage: '模型输出的结构过于复杂，已放弃解析',
      detail: error instanceof Error ? error.message : '结构不合法',
    };
  }

  // The node count is checked before the strict schema so the user gets the number
  // and the limit instead of 「字段不符合要求」. A repair cannot help here: too many
  // nodes re-emits the same oversized document.
  const nodeCount = readFlowNodeCount(parsed);
  if (nodeCount !== null && nodeCount > LIMITS.flowNodes) {
    return {
      ok: false,
      repairable: false,
      usedItemIds: [],
      warnings: [],
      errorCode: 'STRUCTURED_INVALID',
      errorMessage: `模型返回的流程图有 ${nodeCount} 个节点，超过上限 ${LIMITS.flowNodes}，已拒绝保存`,
      detail: `nodes 长度 ${nodeCount} > ${LIMITS.flowNodes}`,
    };
  }

  const schemaResult = flowOutputSchema.safeParse(parsed);
  if (!schemaResult.success) {
    return {
      ok: false,
      repairable: true,
      usedItemIds: [],
      warnings: [],
      errorCode: 'STRUCTURED_INVALID',
      errorMessage: '模型返回的字段不符合要求，可以尝试一次格式修复',
      detail: summarizeFlowSchemaError(schemaResult.error),
    };
  }

  const allowedItemIds = new Set(captured.items.map((item) => item.id));
  const validated = validateFlow({
    raw: schemaResult.data,
    allowedItemIds,
    relationsById,
  });
  if (!validated.ok || !validated.content) {
    return {
      ok: false,
      repairable: true,
      usedItemIds: [],
      warnings: [],
      errorCode: 'STRUCTURED_INVALID',
      errorMessage: `模型返回的结构不是合法的流程图：${validated.issues[0]?.message ?? '结构不合法'}`,
      detail: validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join('；'),
    };
  }

  const warnings: string[] = [];
  if (validated.downgradedCausal > 0) {
    // The central honesty rule made visible. The user asked for a flow, the model
    // claimed a cause, and the material did not back it — so the edge is drawn as
    // a guess and the reason is stated rather than left to be discovered.
    warnings.push(
      `有 ${validated.downgradedCausal} 条边声称因果，但材料里没有已确认的 causes 关系支持，已改成明确标注的推测边`,
    );
  }

  const used = new Set<string>();
  for (const node of validated.content.nodes) for (const id of node.itemIds) used.add(id);
  for (const edge of validated.content.edges) for (const id of edge.itemIds) used.add(id);
  const unused = captured.items.filter((item) => !used.has(item.id));
  if (unused.length > 0) {
    warnings.push(`有 ${unused.length} 条选中资料没有被放进这张流程图`);
  }

  return {
    ok: true,
    content: validated.content,
    usedItemIds: [...used],
    warnings,
    repairable: false,
  };
}

interface CommitFlowInput {
  runId: UUID;
  inputHash: string;
  captured: CapturedSources;
  content: FlowContent;
  name: string | undefined;
  intent: string;
  usageJson: string | null;
  compilerWarnings: string[];
}

function commitFlow(db: DatabaseSync, input: CommitFlowInput): GenerateFlowResult {
  const now = nowIso();

  const result = withTransaction(db, () => {
    // Late responses are discarded: if recovery already interrupted this run, or
    // another generation took over, this response must not write anything.
    const run = getRun(db, input.runId);
    const liveHash = getRunInputHash(db, input.runId);
    if (run.state !== 'running' || liveHash !== input.inputHash) {
      return { kind: 'discarded' as const };
    }

    // Re-read every source and compare the *whole* snapshot. A flow's entire basis
    // is the selection plus the relations between them, so any drift makes this a
    // conflict — and for a flow there is a second reason to be strict: a relation
    // that moved may have been the evidence for a causal edge, which means the
    // stored picture could claim a cause that is no longer established.
    const live = captureSources(db, {
      selection: { mode: 'explicit', itemIds: input.captured.items.map((item) => item.id) },
    });
    const before = new Map(
      input.captured.snapshot.items.map((entry) => [
        entry.id,
        { rawVersion: entry.rawVersion, revision: entry.revision },
      ]),
    );
    const after = new Map(
      live.snapshot.items.map((entry) => [
        entry.id,
        { rawVersion: entry.rawVersion, revision: entry.revision },
      ]),
    );

    const changedItemIds = [...before.keys()].filter((id) => {
      const previous = before.get(id)!;
      const current = after.get(id);
      return (
        current === undefined ||
        current.rawVersion !== previous.rawVersion ||
        current.revision !== previous.revision
      );
    });

    const beforeRelations = new Map(
      input.captured.snapshot.relations.map((entry) => [entry.id, entry.revision]),
    );
    const afterRelations = new Map(live.snapshot.relations.map((entry) => [entry.id, entry.revision]));
    const changedRelationIds = [...beforeRelations.keys()].filter(
      (id) => afterRelations.get(id) !== beforeRelations.get(id),
    );

    if (changedItemIds.length > 0 || changedRelationIds.length > 0) {
      finishRun(
        db,
        input.runId,
        'conflict',
        {
          code: 'SOURCE_CHANGED',
          message: `生成期间有 ${changedItemIds.length + changedRelationIds.length} 处来源发生变化，旧流程图没有被覆盖`,
          retryable: true,
        },
        now,
      );
      return {
        kind: 'changed' as const,
        changedCount: changedItemIds.length + changedRelationIds.length,
      };
    }

    const viewName = resolveViewName(input.content.title, input.name);
    const snapshot = input.captured.snapshot;
    const id = randomUUID();

    insertView(db, {
      id,
      name: viewName,
      kind: 'flow',
      selection: { mode: 'explicit', itemIds: input.captured.items.map((item) => item.id) },
      sourceSnapshot: snapshot,
      content: input.content,
      promptVersion: FLOW_PROMPT_VERSION,
      contentHash: viewContentHash({
        kind: 'flow',
        content: input.content,
        sourceSnapshot: snapshot,
        promptVersion: FLOW_PROMPT_VERSION,
      }),
      runId: input.runId,
      generatedAt: now,
      now,
    });

    completeRun(db, {
      id: input.runId,
      inputHash: input.inputHash,
      resultRef: id,
      usage: input.usageJson,
      finishedAt: now,
    });

    bumpDatasetRevision(db);
    return { kind: 'committed' as const, viewId: id, viewName };
  });

  if (result.kind === 'discarded') {
    return {
      runId: input.runId,
      viewId: null,
      state: 'conflict',
      view: null,
      warnings: ['这次响应到达时运行已经结束，结果被丢弃，没有写入任何内容'],
      replayed: false,
      missingSourceIds: [],
    };
  }

  if (result.kind === 'changed') {
    return {
      runId: input.runId,
      viewId: null,
      state: 'conflict',
      view: null,
      warnings: [
        `生成期间有 ${result.changedCount} 处来源发生变化，本次没有保存新流程图，旧图保持原样`,
      ],
      replayed: false,
      missingSourceIds: [],
    };
  }

  const warnings = [...input.compilerWarnings];
  if (input.captured.missingItemIds.length > 0) {
    warnings.push(
      `有 ${input.captured.missingItemIds.length} 条选中的资料已经不存在，本次流程图只覆盖仍然存在的来源`,
    );
  }
  // The direction is recorded in the content and only there; saying so on the
  // result would be a second copy of a field the view already holds.

  return {
    runId: input.runId,
    viewId: result.viewId,
    state: 'succeeded',
    view: loadView(db, result.viewId),
    warnings,
    replayed: false,
    missingSourceIds: input.captured.missingItemIds,
  };
}

/** The user's own name wins; otherwise a valid name derived from the title. */
function resolveViewName(title: string, requested: string | undefined): string {
  if (requested !== undefined && validateViewName(requested) === null) return requested.trim();
  const trimmed = title.trim();
  if (trimmed.length > 0 && validateViewName(trimmed) === null) return trimmed;
  return '未命名流程图';
}

function loadView(db: DatabaseSync, id: UUID): ViewDTO | null {
  try {
    return getView(db, id);
  } catch {
    // The View was deleted after the run succeeded, or the stored content no
    // longer assembles. The run's history is still the truth about what happened,
    // so this reports "no view" rather than failing the replay.
    return null;
  }
}

/** Report a stored run without issuing a new provider request. */
function replayFlowOutcome(db: DatabaseSync, runId: UUID): GenerateFlowResult {
  const run = getRun(db, runId);
  if (run.state === 'running') {
    throw new AppError('RUN_BUSY', '这次生成还在进行中，请等待它结束');
  }

  const succeeded = run.state === 'succeeded' && run.resultRef !== null;
  const view = succeeded ? loadView(db, run.resultRef!) : null;

  return {
    runId,
    viewId: run.resultRef,
    state: succeeded ? 'succeeded' : run.state === 'conflict' ? 'conflict' : 'failed',
    view,
    warnings: [
      succeeded
        ? view
          ? '这次生成与上一次请求完全相同，直接复用已有流程图，没有重新请求模型'
          : '上一次生成的结果视图已被删除，这里只报告运行历史，不会重新生成'
        : `上一次生成没有成功：${run.error?.message ?? '未知原因'}`,
    ],
    replayed: true,
    missingSourceIds: [],
  };
}

function terminalizeFailure(db: DatabaseSync, runId: UUID, error: unknown): AppError {
  const safe = safeError(error);
  finishRun(db, runId, 'failed', safe, nowIso());
  return new AppError(safe.code, safe.message);
}

function safeError(error: unknown): SafeError {
  if (error instanceof AppError) return error.toSafeError();
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : '本地服务出现未预期错误',
    retryable: false,
  };
}

function safeCode(error: unknown): string {
  return error instanceof AppError ? error.code : 'INTERNAL';
}

/** Merge usage from the first attempt and the repair attempt, summing tokens. */
function mergeUsage(first: string | null, second: string | null): string | null {
  if (first === null) return second;
  if (second === null) return first;
  const a = JSON.parse(first) as Record<string, number | null>;
  const b = JSON.parse(second) as Record<string, number | null>;
  const add = (key: string): number | null => {
    const left = a[key];
    const right = b[key];
    if (typeof left !== 'number' && typeof right !== 'number') return null;
    return (typeof left === 'number' ? left : 0) + (typeof right === 'number' ? right : 0);
  };
  return JSON.stringify({
    inputTokens: add('inputTokens'),
    outputTokens: add('outputTokens'),
    totalTokens: add('totalTokens'),
  });
}

/** One source's contribution to the prompt, mirrored from the prompt builder. */
function briefText(item: ItemDTO): string {
  return [
    `id: ${item.id}`,
    `类型: ${item.type}`,
    `标题: ${item.title}`,
    `摘要: ${item.summary}`,
    `标签: ${item.tags.join('、')}`,
    '原文片段:',
    Array.from(item.rawText).slice(0, 400).join(''),
  ].join('\n');
}

/** One relation's contribution, mirrored from the prompt builder. */
function briefRelation(relation: RelationDTO): string {
  return [
    `relationId: ${relation.id}`,
    `type: ${relation.type}`,
    `source: ${relation.sourceId}`,
    `target: ${relation.targetId}`,
    `reviewStatus: ${relation.reviewStatus}`,
    `isStale: ${relation.isStale ? 'true' : 'false'}`,
    `理由: ${relation.reason}`,
  ].join('\n');
}
