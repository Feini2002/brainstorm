/**
 * Flow output schema (T063).
 *
 * The boundary between "JSON a model produced" and "a projection the domain may
 * store". Same choice as the mindmap and organize schemas: strict everywhere, so a
 * model volunteering `direction`, `title`, `relationIds` on a node, or its own
 * `kind` vocabulary is *rejected* rather than having the extra field quietly
 * dropped. Model-controlled fields are exactly the ones a later layer would
 * otherwise start trusting.
 *
 * The limits come from `domain/limits`, which is also what the reference JSON
 * Schema (`reference/schemas/flow.schema.json`), the SQL CHECK constraints and the
 * prompt's own numbers use — so the four cannot drift apart.
 *
 * What this schema deliberately does **not** check, because Zod cannot express it:
 * whether the edge endpoints are nodes in the same document, whether the cited
 * `itemIds`/`relationIds` are inside this run's selection, and whether a `causal`
 * edge is justified by a matching relation or by cited material. Those are graph
 * and evidence properties, and they live in `domain/flow.ts` (`validateFlow`).
 */
import { z } from 'zod';

import { LIMITS } from '../limits';
import { codePointLength } from '../text';

function bounded(max: number, label: string, min = 0) {
  return z
    .string()
    .refine((value) => codePointLength(value) >= min, {
      message: `${label}至少 ${min} 个字符`,
    })
    .refine((value) => codePointLength(value) <= max, {
      message: `${label}不能超过 ${max} 个字符`,
    });
}

/**
 * A node id is the *view's* own short identifier, never a knowledge UUID.
 *
 * Same reason as the mindmap: one note may appear in several nodes, so its UUID
 * cannot double as a node id. The bound matches `FLOW_NODE_ID_MAX` in
 * `domain/flow.ts`, which re-checks it because the domain validator is also the
 * path taken by fixtures and hand-written rows.
 */
export const flowNodeIdSchema = bounded(LIMITS.mindmapNodeIdCodePoints, '节点 id', 1);

/**
 * A UUID-shaped string.
 *
 * Deliberately *shape* only: whether the id names a selected item is a provenance
 * question, and the answer lives in `validateFlow` where the allowed set is known.
 * A schema that tried to answer it here would have to be handed the selection,
 * which is how provenance checks end up duplicated in two places.
 */
const uuidLike = z.string().refine(
  (value) =>
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u.test(value),
  { message: 'id 必须是 UUID' },
);

/** The five semantic kinds, in the contract's order. */
export const flowEdgeKindSchema = z.enum([
  'sequence',
  'dependency',
  'association',
  'causal',
  'hypothesis',
]);

export const flowNodeSchema = z.strictObject({
  id: flowNodeIdSchema,
  label: bounded(LIMITS.flowLabelCodePoints, '节点文字', 1),
  itemIds: z.array(uuidLike).min(1).max(LIMITS.selectedItemsPerProjection),
});

export const flowEdgeSchema = z.strictObject({
  source: flowNodeIdSchema,
  target: flowNodeIdSchema,
  kind: flowEdgeKindSchema,
  // Required, not optional: an arrow with no stated relation is precisely the
  // "arrow implies causation" shape the contract forbids (§3). A model that cannot
  // say what the connection is must not draw it.
  label: bounded(LIMITS.flowLabelCodePoints, '边说明', 1),
  itemIds: z.array(uuidLike).min(1).max(LIMITS.selectedItemsPerProjection),
  relationIds: z.array(uuidLike).max(8),
});

export const flowOutputSchema = z.strictObject({
  title: bounded(LIMITS.titleCodePoints, '标题', 1),
  direction: z.enum(['LR', 'TB']),
  nodes: z.array(flowNodeSchema).min(1).max(LIMITS.flowNodes),
  // Empty is allowed and expected: material that supports no ordering produces a
  // plain list of records rather than invented arrows (T062-R06, T063-R02).
  edges: z.array(flowEdgeSchema).max(LIMITS.flowEdges),
});

export type FlowNodeOutput = z.infer<typeof flowNodeSchema>;
export type FlowEdgeOutput = z.infer<typeof flowEdgeSchema>;
export type FlowOutput = z.infer<typeof flowOutputSchema>;

/**
 * Repair instruction for a malformed flow answer (T063-R06, T037-R04).
 *
 * Same shape as the mindmap repair: re-emit the same document in the required
 * format. The wording is explicit that a repair adds no connections, because
 * "make it valid" is otherwise an invitation to satisfy the schema by inventing an
 * edge — which is the one edit this pipeline must never make on the model's behalf.
 */
export const FLOW_REPAIR_INSTRUCTION = [
  '你上一次的输出已经完整返回，但不是合法的 JSON 或字段不符合下面的结构。',
  '请只做格式修复：保留原本的节点、边和它们引用的来源 id，重新输出一个合法的 JSON 对象。',
  '不要新增节点或连接，不要引用新的来源或关系 id，不要改变边类型，不要解释，不要 Markdown 代码围栏。',
].join('\n');

/** Compact, bounded description of what went wrong; never the whole answer. */
export function summarizeFlowSchemaError(error: z.ZodError, maxIssues = 6): string {
  const lines = error.issues.slice(0, maxIssues).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(根对象)';
    return `- ${path}: ${issue.message}`;
  });
  if (error.issues.length > maxIssues) {
    lines.push(`- 另有 ${error.issues.length - maxIssues} 处问题`);
  }
  return lines.join('\n');
}

/**
 * The node count read off a *parsed but unvalidated* value.
 *
 * Called before the strict schema so the user gets the number and the limit. The
 * schema's own `max(40)` is the real guard, but its message is 「字段不符合要求」,
 * which tells the user nothing about what to change — the same reasoning the
 * mindmap parser documents for its node count.
 */
export function readFlowNodeCount(parsed: unknown): number | null {
  if (parsed === null || typeof parsed !== 'object') return null;
  const nodes = (parsed as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? nodes.length : null;
}
