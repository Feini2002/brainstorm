/**
 * Mindmap generation (T055).
 *
 * The same three-phase shape as `organizeItem`, for the same reasons:
 *
 *   1. **register** (short transaction) — replay lookup, lease recovery, the
 *      shared slot. Nothing network-shaped happens inside;
 *   2. **provider call** (no transaction) — the database stays writable while a
 *      paid call is in flight, so saving notes and rendering pages keep working;
 *   3. **commit** (short transaction) — re-read every source, compare the whole
 *      snapshot, then write the new View.
 *
 * The one place this differs from organize, and the difference is the contract's
 * (docs/03_contracts/06 §3): a mindmap's *entire* basis is the selection, so if
 * any selected item's `rawVersion`/`revision` moved — or any relation between
 * them changed — the whole generation is a conflict. Organize treats a changed
 * candidate as "drop the relation that used it"; there is no equivalent here,
 * because there is no part of the output that is unaffected by the material it
 * was organized from. The old View is left exactly as it was.
 *
 * A failed generation never touches an existing View: the commit is the only
 * writer, and it only ever inserts.
 */
import 'server-only';

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { AppError, type SafeError } from '@/domain/errors';
import { LIMITS } from '@/domain/limits';
import type { ItemDTO, MindmapContent, SelectionSpec, UUID, ViewDTO } from '@/domain/knowledge';
import { MINDMAP_COMPILER_VERSION, validateMindmap } from '@/domain/compileMindmap';
import type { MindmapOutput } from '@/domain/schemas/mindmap';
import {
  MINDMAP_REPAIR_INSTRUCTION,
  mindmapOutputSchema,
  summarizeMindmapSchemaError,
} from '@/domain/schemas/mindmap';
import { attemptTimeoutMs, canStartAttempt } from '@/domain/run';
import { MINDMAP_PROMPT_VERSION, validateViewName } from '@/domain/view';
import { withTransaction, bumpDatasetRevision } from '@/server/db/database';
import {
  OpenAICompatibleAdapter,
  assertConfigured,
  configSnapshot,
  type LLMAdapter,
} from '@/server/llm/adapter';
import { buildRepairMessages } from '@/server/llm/parseStructured';
import { assertBoundedJsonShape, parseModelJson } from '@/server/llm/protocol';
import { buildMindmapMessages, estimateMindmapCodePoints } from '@/server/llm/prompts/mindmap';
import type { LlmCallSnapshot } from '@/server/llm/types';
import { logSafe } from '@/server/observability/redaction';
import {
  completeRun,
  finishRun,
  getRun,
  getRunInputHash,
  incrementAttemptCount,
} from '@/server/repositories/runs';
import { insertView } from '@/server/repositories/views';
import { nowIso } from '@/server/repositories/shared';
import { captureSources, assertWithinBudget, type CapturedSources } from './views/captureSources';
import { lookupReplayRun, registerRun, runIntentHash } from './runs/registerRun';
import { getView, viewContentHash } from './views/views';
import { sourceInputHash } from '@/domain/sourceSnapshot';

export interface GenerateMindmapInput {
  requestKey: UUID;
  selection: SelectionSpec;
  intent?: string;
  /** Becomes the view's name; the model's own title is kept as the AST title. */
  name?: string;
  config: LlmCallSnapshot;
  configRevision: number;
  schemaRepairEnabled: boolean;
  adapter?: LLMAdapter;
}

export interface GenerateMindmapResult {
  runId: UUID;
  viewId: UUID | null;
  state: 'succeeded' | 'conflict' | 'failed';
  view: ViewDTO | null;
  warnings: string[];
  replayed: boolean;
  /**
   * Ids the user selected that no longer exist. Reported rather than ignored: the
   * generated map covers what remained, and the user needs to know it is not the
   * whole set they thought they picked (T054-R01).
   */
  missingSourceIds: UUID[];
}

