/**
 * Flow intent — the user's observation question (T062).
 *
 * Pure, so the whole "what actually leaves the page when the user presses 生成"
 * decision is unit-testable without a browser, a database or a model. Four rules
 * from the task spec live here rather than in the component, because a component
 * is the one place they cannot be asserted:
 *
 *  1. **The intent is a viewing angle, not a new fact.** It is plain text that
 *     reaches the prompt inside the untrusted-material fence (T062-R01/R03). It
 *     is never compiled into Mermaid, never becomes a node label, and has no
 *     field through which it could ask for "prove this is causal" — the request
 *     body carries exactly four keys (T062-C06).
 *  2. **Empty is refused, never defaulted to `undefined`.** The wire schema is
 *     `intentSchema` = 1..1000 code points, so an empty intent would be a 400
 *     after the user already pressed the button. The check is here instead, and
 *     the form prompts for the text (T062-C02).
 *  3. **Direction is layout, not logic.** `LR`/`TB` is its own validated field,
 *     so switching it cannot touch the material or the edge kinds (T062-R05,
 *     T062-C04).
 *  4. **Composition happens at the click.** `buildFlowGenerationRequest` reads the
 *     draft once, at submit time, and returns a plain body. Editing afterwards
 *     cannot mutate a request that was already sent, and nothing here can write
 *     to a saved View (T062-R02).
 */
import { LIMITS } from './limits';
import type { FlowGenerationRequestInput } from './schemas/http';
import { codePointLength } from './text';

export const FLOW_DIRECTIONS = ['LR', 'TB'] as const;
export type FlowDirection = (typeof FLOW_DIRECTIONS)[number];

/** Layout default from the contract (`direction` defaults to LR). */
export const DEFAULT_FLOW_DIRECTION: FlowDirection = 'LR';

export const FLOW_INTENT_MAX_CODE_POINTS = LIMITS.intentCodePoints;

/**
 * The example text in the input.
 *
 * Phrased as *what to look at* rather than *what to prove*. This is the visible
 * half of T062-R01: a placeholder that reads 「证明 X 一定导致 Y」 would teach the
 * user that the intent is a verdict, and the model would be asked for a
 * conclusion the material may not support.
 */
export const FLOW_INTENT_PLACEHOLDER =
  '例如：这些笔记里哪些步骤是有先后顺序的？哪条是前提、哪条是结果？不确定的地方标成推测。';

/** The sentence under the field, stating what the answer can and cannot contain. */
export const FLOW_INTENT_HINT =
  '这里写的是观察角度，不是要让模型证明的结论。材料没有支持的连接会被标成推测，不会写成已证实的因果。';

/** Shown when the field is submitted empty. */
export const FLOW_INTENT_REQUIRED_MESSAGE = '请先写下想从材料里观察什么关系，再生成流程图';

/**
 * Control characters that must never reach the prompt.
 *
 * C0 controls other than `\n` and tab, plus DEL. They are how a string breaks
 * out of a line in a prompt block, and there is no legitimate use for them in a
 * question typed by hand.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

/**
 * Normalize an intent for the prompt and for length counting.
 *
 * Deterministic on purpose: the same typed text must produce the same
 * `sourceInputHash`, otherwise a re-send of an unchanged request would look like
 * new work and start a second paid call (T054's reason for sorting snapshots).
 */
