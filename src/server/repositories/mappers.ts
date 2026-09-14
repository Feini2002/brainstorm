/**
 * Row <-> domain mapping.
 *
 * The database uses snake_case and JSON columns; the application uses camelCase
 * domain objects. This module is the only place that knows about column names,
 * so no UI or service ever reads `tags_json` or `structured_base_raw_version`.
 * Corrupt JSON is reported with the row it came from instead of being silently
 * replaced with an empty value.
 */
import { ERROR_CODES, isErrorCode, type SafeError } from '@/domain/errors';
import {
  MANUAL_FIELDS,
  SOURCE_TYPES,
  ITEM_TYPES,
  type Evidence,
  type ItemDTO,
  type ItemType,
  type ManualField,
  type RelationDTO,
  type RelationType,
  type ReviewStatus,
  type RunDTO,
  type RunKind,
  type RunState,
  type RunUsage,
  type SourceType,
  type UUID,
  type ViewKind,
  type ViewSummaryDTO,
  isStructuredStale,
} from '@/domain/knowledge';
import { RELATION_TYPES, REVIEW_STATUSES, RUN_KINDS, RUN_STATES } from '@/domain/knowledge';

export class RowDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RowDecodeError';
  }
}

function requireString(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new RowDecodeError(`列 ${column} 期望字符串，实际为 ${typeof value}`);
  }
  return value;
}

function requireNumber(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new RowDecodeError(`列 ${column} 期望数字，实际为 ${typeof value}`);
}

function optionalString(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new RowDecodeError(`列 ${column} 期望字符串或 null`);
  }
  return value;
}

function optionalNumber(row: Record<string, unknown>, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new RowDecodeError(`列 ${column} 期望数字或 null`);
}

/** Parse a JSON column, failing loudly with the column name. */
export function parseJsonColumn<T>(row: Record<string, unknown>, column: string): T {
  const text = requireString(row, column);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new RowDecodeError(
      `列 ${column} 不是合法 JSON：${error instanceof Error ? error.message : '解析失败'}`,
    );
  }
}

function assertEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  column: string,
): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new RowDecodeError(`列 ${column} 含未知值：${value}`);
}

function stringArray(value: unknown, column: string): string[] {
  if (!Array.isArray(value)) throw new RowDecodeError(`列 ${column} 期望字符串数组`);
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') throw new RowDecodeError(`列 ${column} 含非字符串元素`);
    result.push(entry);
  }
  return result;
}

export function decodeItemRow(row: Record<string, unknown>, tags: string[]): ItemDTO {
  const manualRaw = stringArray(parseJsonColumn<unknown>(row, 'manual_fields_json'), 'manual_fields_json');
  const manualFields: ManualField[] = [];
  for (const field of manualRaw) {
    if (!(MANUAL_FIELDS as readonly string[]).includes(field)) {
      throw new RowDecodeError(`manual_fields_json 含未知字段：${field}`);
    }
    manualFields.push(field as ManualField);
  }

  const rawVersion = requireNumber(row, 'raw_version');
  const structuredBaseRawVersion = optionalNumber(row, 'structured_base_raw_version');

  return {
    id: requireString(row, 'id'),
    capturedText: requireString(row, 'captured_text'),
    rawText: requireString(row, 'raw_text'),
    rawVersion,
    revision: requireNumber(row, 'revision'),
    structuredBaseRawVersion,
    title: requireString(row, 'title'),
    summary: requireString(row, 'summary'),
    type: assertEnum(requireString(row, 'type'), ITEM_TYPES, 'type') as ItemType,
    tags,
    keywords: stringArray(parseJsonColumn<unknown>(row, 'keywords_json'), 'keywords_json'),
    importance: requireNumber(row, 'importance'),
    manualFields,
    status: assertEnum(requireString(row, 'status'), ['raw', 'processing', 'done', 'error', 'stale'] as const, 'status'),
    lastRunId: optionalString(row, 'last_run_id'),
    error: decodeStoredError(row),
    sourceType: assertEnum(requireString(row, 'source_type'), SOURCE_TYPES, 'source_type') as SourceType,
    sourceRef: optionalString(row, 'source_ref'),
    createdAt: requireString(row, 'created_at'),
    updatedAt: requireString(row, 'updated_at'),
    isStructuredStale: isStructuredStale(structuredBaseRawVersion, rawVersion),
  };
}