export async function generateMindmap(
  db: DatabaseSync,
  input: GenerateMindmapInput,
): Promise<GenerateMindmapResult> {
  const intentHash = runIntentHash({
    kind: 'mindmap',
    subjectId: null,
    expectedRevision: null,
    selection: input.selection,
    intent: input.intent ?? null,
    promptVersion: MINDMAP_PROMPT_VERSION,
  });

  const replay = lookupReplayRun(db, { requestKey: input.requestKey, intentHash });
  if (replay.status === 'hit' || replay.status === 'unconfirmed') {
    const outcome = replayMindmapOutcome(db, replay.run.id);
    if (replay.status === 'unconfirmed') {
      outcome.warnings.unshift('旧运行身份无法重新确认，已返回历史结果，没有重新请求模型');
    }
    return outcome;
  }

  assertConfigured(input.config);

  // ---- Capture: re-read the material from the database --------------------
  //
  // `estimateCodePoints` is handed the total the prompt builder will actually
  // produce, so the budget is measured on the real outbound payload rather than
  // on raw text alone. It is computed once, from the same shape the prompt uses.
  let estimatedCodePoints = 0;
  const captured = captureSources(db, {
    selection: input.selection,
    estimateCodePoints: (items) => {
      estimatedCodePoints = estimateMindmapCodePoints(
        '',
        items.map((item) => ({ label: `ITEM ${item.id}`, text: briefText(item) })),
      );
      return estimatedCodePoints;
    },
  });

  // An empty or over-budget selection is refused here, before a run exists.
  assertWithinBudget(captured.budget);

  const inputHash = sourceInputHash({
    kind: 'mindmap',
    promptVersion: MINDMAP_PROMPT_VERSION,
    selection: input.selection,
    intent: input.intent ?? null,
    snapshot: captured.snapshot,
  });

  const fingerprint = {
    kind: 'mindmap' as const,
    subjectId: null,
    inputRevision: null,
    inputHash,
    selectionItemIds: captured.items.map((item) => item.id),
    ...(input.intent !== undefined ? { intent: input.intent } : {}),
    configRevision: input.configRevision,
    promptVersion: MINDMAP_PROMPT_VERSION,
  };

  // ---- Step 1: register (short transaction; no network inside) ------------
  const registered = registerRun(db, {
    ...fingerprint,
    requestKey: input.requestKey,
    requestIntentHash: intentHash,
    configSnapshot: configSnapshot(input.config),
    candidateIds: captured.items.map((item) => item.id),
  });
  if (!registered.shouldExecute) return replayMindmapOutcome(db, registered.run.id);

  const runId = registered.run.id;

  // ---- Step 2: provider call (no transaction held) ------------------------
  let content: string;
  let usageJson: string | null;
  try {
    const attempt = runAttempt(db, runId, registered.run.startedAt);
    const first = await callModel(input, captured.items, captured.snapshot, attempt, input.intent);
    content = first.content;
    usageJson = first.usageJson;
  } catch (error) {
    throw terminalizeFailure(db, runId, error);
  }

  let outcome = parseMindmapOutput(content, captured);

  // One repair, only for a complete-but-malformed answer, only with time left.
  if (!outcome.ok && outcome.repairable && input.schemaRepairEnabled) {
    const repair = await attemptRepair(db, runId, input, content, outcome.detail ?? '');
    if (repair !== null) {
      content = repair.content;
      usageJson = mergeUsage(usageJson, repair.usageJson);
      outcome = parseMindmapOutput(content, captured);
    }
  }

  if (!outcome.ok || !outcome.content) {
    throw terminalizeFailure(
      db,
      runId,
      new AppError(
        outcome.errorCode ?? 'STRUCTURED_INVALID',
        outcome.errorMessage ?? '模型返回的内容无法组成脑图',
      ),
    );
  }

  // ---- Step 3: commit (one short transaction) -----------------------------
  return commitMindmap(db, {
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

async function callModel(
  input: GenerateMindmapInput,
  items: readonly ItemDTO[],
  snapshot: CapturedSources['snapshot'],
  attempt: AttemptInfo,
  intent: string | undefined,
): Promise<{ content: string; usageJson: string | null }> {
  const adapter = input.adapter ?? new OpenAICompatibleAdapter();

  const prompt = buildMindmapMessages({
    sources: items.map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      tags: item.tags,
      rawText: item.rawText,
      type: item.type,
    })),
    ...(intent !== undefined && intent.trim().length > 0 ? { intent } : {}),
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

  // Record what was actually sent for diagnostics: the prompt estimator is only
  // an estimate, and a mismatch between it and the builder is exactly what makes
  // a budget bug diagnosable after the fact.
  logSafe({
    level: 'info',
    message: 'mindmap.request_sent',
    count: items.length,
    stage: `${prompt.estimatedCodePoints}cp/${snapshot.relations.length}rel`,
  });

  return {
    content: completion.content,
    usageJson: completion.usage === null ? null : JSON.stringify(completion.usage),
  };
}

async function attemptRepair(
  db: DatabaseSync,
  runId: UUID,
  input: GenerateMindmapInput,
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
      messages: buildRepairMessages(MINDMAP_REPAIR_INSTRUCTION, previousContent, detail),
      timeoutMs,
    });
    return {
      content: completion.content,
      usageJson: completion.usage === null ? null : JSON.stringify(completion.usage),
    };
  } catch (error) {
    // A failed repair is not a new failure class: the original parse failure
    // stands, and the run keeps the first error classification.
    logSafe({ level: 'warn', message: 'mindmap.repair_failed', runId, code: safeCode(error) });
    return null;
  }
}

