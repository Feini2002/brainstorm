/**
 * Knowledge domain model: enums, DTOs and the one status derivation helper.
 *
 * Everything here is pure data or a pure function — no fs, no window, no Next
 * imports (T003-R01). Field names match reference/contracts/dtos.ts exactly.
 */
import type { SafeError } from './errors';

export type UUID = string;
export type ISODate = string;

export const SOURCE_TYPES = ['chatgpt', 'claude', 'web', 'book', 'myself', 'other'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const DEFAULT_SOURCE_TYPE: SourceType = 'other';

/** Display labels; the UI never invents its own wording for a source. */
export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  chatgpt: 'ChatGPT 对话',
  claude: 'Claude 对话',
  web: '网页',
  book: '书刊',
  myself: '自己的想法',
  other: '其它',
};

export const ITEM_TYPES = [
  'idea',
  'concept',
  'question',
  'decision',
  'quote',
  'todo',
  'observation',
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
export const DEFAULT_ITEM_TYPE: ItemType = 'idea';

/** Display labels for item types. */
export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  idea: '想法',
  concept: '概念',
  question: '问题',
  decision: '决定',
  quote: '摘录',
  todo: '待办',
  observation: '观察',
};

export const ITEM_STATUSES = ['raw', 'processing', 'done', 'error', 'stale'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/**
 * Display labels for item status.
 *
 * Status is never conveyed by colour alone, so every status has a text label
 * (docs/02_architecture/03_ui_information_design.md §1).
 */
export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = {
  raw: '仅保存',
  processing: '整理中',
  done: '已整理',
  error: '整理失败',
  stale: '来源已变化',
};

export const MANUAL_FIELDS = ['title', 'summary', 'type', 'tags', 'keywords', 'importance'] as const;
export type ManualField = (typeof MANUAL_FIELDS)[number];

export const RELATION_TYPES = [
  'similar_to',
  'extends',
  'supports',
  'contradicts',
  'causes',
  'depends_on',
  'example_of',
  'related_to',
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/** Symmetric types store their endpoints sorted by UUID string order. */
export const SYMMETRIC_RELATION_TYPES: readonly RelationType[] = [
  'similar_to',
  'contradicts',
  'related_to',
];

export function isSymmetricRelationType(type: RelationType): boolean {
  return SYMMETRIC_RELATION_TYPES.includes(type);
}

/** Full Chinese display label for a relation type (directional where it matters). */
export const RELATION_TYPE_LABELS: Record<RelationType, string> = {
  similar_to: '相似',
  extends: '延伸',
  supports: '支持',
  contradicts: '矛盾',
  causes: '导致',
  depends_on: '依赖',
  example_of: '例证',
  related_to: '相关',
};

export const REVIEW_STATUSES = ['suggested', 'accepted', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const RELATION_ORIGINS = ['ai', 'manual'] as const;
export type RelationOrigin = (typeof RELATION_ORIGINS)[number];

export const IMPORTANCE_MIN = 1;
export const IMPORTANCE_MAX = 5;
export const DEFAULT_IMPORTANCE = 3;

export interface Evidence {
  itemId: UUID;
  rawVersion: number;
  quote: string;
}

export interface ItemDTO {
  id: UUID;
  capturedText: string;
  rawText: string;
  rawVersion: number;
  revision: number;
  structuredBaseRawVersion: number | null;
  title: string;
  summary: string;
  type: ItemType;
  tags: string[];
  keywords: string[];
  importance: number;
  manualFields: ManualField[];
  status: ItemStatus;
  lastRunId: UUID | null;
  error: SafeError | null;
  sourceType: SourceType;
  sourceRef: string | null;
  createdAt: ISODate;
  updatedAt: ISODate;
  isStructuredStale: boolean;
}

export interface TagDTO {
  id: UUID;
  label: string;
  normalized: string;
  itemCount: number;
}

export interface RelationDTO {
  id: UUID;
  sourceId: UUID;
  targetId: UUID;
  type: RelationType;
  origin: RelationOrigin;
  reviewStatus: ReviewStatus;
  score: number | null;
  reason: string;
  evidence: Evidence[];
  sourceRawVersion: number;
  targetRawVersion: number;
  revision: number;
  runId: UUID | null;
  createdAt: ISODate;
  updatedAt: ISODate;
  isStale: boolean;
}

export interface GraphFilter {
  tagId?: UUID;
  type?: ItemType;
  reviewStatuses?: ReviewStatus[];
  minimumScore?: number;
  includeStale?: boolean;
}

export type SelectionSpec =
  | { mode: 'explicit'; itemIds: UUID[] }
  | { mode: 'filter'; filter: GraphFilter };

export interface SourceSnapshot {
  items: { id: UUID; rawVersion: number; revision: number }[];
  relations: { id: UUID; revision: number }[];
}

export interface GraphContent {
  positions: Record<UUID, { x: number; y: number }>;
  direction: 'LR' | 'TB';
  viewport?: { x: number; y: number; zoom: number };
}

export interface MindmapNode {
  id: string;
  parentId: string | null;
  label: string;
  itemIds: UUID[];
  kind: 'group' | 'note';
}

export interface MindmapContent {
  title: string;
  nodes: MindmapNode[];
}

export type FlowEdgeKind = 'sequence' | 'dependency' | 'association' | 'causal' | 'hypothesis';

export interface FlowNode {
  id: string;
  label: string;
  itemIds: UUID[];
}

export interface FlowEdge {
  source: string;
  target: string;
  kind: FlowEdgeKind;
  label: string;
  itemIds: UUID[];
  relationIds: UUID[];
}

export interface FlowContent {
  title: string;
  direction: 'LR' | 'TB';
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export type ViewKind = 'graph' | 'mindmap' | 'flow';

export interface ViewSummaryDTO {
  id: UUID;
  name: string;
  kind: ViewKind;
  revision: number;
  generatedAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
  sourceCount: number;
  isStale: boolean;
  missingSourceCount: number;
}

export interface ViewBase {
  id: UUID;
  name: string;
  selection: SelectionSpec;
  sourceSnapshot: SourceSnapshot;
  contentHash: string | null;
  rendererVersion: string;
  promptVersion: string | null;
  runId: UUID | null;
  revision: number;
  generatedAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
  isStale: boolean;
  missingSources: UUID[];
}

export type ViewDTO = ViewBase &
  (
    | { kind: 'graph'; content: GraphContent }
    | { kind: 'mindmap'; content: MindmapContent }
    | { kind: 'flow'; content: FlowContent }
  );

export const RUN_KINDS = ['organize', 'mindmap', 'flow', 'connection_test'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATES = ['running', 'succeeded', 'failed', 'interrupted', 'conflict'] as const;
export type RunState = (typeof RUN_STATES)[number];

export interface RunUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface RunDTO {
  id: UUID;
  kind: RunKind;
  subjectId: UUID | null;
  state: RunState;
  startedAt: ISODate;
  deadlineAt: ISODate;
  finishedAt: ISODate | null;
  resultRef: UUID | null;
  error: SafeError | null;
  attemptCount: number;
  promptVersion: string;
  usage: RunUsage | null;
}

export const STRUCTURED_MODES = ['prompt_json', 'json_object'] as const;
export type StructuredMode = (typeof STRUCTURED_MODES)[number];

export const TOKEN_FIELDS = ['none', 'max_tokens', 'max_completion_tokens'] as const;
export type TokenField = (typeof TOKEN_FIELDS)[number];

export interface LlmConfig {
  adapter: 'openai-compatible';
  baseUrl: string;
  model: string;
  structuredMode: StructuredMode;
  tokenField: TokenField;
  maxOutputTokens: number;
  schemaRepairEnabled: boolean;
}

export interface PublicLlmSettings {
  revision: number;
  config: LlmConfig;
  apiKeyConfigured: boolean;
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  adapter: 'openai-compatible',
  baseUrl: '',
  model: '',
  structuredMode: 'prompt_json',
  tokenField: 'none',
  maxOutputTokens: 4096,
  schemaRepairEnabled: false,
};

/** Run record fields the status derivation needs; avoids importing a DB row type. */
export interface ItemStatusRunInput {
  kind: RunKind;
  state: RunState;
  deadlineAt: ISODate;
  error: SafeError | null;
}

/**
 * The single status derivation (docs/03_contracts/03_dto_and_version_rules.md §4).
 * Priority:
 *   1. an unexpired running organize run            -> processing
 *   2. structured base exists and != rawVersion     -> stale
 *   3. versions aligned and a success base exists   -> done
 *   4. no success base, latest run failed-like      -> error
 *   5. otherwise                                    -> raw
 */
export function deriveItemStatus(input: {
  structuredBaseRawVersion: number | null;
  rawVersion: number;
  hasRunHistory: boolean;
  activeRun: ItemStatusRunInput | null;
  lastRun: ItemStatusRunInput | null;
  now: number;
}): ItemStatus {
  const { activeRun } = input;
  if (activeRun && activeRun.state === 'running' && Date.parse(activeRun.deadlineAt) > input.now) {
    return 'processing';
  }

  if (input.structuredBaseRawVersion !== null) {
    if (input.structuredBaseRawVersion !== input.rawVersion) return 'stale';
    return 'done';
  }

  const lastRun = input.lastRun;
  if (
    input.hasRunHistory &&
    lastRun &&
    (lastRun.state === 'failed' || lastRun.state === 'interrupted' || lastRun.state === 'conflict')
  ) {
    return 'error';
  }

  return 'raw';
}

/** True when the structured fields no longer describe the current raw version. */
export function isStructuredStale(
  structuredBaseRawVersion: number | null,
  rawVersion: number,
): boolean {
  return structuredBaseRawVersion !== null && structuredBaseRawVersion !== rawVersion;
}