export function normalizeFlowIntent(raw: string): string {
  return raw
    // CRLF and lone CR first, so the line-based rules below see one newline.
    .replace(/\r\n?/gu, '\n')
    // Control characters already covered by \n and \t become a plain space.
    .replace(CONTROL_CHARS, ' ')
    // Horizontal runs collapse, then the spaces that sit *against* a line break
    // are removed. Without that second step a trailing space stays inside the
    // text that gets hashed, and "same question, one stray space" would look
    // like new work (found by `tests/unit/flow-intent.test.ts`).
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export interface FlowIntentDraft {
  intent: string;
  direction: FlowDirection;
}

/**
 * Field-keyed messages for the form.
 *
 * `requestKey` and `selection` are not inputs on this form; they are carried here
 * so `buildFlowGenerationRequest` has exactly one failure shape. Splitting them
 * into a second result type would mean two error renderings for one button.
 */
export interface FlowIntentErrors {
  intent?: string;
  direction?: string;
  requestKey?: string;
  selection?: string;
}

export interface FlowIntentCheck {
  ok: boolean;
  /** Normalized text: what would actually be sent. Empty when invalid. */
  intent: string;
  direction: FlowDirection;
  errors: FlowIntentErrors;
}

/**
 * Validate one draft.
 *
 * Returns the normalized text rather than mutating the caller's state, so the
 * form can keep showing the user's own characters while the request carries the
 * normalized ones.
 */
export function validateFlowIntent(draft: FlowIntentDraft): FlowIntentCheck {
  const errors: FlowIntentErrors = {};
  const intent = normalizeFlowIntent(draft.intent);

  if (intent.length === 0) {
    errors.intent = FLOW_INTENT_REQUIRED_MESSAGE;
  } else if (codePointLength(intent) > FLOW_INTENT_MAX_CODE_POINTS) {
    errors.intent = `观察问题不能超过 ${FLOW_INTENT_MAX_CODE_POINTS} 个字符（当前 ${codePointLength(intent)} 个）`;
  }

  if (!FLOW_DIRECTIONS.includes(draft.direction)) {
    errors.direction = '方向只能是 LR（从左到右）或 TB（从上到下）';
  }

  const ok = errors.intent === undefined && errors.direction === undefined;
  return {
    ok,
    intent: ok ? intent : '',
    direction: draft.direction,
    errors,
  };
}

/** One node or edge's declared sources is the unit the budget is stated in. */
export interface FlowGenerationRequestBody {
  requestKey: string;
  selection: { mode: 'explicit'; itemIds: string[] };
  intent: string;
  direction: FlowDirection;
}

/**
 * Compile-time guard against drifting from the wire contract.
 *
 * `flowGenerationRequestSchema` (strict) is what the route actually parses. If the
 * contract ever adds or renames a field, this intersection stops being satisfiable
 * and `npm run typecheck` fails here — instead of the user finding out through a
 * 400 after a paid click.
 */
export type FlowGenerationRequestContract = FlowGenerationRequestBody &
  FlowGenerationRequestInput;

export type FlowRequestBuild =
  | { ok: true; body: FlowGenerationRequestContract }
  | { ok: false; errors: FlowIntentErrors };

/**
 * Build the exact body the 生成 button posts.
 *
 * The field set is deliberately small and fixed: there is no `forceCausal`, no
 * `style`, no `mermaid`. A caller that wanted to widen it would have to change
 * `flowGenerationRequestSchema`, which is strict, so an added key is a 400
 * rather than a silently honoured instruction (T062-R03, T063-R06).
 */
export function buildFlowGenerationRequest(input: {
  requestKey: string;
  /** The selected ids, as the selection store holds them. */
  itemIds: readonly string[];
  draft: FlowIntentDraft;
}): FlowRequestBuild {
  const checked = validateFlowIntent(input.draft);
  const errors: FlowIntentErrors = { ...checked.errors };

  const requestKey = input.requestKey.trim();
  if (requestKey.length === 0) errors.requestKey = '缺少请求标识，请重新点击生成';

  const unique: string[] = [];
  for (const id of input.itemIds) {
    if (!unique.includes(id)) unique.push(id);
  }
  if (unique.length === 0) {
    errors.selection = '请先在资料库或收件箱勾选要观察的材料';
  } else if (unique.length > LIMITS.selectedItemsPerProjection) {
    errors.selection = `一次最多观察 ${LIMITS.selectedItemsPerProjection} 条材料，当前选中 ${unique.length} 条`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    body: {
      requestKey,
      selection: { mode: 'explicit', itemIds: unique },
      intent: checked.intent,
      direction: checked.direction,
    },
  };
}

/**
 * Material confirmation (T062-R04).
 *
 * What the user is about to send, stated before they send it: how many records,
 * which of the ids they ticked are gone, and which records the current scope
 * added that they may not have seen. A count alone is not a confirmation — a set
 * that quietly shrank is exactly the case where the flow is built from less than
 * the user believes.
 *
 * `changed` is derived rather than passed, so "the scope moved" cannot be
 * reported by one caller and not another.
 */
export interface FlowMaterialSummary {
  requestedIds: string[];
  resolvedIds: string[];
  count: number;
  limit: number;
  /** Ids the user ticked that no longer resolve. */
  missingIds: string[];
  /** Ids that resolve but were not ticked. */
  addedIds: string[];
  changed: boolean;
  /** True when a generation request built from this scope would be refused. */
  overBudget: boolean;
}

export function summarizeFlowMaterial(input: {
  requestedIds: readonly string[];
  resolvedIds: readonly string[];
  limit?: number;
}): FlowMaterialSummary {
  const limit = input.limit ?? LIMITS.selectedItemsPerProjection;
  const requested = [...new Set(input.requestedIds)];
  const resolved = [...new Set(input.resolvedIds)];
  const resolvedSet = new Set(resolved);
  const requestedSet = new Set(requested);

  const missingIds = requested.filter((id) => !resolvedSet.has(id));
  const addedIds = resolved.filter((id) => !requestedSet.has(id));

  return {
    requestedIds: requested,
    resolvedIds: resolved,
    count: resolved.length,
    limit,
    missingIds,
    addedIds,
    changed: missingIds.length > 0 || addedIds.length > 0,
    overBudget: resolved.length > limit,
  };
}

/** One line for the confirmation panel, or null when there is nothing to warn about. */
export function describeFlowMaterial(summary: FlowMaterialSummary): string | null {
  const parts: string[] = [];
  if (summary.missingIds.length > 0) {
    parts.push(`有 ${summary.missingIds.length} 条已选材料已经被删除，本次不会发送`);
  }
  if (summary.addedIds.length > 0) {
    parts.push(`当前范围比选择多出 ${summary.addedIds.length} 条`);
  }
  if (summary.overBudget) {
    parts.push(`共 ${summary.count} 条，超过单次上限 ${summary.limit} 条`);
  }
  return parts.length > 0 ? parts.join('；') : null;
}

/**
 * The threshold the confirmation panel states about inference.
 *
 * Said out loud because a flow diagram is the shape most likely to be read as a
 * proven chain: the user is told *before* generating that the result may contain
 * hypotheses, and that the material decides whether a causal edge is allowed
 * (T062-R01/R06, T062-C06). The server is still the authority — this sentence
 * only prevents the surprise.
 */
export const FLOW_INFERENCE_NOTICE =
  '材料只能支持相关时，结果会保留为关联或明确标成推测；只有确实存在已确认的因果记录时才会画出因果边。';