/**
 * Item columns for SELECT statements, in a single place.
 *
 * Qualified with `knowledge_items.` for the same reason relation columns are
 * qualified: the tag subquery in `ITEM_WITH_TAGS_SQL` joins `item_tags` and
 * `tags`, and an unqualified `id` there is ambiguous at query time. Every item
 * read path (detail *and* list) must decode the same column set, so the list
 * path can never drift from the detail path — that drift was a real defect
 * (`decodeItemRow` needs `capture_request_id`, which the list query omitted).
 */
export const ITEM_COLUMNS = [
  'knowledge_items.id',
  'knowledge_items.capture_request_id',
  'knowledge_items.capture_request_hash',
  'knowledge_items.captured_text',
  'knowledge_items.raw_text',
  'knowledge_items.raw_version',
  'knowledge_items.revision',
  'knowledge_items.structured_base_raw_version',
  'knowledge_items.title',
  'knowledge_items.summary',
  'knowledge_items.type',
  'knowledge_items.keywords_json',
  'knowledge_items.importance',
  'knowledge_items.manual_fields_json',
  'knowledge_items.status',
  'knowledge_items.last_run_id',
  'knowledge_items.error_code',
  'knowledge_items.error_message',
  'knowledge_items.source_type',
  'knowledge_items.source_ref',
  'knowledge_items.created_at',
  'knowledge_items.updated_at',
].join(', ');

/** Errors are stored as code + message; retryability is contract-derived. */
export function decodeStoredError(row: Record<string, unknown>): SafeError | null {
  const code = optionalString(row, 'error_code');
  if (code === null) return null;
  const message = optionalString(row, 'error_message') ?? '整理失败';
  if (!isErrorCode(code)) {
    // An unknown stored code must not be surfaced as a live contract code.
    return { code: 'INTERNAL', message, retryable: false };
  }
  return { code, message, retryable: ERROR_CODES[code].retryable };
}

export function decodeTagRow(row: Record<string, unknown>): {
  id: UUID;
  label: string;
  normalized: string;
  itemCount: number;
} {
  return {
    id: requireString(row, 'id'),
    label: requireString(row, 'label'),
    normalized: requireString(row, 'normalized'),
    itemCount: requireNumber(row, 'item_count'),
  };
}

export const TAG_COLUMNS = 't.id, t.label, t.normalized';

/**
 * Decode the stored evidence array.
 *
 * The JSON is keyed with the DTO's own camelCase names (`itemId`, `rawVersion`,
 * `quote`) so what is stored and what the API returns are the same shape; the
 * snake_case key is still accepted because a hand-edited or older row may carry
 * it, and rejecting that would lose a real citation for a naming reason.
 */
export function decodeEvidence(json: unknown): Evidence[] {
  if (!Array.isArray(json)) throw new RowDecodeError('evidence 期望数组');
  return json.map((entry) => {
    if (entry === null || typeof entry !== 'object') {
      throw new RowDecodeError('evidence 元素必须是对象');
    }
    const record = entry as Record<string, unknown>;
    const itemId = record.itemId ?? record.item_id;
    if (typeof itemId !== 'string') {
      throw new RowDecodeError('evidence 元素缺少 itemId');
    }
    return {
      itemId,
      rawVersion: requireNumber(record, 'rawVersion'),
      quote: requireString(record, 'quote'),
    };
  });
}

export function decodeRelationRow(
  row: Record<string, unknown>,
  isStale: boolean,
): RelationDTO {
  return {
    id: requireString(row, 'id'),
    sourceId: requireString(row, 'source_id'),
    targetId: requireString(row, 'target_id'),
    type: assertEnum(requireString(row, 'relation_type'), RELATION_TYPES, 'relation_type') as RelationType,
    origin: assertEnum(requireString(row, 'origin'), ['ai', 'manual'] as const, 'origin'),
    reviewStatus: assertEnum(
      requireString(row, 'review_status'),
      REVIEW_STATUSES,
      'review_status',
    ) as ReviewStatus,
    score: optionalNumber(row, 'score'),
    reason: requireString(row, 'reason'),
    evidence: decodeEvidence(parseJsonColumn<unknown>(row, 'evidence_json')),
    sourceRawVersion: requireNumber(row, 'source_raw_version'),
    targetRawVersion: requireNumber(row, 'target_raw_version'),
    revision: requireNumber(row, 'revision'),
    runId: optionalString(row, 'run_id'),
    createdAt: requireString(row, 'created_at'),
    updatedAt: requireString(row, 'updated_at'),
    isStale,
  };
}

/**
 * Relation columns for SELECT statements.
 *
 * Qualified with `r.` because every relation query joins the two endpoint rows,
 * and the endpoint tables also have `id`, `revision` and `created_at` — an
 * unqualified `id` is ambiguous and fails at query time.
 */