interface MindmapOutcome {
  ok: boolean;
  content?: MindmapContent;
  /** Sources actually referenced by the accepted tree, for the snapshot. */
  usedItemIds: UUID[];
  warnings: string[];
  correctedNodeIds: string[];
  errorCode?: SafeError['code'];
  errorMessage?: string;
  repairable: boolean;
  detail?: string;
}

/**
 * Validate a model answer: bounded bytes -> JSON -> shape -> strict schema ->
 * tree structure -> source provenance.
 *
 * The structural stage is the reason this is not just `parseStructured`: a mindmap
 * that parses is not yet a tree, and the failure modes past this point (cycles,
 * missing parents, unreachable subtrees) are exactly the ones that would make a
 * renderer loop or silently drop a branch.
 */
export function parseMindmapOutput(content: string, captured: CapturedSources): MindmapOutcome {
  let parsed: unknown;
  try {
    parsed = parseModelJson(content);
  } catch (error) {
    return {
      ok: false,
      repairable: true,
      usedItemIds: [],
      warnings: [],
      correctedNodeIds: [],
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
      correctedNodeIds: [],
      errorCode: 'STRUCTURED_INVALID',
      errorMessage: '模型输出的结构过于复杂，已放弃解析',
      detail: error instanceof Error ? error.message : '结构不合法',
    };
  }

  // Node count is checked *before* the strict schema so the user gets the number
  // and the limit. The schema's `max(120)` is the real guard, but its message is
  // "字段不符合要求", which tells the user nothing about what to change — and the
  // domain validator's count check is unreachable while the schema rejects first
  // (T055-C05). Reading `nodes.length` here is safe: `assertBoundedJsonShape`
  // already bounded the structure.
  const nodeCount = readNodeCount(parsed);
  if (nodeCount !== null && nodeCount > LIMITS.mindmapNodes) {
    return {
      ok: false,
      // Too many nodes is not a syntax problem, so a repair re-emits the same
      // oversized tree and fails again. Refused outright.
      repairable: false,
      usedItemIds: [],
      warnings: [],
      correctedNodeIds: [],
      errorCode: 'STRUCTURED_INVALID',
      errorMessage: `模型返回的脑图有 ${nodeCount} 个节点，超过上限 ${LIMITS.mindmapNodes}，已拒绝保存`,
      detail: `nodes 长度 ${nodeCount} > ${LIMITS.mindmapNodes}`,
    };
  }

  const schemaResult = mindmapOutputSchema.safeParse(parsed);
  if (!schemaResult.success) {
    return {
      ok: false,
      repairable: true,
      usedItemIds: [],
      warnings: [],
      correctedNodeIds: [],
      errorCode: 'STRUCTURED_INVALID',
      errorMessage: '模型返回的字段不符合要求，可以尝试一次格式修复',
      detail: summarizeMindmapSchemaError(schemaResult.error),
    };
  }

  // `allowedItemIds` is exactly the captured selection. Anything else is a
  // citation of material the model was never shown (T055-C02).
  const allowedItemIds = new Set(captured.items.map((item) => item.id));
  const validated = validateMindmap(schemaResult.data as MindmapOutput, { allowedItemIds });
  if (!validated.ok || !validated.content) {
    return {
      ok: false,
      repairable: true,
      usedItemIds: [],
      warnings: [],
      correctedNodeIds: [],
      errorCode: 'STRUCTURED_INVALID',
      errorMessage: `模型返回的结构不是合法的脑图：${validated.errors[0]?.message ?? '结构不合法'}`,
      detail: validated.errors.map((error) => error.message).join('；'),
    };
  }

  const warnings: string[] = [];
  if (validated.correctedNodeIds.length > 0) {
    // The server recomputed these groups' sources. Saying so is the difference
    // between a faithful projection and one that quietly rewrote the model.
    warnings.push(
      `${validated.correctedNodeIds.length} 个分组节点的来源已按实际子树重算，模型给出的合并集合没有直接采用`,
    );
  }

  // Sources the tree never ended up citing are worth stating: the user selected
  // material and should know it did not appear, rather than assume it did.
  const used = new Set(validated.referencedItemIds);
  const unused = captured.items.filter((item) => !used.has(item.id));
  if (unused.length > 0) {
    warnings.push(`有 ${unused.length} 条选中资料没有被放进这张脑图`);
  }

  return {
    ok: true,
    content: validated.content,
    usedItemIds: validated.referencedItemIds,
    warnings,
    correctedNodeIds: validated.correctedNodeIds,
    repairable: false,
  };
}

