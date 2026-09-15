/**
 * Organize output schema (T037).
 *
 * This is the boundary between "text a model produced" and "values the domain
 * may store", so it is written to reject rather than to coerce:
 *
 *   - every object is strict, so a model that volunteers `rawText`, `id` or
 *     `revision` is rejected instead of having those fields quietly dropped
 *     (T038-C03). A model must not be able to rewrite its own input;
 *   - the enums and code-point limits come from the same `domain/limits` the SQL
 *     CHECK constraints use, so a schema here cannot drift from the database;
 *   - `relations` may be empty — forcing at least one relation would manufacture
 *     links the material does not support (T033-C05).
 *
 * Schema validation proves *shape*. It proves nothing about whether a relation is
 * semantically true, so the evidence checks in `parseStructured` and the user's
 * review remain the authority (docs/03_contracts/08 §3).
 */
import { z } from 'zod';

import { ITEM_TYPES, RELATION_TYPES } from '../knowledge';
import { LIMITS } from '../limits';
import { codePointLength } from '../text';

/** Code-point bounded string with a field-specific message. */
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

const uuidLike = z.string().refine(
  (value) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u.test(value),
  { message: 'id 必须是 UUID' },
);

export const organizeEvidenceSchema = z.strictObject({
  itemId: uuidLike,
  // A verbatim contiguous slice of the sender's own text; never a paraphrase.
  quote: bounded(LIMITS.evidenceQuoteCodePoints, '引用', 1),
});

export const organizeRelationSchema = z.strictObject({
  targetId: uuidLike,
  type: z.enum(RELATION_TYPES),
  reason: bounded(LIMITS.relationReasonCodePoints, '理由'),
  score: z.number().min(0).max(1),
  evidence: z.array(organizeEvidenceSchema).min(1).max(LIMITS.relationEvidenceCount),
});

export const organizeOutputSchema = z.strictObject({
  title: bounded(LIMITS.titleCodePoints, '标题', 1),
  summary: bounded(LIMITS.summaryCodePoints, '摘要'),
  type: z.enum(ITEM_TYPES),
  tags: z.array(bounded(LIMITS.tagCodePoints, '标签', 1)).max(LIMITS.tagsPerItem),
  keywords: z.array(bounded(LIMITS.keywordCodePoints, '关键词', 1)).max(LIMITS.keywordsPerItem),
  importance: z.int().min(LIMITS.importanceMin).max(LIMITS.importanceMax),
  relations: z.array(organizeRelationSchema).max(LIMITS.relationsPerOrganize),
});

export type OrganizeOutput = z.infer<typeof organizeOutputSchema>;
export type OrganizeOutputRelation = z.infer<typeof organizeRelationSchema>;

/**
 * What the repair step is asked for (T037-R04).
 *
 * A repair is a *format* fix, so the instruction is explicit that no new content
 * may be invented: the model re-emits the same answer in valid JSON. Anything
 * that needs new material is a fresh organize run, not a repair.
 */
export const REPAIR_INSTRUCTION = [
  '你上一次的输出已经完整返回，但不是合法的 JSON 或字段不符合下面的结构。',
  '请只做格式修复：保留你原本的意思，重新输出一个合法的 JSON 对象。',
  '不要新增原文里没有的内容，不要引用新的资料，不要解释，不要 Markdown 代码围栏。',
].join('\n');

/** Compact, bounded description of what went wrong; never the whole result. */
export function summarizeSchemaError(error: z.ZodError, maxIssues = 6): string {
  const lines = error.issues.slice(0, maxIssues).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(根对象)';
    return `- ${path}: ${issue.message}`;
  });
  if (error.issues.length > maxIssues) {
    lines.push(`- 另有 ${error.issues.length - maxIssues} 处问题`);
  }
  return lines.join('\n');
}
