/**
 * Structured output parsing and the one allowed repair (T037).
 *
 * The order here is the contract's (docs/03_contracts/06_llm_pipeline.md §5) and
 * each step exists because skipping it is a real failure mode:
 *
 *   byte cap -> JSON.parse only -> shape bound -> Zod strict -> business checks
 *
 * `JSON.parse` is the only evaluator: no `eval`, no `Function`, no YAML loader,
 * so a response containing executable text cannot run (T037-R02). A fence is
 * stripped only when it wraps the *whole* content; prose with two JSON objects
 * inside fails instead of having one arbitrarily chosen (T037-C01/C02).
 *
 * The repair path is deliberately narrow. It is offered only for a complete
 * answer that failed on syntax or schema, and only when there is time left in the
 * *operation* budget (T037-C05). Truncation, refusal, empty output and provider
 * errors are terminal — rewriting JSON cannot fix them (T037-R05).
 */
import 'server-only';

import type { z } from 'zod';

import { AppError, type SafeError } from '@/domain/errors';
import { LIMITS } from '@/domain/limits';
import type { UUID } from '@/domain/knowledge';
import { utf8ByteLength } from '@/domain/text';
import {
  organizeOutputSchema,
  summarizeSchemaError,
  type OrganizeOutput,
} from '@/domain/schemas/organize';
import { assertBoundedJsonShape, parseModelJson, StructuredParseError } from './protocol';

/** Sentence-shaped tool result: what happened, plus whether a repair may help. */
export interface ParseOutcome {
  ok: boolean;
  value?: OrganizeOutput;
  error?: SafeError;
  /** True when a repair attempt is a legitimate next step. */
  repairable: boolean;
  /** Bounded description used in both the log and the repair message. */
  detail?: string;
}

/**
 * Business validation shared by first and repair attempts (T037-R03).
 *
 * Three checks the schema cannot express:
 *   - `targetId` must be one of the candidates actually sent, so a model cannot
 *     connect to an item it was never shown and a hallucinated id cannot become
 *     a relation (T039-R01);
 *   - evidence ids must be the target or a known candidate;
 *   - duplicate `(targetId, type)` pairs are dropped, and the relation cap is
 *     applied after dedup so five *distinct* relations is the real limit.
 */
export interface BusinessValidationContext {
  targetId: UUID;
  candidateIds: readonly UUID[];
}

export interface BusinessValidationResult {
  value: OrganizeOutput;
  /** Relations removed by dedup or unknown id; reported, never silent. */
  droppedRelations: number;
}

export function applyBusinessValidation(
  parsed: OrganizeOutput,
  context: BusinessValidationContext,
): BusinessValidationResult {
  const allowedIds = new Set<string>([context.targetId, ...context.candidateIds]);

  const seenPairs = new Set<string>();
  const kept: OrganizeOutput['relations'] = [];
  let dropped = 0;

  for (const relation of parsed.relations) {
    // The server decides the source endpoint; a relation must point at a real
    // candidate from *this* selection, never at an item the model was not shown.
    if (relation.targetId === context.targetId || !allowedIds.has(relation.targetId)) {
      dropped += 1;
      continue;
    }
    const unknownEvidence = relation.evidence.some(
      (evidence) => !allowedIds.has(evidence.itemId),
    );
    if (unknownEvidence) {
      dropped += 1;
      continue;
    }

    // Duplicates are collapsed by (target, type) *after* the id checks, so the
    // relation cap counts distinct suggestions rather than repeated ones.
    const key = `${relation.targetId}\u0000${relation.type}`;
    if (seenPairs.has(key)) {
      dropped += 1;
      continue;
    }
    seenPairs.add(key);

    if (kept.length >= LIMITS.relationsPerOrganize) {
      dropped += 1;
      continue;
    }
    kept.push(relation);
  }

  return {
    value: { ...parsed, relations: kept },
    droppedRelations: dropped,
  };
}

export interface ParseStructuredInput {
  content: string;
  context: BusinessValidationContext;
}

/** Validate one model answer. Never throws for a malformed answer. */
export function parseStructured(input: ParseStructuredInput): ParseOutcome {
  // 1. Byte cap before parsing: a 40 MB body must not reach JSON.parse.
  const bytes = utf8ByteLength(input.content);
  if (bytes > LIMITS.modelResponseBytes) {
    return {
      ok: false,
      repairable: false,
      error: {
        code: 'STRUCTURED_INVALID',
        message: '模型输出超过可接受大小，请缩小材料范围',
        retryable: false,
      },
      detail: `响应 ${bytes} 字节，超过上限 ${LIMITS.modelResponseBytes}`,
    };
  }

  // 2. JSON.parse only, with a fence stripped only when it wraps everything.
  let parsed: unknown;
  try {
    parsed = parseModelJson(input.content);
  } catch (error) {
    const detail = error instanceof AppError ? error.message : '解析失败';
    return {
      ok: false,
      repairable: error instanceof StructuredParseError,
      error: {
        code: 'STRUCTURED_INVALID',
        message: '模型返回的内容不是合法 JSON，可以尝试一次格式修复',
        retryable: true,
      },
      detail,
    };
  }

  // 3. Bounded shape, then strict schema.
  try {
    assertBoundedJsonShape(parsed);
  } catch (error) {
    return {
      ok: false,
      repairable: false,
      error: {
        code: 'STRUCTURED_INVALID',
        message: '模型输出的结构过于复杂，已放弃解析',
        retryable: false,
      },
      detail: error instanceof Error ? error.message : '结构不合法',
    };
  }

  const schemaResult = organizeOutputSchema.safeParse(parsed);
  if (!schemaResult.success) {
    return {
      ok: false,
      // A complete but wrong-shaped answer is exactly what a repair can fix.
      repairable: true,
      error: {
        code: 'STRUCTURED_INVALID',
        message: '模型返回的字段不符合要求，可以尝试一次格式修复',
        retryable: true,
      },
      detail: summarizeSchemaError(schemaResult.error),
    };
  }

  // 4. Business validation.
  const validated = applyBusinessValidation(schemaResult.data, input.context);
  return { ok: true, value: validated.value, repairable: false };
}

/**
 * The repair message (T037-R04).
 *
 * It carries the original answer verbatim plus a minimal error summary. It does
 * *not* carry new candidate material or new notes: a repair that needed extra
 * context would be a different operation, and adding material here would let a
 * failed run quietly grow its own context.
 */
export function buildRepairMessages(
  instruction: string,
  previousContent: string,
  errorDetail: string,
): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: `${instruction}\n\n输出结构再确认一次：\n${errorDetail}` },
    {
      role: 'user',
      content: [
        '下面是你上一次的输出（仅作修复用，不要另找资料）：',
        '<<<PREVIOUS OUTPUT>>>',
        previousContent.slice(0, LIMITS.modelResponseBytes),
        '<<<END PREVIOUS OUTPUT>>>',
        '请按系统消息要求重新输出合法的 JSON。',
      ].join('\n'),
    },
  ];
}

export { organizeOutputSchema };
export type { OrganizeOutput };
export type OrganizeSchema = typeof organizeOutputSchema;
export type InferOrganize = z.infer<OrganizeSchema>;
