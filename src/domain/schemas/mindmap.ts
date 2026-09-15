/**
 * Mindmap output schema (T055/T056).
 *
 * The boundary between "text a model produced" and "a tree the domain may
 * store". Written to reject rather than coerce, for the same reasons as the
 * organize schema:
 *
 *   - every object is strict, so a model volunteering `revision`, `contentHash`
 *     or an `order` field is rejected instead of having it silently dropped;
 *   - the limits come from `domain/limits`, which is also what the reference
 *     JSON Schema (`reference/schemas/mindmap.schema.json`) and the SQL CHECK
 *     constraints use, so the three cannot drift;
 *   - `itemIds` is non-empty on every node. A node with no source is a fact the
 *     model invented, and the only reason a "topic" can appear in this view is
 *     that material supports it (T055-R02).
 *
 * What this schema deliberately does *not* check: whether the nodes form a tree.
 * Uniqueness, single root, reachability, acyclicity and depth are graph
 * properties that Zod cannot express, and pretending otherwise would let a
 * two-node cycle through as long as each node's fields looked right. Those live
 * in `domain/compileMindmap.ts` (T056-R01).
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
 * Node ids are the *view's* own identifiers, not knowledge UUIDs.
 *
 * A knowledge item may legitimately appear under several topics, so its UUID
 * cannot double as a node id — the id must stay unique inside one projection
 * while `itemIds` repeats across branches (T055-R04).
 */
export const mindmapNodeIdSchema = bounded(LIMITS.mindmapNodeIdCodePoints, '节点 id', 1);

const derivedUuidSchema = z
  .string()
  .refine(
    (value) =>
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u.test(value),
    { message: '来源 id 必须是 UUID' },
  );

export const mindmapKindSchema = z.enum(['group', 'note']);

export const mindmapNodeSchema = z.strictObject({
  id: mindmapNodeIdSchema,
  parentId: mindmapNodeIdSchema.nullable(),
  label: bounded(LIMITS.mindmapLabelCodePoints, '节点标题', 1),
  itemIds: z.array(derivedUuidSchema).min(1).max(LIMITS.selectedItemsPerProjection),
  kind: mindmapKindSchema,
});

export const mindmapOutputSchema = z.strictObject({
  title: bounded(LIMITS.titleCodePoints, '标题', 1),
  nodes: z.array(mindmapNodeSchema).min(1).max(LIMITS.mindmapNodes),
});

export type MindmapNodeOutput = z.infer<typeof mindmapNodeSchema>;
export type MindmapOutput = z.infer<typeof mindmapOutputSchema>;

/**
 * Repair instruction for a malformed mindmap answer (T055-R06, T037-R04).
 *
 * Same shape as the organize repair: re-emit the same tree in the required
 * format. It is not an invitation to add branches — a repair that needed new
 * material is a fresh generation, and letting this path grow the tree would make
 * "one repair attempt" an unbounded rewrite.
 */
export const MINDMAP_REPAIR_INSTRUCTION = [
  '你上一次的输出已经完整返回，但不是合法的 JSON 或字段不符合下面的结构。',
  '请只做格式修复：保留原本的分组意思与来源引用，重新输出一个合法的 JSON 对象。',
  '不要新增材料里没有的分支，不要引用新的来源 id，不要解释，不要 Markdown 代码围栏。',
].join('\n');

/** Compact, bounded description of what went wrong; never the whole answer. */
export function summarizeMindmapSchemaError(error: z.ZodError, maxIssues = 6): string {
  const lines = error.issues.slice(0, maxIssues).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(根对象)';
    return `- ${path}: ${issue.message}`;
  });
  if (error.issues.length > maxIssues) {
    lines.push(`- 另有 ${error.issues.length - maxIssues} 处问题`);
  }
  return lines.join('\n');
}