interface CommitMindmapInput {
  runId: UUID;
  inputHash: string;
  captured: CapturedSources;
  content: MindmapContent;
  name: string | undefined;
  intent: string | undefined;
  usageJson: string | null;
  compilerWarnings: string[];
}

function commitMindmap(db: DatabaseSync, input: CommitMindmapInput): GenerateMindmapResult {
  const now = nowIso();

  const result = withTransaction(db, () => {
    // Late responses are discarded: if recovery already interrupted this run, or
    // another generation took over, this response must not write anything.
    const run = getRun(db, input.runId);
    const liveHash = getRunInputHash(db, input.runId);
    if (run.state !== 'running' || liveHash !== input.inputHash) {
      return { kind: 'discarded' as const };
    }

    // Re-read every source and compare the *whole* snapshot. Any drift in any
    // selected item or any relation between them makes this a conflict: the map's
    // entire basis is the selection, so there is no partial result that would be
    // honest to keep (docs/03_contracts/06 §3).
    const live = captureSources(db, { selection: { mode: 'explicit', itemIds: input.captured.items.map((item) => item.id) } });
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
          message: `生成期间有 ${changedItemIds.length + changedRelationIds.length} 处来源发生变化，旧脑图没有被覆盖`,
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
      kind: 'mindmap',
      selection: { mode: 'explicit', itemIds: input.captured.items.map((item) => item.id) },
      sourceSnapshot: snapshot,
      content: input.content,
      promptVersion: MINDMAP_PROMPT_VERSION,
      contentHash: viewContentHash({
        kind: 'mindmap',
        content: input.content,
        sourceSnapshot: snapshot,
        promptVersion: MINDMAP_PROMPT_VERSION,
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
        `生成期间有 ${result.changedCount} 处来源发生变化，本次没有保存新脑图，旧脑图保持原样`,
      ],
      replayed: false,
      missingSourceIds: [],
    };
  }

  const warnings = [...input.compilerWarnings];
  if (input.captured.missingItemIds.length > 0) {
    warnings.push(
      `有 ${input.captured.missingItemIds.length} 条选中的资料已经不存在，本次脑图只覆盖仍然存在的来源`,
    );
  }

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
  return '未命名脑图';
}

function loadView(db: DatabaseSync, id: UUID): ViewDTO | null {
  try {
    return getView(db, id);
  } catch {
    // The View was deleted after the run succeeded. The run's history is still
    // the truth about what happened, so this reports "no view" rather than
    // failing the replay.
    return null;
  }
}

/** Report a stored run without issuing a new provider request. */
function replayMindmapOutcome(db: DatabaseSync, runId: UUID): GenerateMindmapResult {
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
          ? '这次生成与上一次请求完全相同，直接复用已有脑图，没有重新请求模型'
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

/** `nodes.length`, or null when the parsed value has no such array. */
function readNodeCount(parsed: unknown): number | null {
  if (parsed === null || typeof parsed !== 'object') return null;
  const nodes = (parsed as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? nodes.length : null;
}

export { MINDMAP_COMPILER_VERSION };