export const RELATION_COLUMNS = [
  'r.id',
  'r.source_id',
  'r.target_id',
  'r.relation_type',
  'r.origin',
  'r.review_status',
  'r.score',
  'r.reason',
  'r.evidence_json',
  'r.source_raw_version',
  'r.target_raw_version',
  'r.run_id',
  'r.revision',
  'r.created_at',
  'r.updated_at',
].join(', ');

export function decodeUsage(row: Record<string, unknown>): RunUsage | null {
  const raw = optionalString(row, 'usage_json');
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const pick = (key: string): number | null => {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const usage: RunUsage = {
    inputTokens: pick('inputTokens'),
    outputTokens: pick('outputTokens'),
    totalTokens: pick('totalTokens'),
  };
  if (usage.inputTokens === null && usage.outputTokens === null && usage.totalTokens === null) {
    return null;
  }
  return usage;
}

export function decodeRunRow(row: Record<string, unknown>): RunDTO {
  return {
    id: requireString(row, 'id'),
    kind: assertEnum(requireString(row, 'kind'), RUN_KINDS, 'kind') as RunKind,
    subjectId: optionalString(row, 'subject_id'),
    state: assertEnum(requireString(row, 'state'), RUN_STATES, 'state') as RunState,
    startedAt: requireString(row, 'started_at'),
    deadlineAt: requireString(row, 'deadline_at'),
    finishedAt: optionalString(row, 'finished_at'),
    resultRef: optionalString(row, 'result_ref'),
    error: decodeStoredError(row),
    attemptCount: requireNumber(row, 'attempt_count'),
    promptVersion: requireString(row, 'prompt_version'),
    usage: decodeUsage(row),
  };
}

export const RUN_COLUMNS = [
  'id',
  'request_key',
  'request_hash',
  'kind',
  'subject_id',
  'input_revision',
  'input_hash',
  'state',
  'config_revision',
  'config_snapshot_json',
  'candidate_ids_json',
  'result_ref',
  'error_code',
  'error_message',
  'usage_json',
  'prompt_version',
  'attempt_count',
  'started_at',
  'deadline_at',
  'finished_at',
].join(', ');

export interface ViewRow {
  id: string;
  name: string;
  kind: ViewKind;
  selection_json: string;
  source_snapshot_json: string;
  content_json: string;
  content_hash: string | null;
  renderer_version: string;
  prompt_version: string | null;
  run_id: string | null;
  revision: number;
  generated_at: string | null;
  created_at: string;
  updated_at: string;
}

export function decodeViewRow(row: Record<string, unknown>): ViewRow {
  return {
    id: requireString(row, 'id'),
    name: requireString(row, 'name'),
    kind: assertEnum(requireString(row, 'kind'), ['graph', 'mindmap', 'flow'] as const, 'kind'),
    selection_json: requireString(row, 'selection_json'),
    source_snapshot_json: requireString(row, 'source_snapshot_json'),
    content_json: requireString(row, 'content_json'),
    content_hash: optionalString(row, 'content_hash'),
    renderer_version: requireString(row, 'renderer_version'),
    prompt_version: optionalString(row, 'prompt_version'),
    run_id: optionalString(row, 'run_id'),
    revision: requireNumber(row, 'revision'),
    generated_at: optionalString(row, 'generated_at'),
    created_at: requireString(row, 'created_at'),
    updated_at: requireString(row, 'updated_at'),
  };
}

export const VIEW_COLUMNS = [
  'id',
  'name',
  'kind',
  'selection_json',
  'source_snapshot_json',
  'content_json',
  'content_hash',
  'renderer_version',
  'prompt_version',
  'run_id',
  'revision',
  'generated_at',
  'created_at',
  'updated_at',
].join(', ');

export function decodeViewSummaryRow(row: Record<string, unknown>): ViewSummaryDTO & {
  snapshot: string;
} {
  return {
    id: requireString(row, 'id'),
    name: requireString(row, 'name'),
    kind: assertEnum(requireString(row, 'kind'), ['graph', 'mindmap', 'flow'] as const, 'kind'),
    revision: requireNumber(row, 'revision'),
    generatedAt: optionalString(row, 'generated_at'),
    createdAt: requireString(row, 'created_at'),
    updatedAt: requireString(row, 'updated_at'),
    sourceCount: 0,
    isStale: false,
    missingSourceCount: 0,
    snapshot: requireString(row, 'source_snapshot_json'),
  };
}
