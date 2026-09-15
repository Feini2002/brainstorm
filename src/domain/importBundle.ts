/**
 * Bundle validation: the one place a backup file is judged (T071).
 *
 * This module is pure — no db, no fs, no request — so the same rules run in
 * `/api/import/validate` and again inside the import transaction (T072-R01).
 * That duplication is deliberate and required: validation and commit happen at
 * different times, and a file that was acceptable then must be re-judged against
 * the *current* library rather than trusted because a client said "already
 * checked".
 *
 * Design decisions worth stating, because each rejects a tempting alternative:
 *
 *   - **Unknown fields are errors, not warnings.** `z.strictObject` throughout
 *     (R02). A permissive parse would silently drop a field a newer version
 *     wrote — the user would "successfully" restore a backup that lost data,
 *     which is the failure that is hardest to notice and impossible to undo.
 *   - **Relations and view sources are treated differently on purpose.** Every
 *     relation endpoint must exist in the bundle, because a dangling edge is
 *     unrenderable and the live database's foreign keys guarantee it cannot
 *     happen. A view's `sourceSnapshot` may name a deleted item and that is
 *     legal *and common* — a note can be deleted while the map that cites it
 *     survives. Rejecting that would make real libraries unexportable, which the
 *     contract calls out explicitly.
 *   - **Nothing is written here** (R05). The function reads the target database
 *     only to answer "is this library empty", and returns a report.
 *
 * Reports carry a path per problem (`data.relations[2].targetId`) so a user can
 * find the offending record in a large JSON file without opening a debugger.
 */
import { z } from 'zod';

import { LIMITS } from './limits';
import { BACKUP_SCHEMA_VERSION, countBundle, type BundleCounts } from './exportBundle';
import { hashCanonical } from './hash';
import {
  ITEM_TYPES,
  MANUAL_FIELDS,
  RELATION_ORIGINS,
  RELATION_TYPES,
  REVIEW_STATUSES,
  SOURCE_TYPES,
  isSymmetricRelationType,
  type RelationType,
} from './knowledge';
import { codePointString } from './schemas/http';

// ---------------------------------------------------------------------------
// Leaf schemas
// ---------------------------------------------------------------------------

const uuid = z.uuid();
const isoDate = z.iso.datetime();

/**
 * Text length uses code points, matching every other schema in the project.
 *
 * `z.string().max(n)` counts UTF-16 units, so it would reject a 10000-emoji note
 * that the database accepts (SQLite `length()` counts characters) — a backup of
 * a legal library failing its own validation check.
 */
const itemText = codePointString(LIMITS.rawTextCodePoints, 1);
const title = codePointString(LIMITS.titleCodePoints);
const summary = codePointString(LIMITS.summaryCodePoints);
const keyword = codePointString(LIMITS.keywordCodePoints, 1);
const evidenceQuote = codePointString(LIMITS.evidenceQuoteCodePoints);
const tagLabel = codePointString(LIMITS.tagCodePoints, 1);
const reason = codePointString(LIMITS.relationReasonCodePoints);
const viewName = codePointString(LIMITS.viewNameCodePoints, 1);
const sourceRef = codePointString(LIMITS.sourceRefCodePoints);

// ---------------------------------------------------------------------------
// Entity schemas — exactly the fields export writes, nothing more
// ---------------------------------------------------------------------------

const backupItemSchema = z.strictObject({
  id: uuid,
  captureRequestId: uuid,
  captureRequestHash: z.string().regex(/^[0-9a-f]{64}$/),
  capturedText: itemText,
  rawText: itemText,
  rawVersion: z.int().min(1),
  revision: z.int().min(1),
  structuredBaseRawVersion: z.int().min(1).nullable(),
  title,
  summary,
  type: z.enum(ITEM_TYPES),
  keywords: z.array(keyword).max(LIMITS.keywordsPerItem),
  importance: z.int().min(LIMITS.importanceMin).max(LIMITS.importanceMax),
  manualFields: z.array(z.enum(MANUAL_FIELDS)).max(MANUAL_FIELDS.length),
  sourceType: z.enum(SOURCE_TYPES),
  /**
   * Length is checked but the value is not treated as a URL to fetch: the
   * contract forbids reading remote files during import (R05), so this is
   * storage, never a request target.
   */
  sourceRef: sourceRef.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

const backupTagSchema = z.strictObject({
  id: uuid,
  label: tagLabel,
  normalized: tagLabel,
  createdAt: isoDate,
});

const backupItemTagSchema = z.strictObject({
  itemId: uuid,
  tagId: uuid,
  /** The schema caps a note at eight tags, positions 0..7. */
  position: z.int().min(0).max(7),
});

const evidenceSchema = z.strictObject({
  itemId: uuid,
  rawVersion: z.int().min(1),
  // Same cap as the live relation API, so an import cannot smuggle a longer
  // citation than a normal organize run could produce.
  quote: evidenceQuote,
});

const backupRelationSchema = z.strictObject({
  id: uuid,
  sourceId: uuid,
  targetId: uuid,
  type: z.enum(RELATION_TYPES),
  origin: z.enum(RELATION_ORIGINS),
  reviewStatus: z.enum(REVIEW_STATUSES),
  score: z.number().min(0).max(1).nullable(),
  reason,
  evidence: z.array(evidenceSchema),
  sourceRawVersion: z.int().min(1),
  targetRawVersion: z.int().min(1),
  revision: z.int().min(1),
  createdAt: isoDate,
  updatedAt: isoDate,
});

/**
 * View `content` stays opaque here.
 *
 * Each view kind has its own validator (`mindmap.ts`, `flow.ts`,
 * `compileMindmap.ts`) and re-implementing them would create a second, drifting
 * definition of a legal tree. `importKnowledge` hands the content to those
 * compilers through the normal generation path, so an invalid tree is caught by
 * the same code that guards live generation.
 */
const backupViewSchema = z.strictObject({
  id: uuid,
  name: viewName,
  kind: z.enum(['graph', 'mindmap', 'flow']),
  selection: z.union([
    z.strictObject({ mode: z.literal('explicit'), itemIds: z.array(uuid) }),
    z.strictObject({
      mode: z.literal('filter'),
      filter: z.strictObject({
        tagId: uuid.optional(),
        type: z.enum(ITEM_TYPES).optional(),
        reviewStatuses: z.array(z.enum(REVIEW_STATUSES)).optional(),
        minimumScore: z.number().min(0).max(1).optional(),
        includeStale: z.boolean().optional(),
      }),
    }),
  ]),
  sourceSnapshot: z.strictObject({
    items: z.array(
      z.strictObject({ id: uuid, rawVersion: z.int().min(1), revision: z.int().min(1) }),
    ),
    relations: z.array(z.strictObject({ id: uuid, revision: z.int().min(1) })),
  }),
  content: z.unknown(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  rendererVersion: codePointString(LIMITS.viewNameCodePoints, 1),
  promptVersion: codePointString(LIMITS.viewNameCodePoints, 1).nullable(),
  generatedAt: isoDate.nullable(),
  revision: z.int().min(1),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export const backupBundleSchema = z.strictObject({
  /**
   * A literal, not `z.int()`. T071-R02 requires refusing a future version rather
   * than degrading: parsing loosely here would accept schemaVersion 2 and drop
   * whatever fields it added.
   */
  schemaVersion: z.literal(BACKUP_SCHEMA_VERSION),
  exportedAt: isoDate,
  data: z.strictObject({
    knowledgeItems: z.array(backupItemSchema).max(LIMITS.importItemsMax),
    tags: z.array(backupTagSchema),
    itemTags: z.array(backupItemTagSchema),
    relations: z.array(backupRelationSchema).max(LIMITS.importRelationsMax),
    views: z.array(backupViewSchema).max(LIMITS.importViewsMax),
  }),
});

export type ValidatedBundle = z.infer<typeof backupBundleSchema>;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ValidationProblem {
  /** JSON path of the offending field, e.g. `data.relations[2].targetId`. */
  path: string;
  /** Short, safe-to-display reason; never echoes note text. */
  message: string;
}

export interface ImportValidationReport {
  valid: boolean;
  recordCounts: BundleCounts;
  bundleHash: string;
  /** Non-fatal observations: legal but worth telling the user before they commit. */
  warnings: string[];
  errors: ValidationProblem[];
}

/** True when the target library holds no knowledge entities (R04). */
export interface TargetLibraryState {
  items: number;
  relations: number;
  views: number;
  tags: number;
  itemTags: number;
}

export function isTargetEmpty(state: TargetLibraryState): boolean {
  // `tags`/`itemTags` count toward emptiness on purpose. A library with orphan
  // tags but no notes is rare, and treating it as empty would mean restoring
  // into a database that already has a competing tag vocabulary — the same
  // `normalized` label would have two ids and one of them would win arbitrarily.
  return (
    state.items === 0 && state.relations === 0 && state.views === 0 && state.tags === 0 && state.itemTags === 0
  );
}

/** Statuses a restored item can be derived into. Never `processing` or `error`. */
export const IMPORT_STATUSES = ['raw', 'done', 'stale'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/**
 * Derive an item's status from its version fields after a restore.
 *
 * A restored item has no run behind it, so only three outcomes are honest:
 *
 *   - no structured base           -> `raw`  (nothing has described it yet)
 *   - base matches `rawVersion`    -> `done` (the structured fields are current)
 *   - base lags behind             -> `stale` (the note was edited after the pass)
 *
 * `processing` is excluded because no run is running, and `error` is excluded
 * because a failure belongs to a run — importing one would show a failure the
 * user cannot retry or dismiss, attributed to nothing. This mirrors the
 * precedence in `deriveItemStatus` (docs/03_contracts/03_dto_and_version_rules.md
 * §4) with the run-dependent branches removed, rather than re-deriving status in
 * the import service where it could drift from the live rule.
 */
export function deriveImportStatus(
  structuredBaseRawVersion: number | null,
  rawVersion: number,
): ImportStatus {
  if (structuredBaseRawVersion === null) return 'raw';
  return structuredBaseRawVersion === rawVersion ? 'done' : 'stale';
}

export const EMPTY_TARGET: TargetLibraryState = {
  items: 0,
  relations: 0,
  views: 0,
  tags: 0,
  itemTags: 0,
};

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

/** Format a Zod issue path into the dotted/bracketed form users can search. */
function issuePath(path: ReadonlyArray<PropertyKey>): string {
  let text = '';
  for (const segment of path) {
    if (typeof segment === 'number') text += `[${segment}]`;
    else text += text === '' ? String(segment) : `.${String(segment)}`;
  }
  return text === '' ? '(root)' : text;
}

function zodProblems(error: z.ZodError): ValidationProblem[] {
  return error.issues.map((issue) => ({
    path: issuePath(issue.path),
    message: issue.message,
  }));
}

/**
 * Cross-record checks that a per-field schema cannot express.
 *
 * Runs only after the shape parses, so it can assume every field exists and has
 * the right type — which is why it reads as straight-line bookkeeping rather
 * than defensive type checking.
 */
export function validateBundleReferences(bundle: ValidatedBundle): {
  errors: ValidationProblem[];
  warnings: string[];
} {
  const errors: ValidationProblem[] = [];
  const warnings: string[] = [];

  const itemIds = new Set<string>();
  const duplicateItems = new Set<string>();
  bundle.data.knowledgeItems.forEach((item, index) => {
    if (itemIds.has(item.id)) {
      duplicateItems.add(item.id);
      errors.push({
        path: `data.knowledgeItems[${index}].id`,
        message: `条目 ID 重复：${item.id}`,
      });
      return;
    }
    itemIds.add(item.id);
  });

  const tagIds = new Set<string>();
  const normalizedSeen = new Map<string, string>();
  bundle.data.tags.forEach((tag, index) => {
    if (tagIds.has(tag.id)) {
      errors.push({ path: `data.tags[${index}].id`, message: `标签 ID 重复：${tag.id}` });
      return;
    }
    tagIds.add(tag.id);

    // Two tags with one `normalized` would collide on the live UNIQUE index and
    // split one concept across two ids.
    const existing = normalizedSeen.get(tag.normalized);
    if (existing !== undefined) {
      errors.push({
        path: `data.tags[${index}].normalized`,
        message: `规范化标签重复：${tag.normalized}（同 ${existing}）`,
      });
      return;
    }
    normalizedSeen.set(tag.normalized, tag.id);
  });

  // itemTags: endpoints must exist, and one item may hold a position once.
  const positionByItem = new Map<string, Map<number, number>>();
  const seenLink = new Set<string>();
  bundle.data.itemTags.forEach((link, index) => {
    if (!itemIds.has(link.itemId) && !duplicateItems.has(link.itemId)) {
      errors.push({
        path: `data.itemTags[${index}].itemId`,
        message: `标签连接指向不存在的条目：${link.itemId}`,
      });
    }
    if (!tagIds.has(link.tagId)) {
      errors.push({
        path: `data.itemTags[${index}].tagId`,
        message: `标签连接指向不存在的标签：${link.tagId}`,
      });
    }

    const linkKey = `${link.itemId}\u0000${link.tagId}`;
    if (seenLink.has(linkKey)) {
      errors.push({
        path: `data.itemTags[${index}]`,
        message: '同一标签被重复连接到同一条目',
      });
    }
    seenLink.add(linkKey);

    const positions = positionByItem.get(link.itemId) ?? new Map<number, number>();
    const takenBy = positions.get(link.position);
    if (takenBy !== undefined) {
      errors.push({
        path: `data.itemTags[${index}].position`,
        message: `条目的标签位置 ${link.position} 已被占用，顺序会变得不确定`,
      });
    }
    positions.set(link.position, index);
    positionByItem.set(link.itemId, positions);
  });

  // Relations: both endpoints must be present (unlike view sources).
  const relationIds = new Set<string>();
  bundle.data.relations.forEach((relation, index) => {
    if (relationIds.has(relation.id)) {
      errors.push({ path: `data.relations[${index}].id`, message: `关系 ID 重复：${relation.id}` });
      return;
    }
    relationIds.add(relation.id);

    if (!itemIds.has(relation.sourceId)) {
      errors.push({
        path: `data.relations[${index}].sourceId`,
        message: `关系起点不在备份条目中：${relation.sourceId}`,
      });
    }
    if (!itemIds.has(relation.targetId)) {
      errors.push({
        path: `data.relations[${index}].targetId`,
        message: `关系终点不在备份条目中：${relation.targetId}`,
      });
    }

    // The live schema has these CHECKs; catching them here turns an opaque
    // constraint failure mid-transaction into a located, readable error.
    if (relation.origin === 'manual' && relation.reviewStatus !== 'accepted') {
      errors.push({
        path: `data.relations[${index}].reviewStatus`,
        message: '人工关系必须处于已接受状态',
      });
    }
    if (relation.origin === 'manual' && relation.score !== null) {
      errors.push({
        path: `data.relations[${index}].score`,
        message: '人工关系不应带有模型评分',
      });
    }
    if (relation.origin === 'ai' && relation.score === null) {
      errors.push({
        path: `data.relations[${index}].score`,
        message: '模型关系缺少评分',
      });
    }
    if (relation.sourceId === relation.targetId) {
      errors.push({
        path: `data.relations[${index}].targetId`,
        message: '关系的两端不能是同一条目',
      });
    }
    if (
      isSymmetricRelationType(relation.type as RelationType) &&
      relation.sourceId >= relation.targetId
    ) {
      errors.push({
        path: `data.relations[${index}].targetId`,
        message: '对称关系要求起点 ID 小于终点 ID，否则恢复后顺序不定',
      });
    }
  });

  // Views: a missing source is legal; what must hold is internal consistency.
  const viewIds = new Set<string>();
  bundle.data.views.forEach((view, index) => {
    if (viewIds.has(view.id)) {
      errors.push({ path: `data.views[${index}].id`, message: `视图 ID 重复：${view.id}` });
    }
    viewIds.add(view.id);

    const snapshotIds = new Set(view.sourceSnapshot.items.map((entry) => entry.id));
    const missing = [...snapshotIds].filter((id) => !itemIds.has(id));
    if (missing.length > 0) {
      // Not an error — the contract keeps historical views with deleted sources.
      warnings.push(
        `视图 ${index}（${view.id}）的来源快照含 ${missing.length} 个已不在备份中的条目，` +
          '这是允许的历史状态；恢复后该图会提示缺失来源。',
      );
    }
  });

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Validate a parsed-or-raw bundle against the contract.
 *
 * Returns a report instead of throwing, because `/validate` must answer for an
 * invalid file with a body the UI can render. Callers that are about to *write*
 * (`importKnowledge`) still throw on `valid: false` — a report is not permission.
 */
export function validateBundle(raw: unknown): ImportValidationReport {
  // Hashing before parsing is deliberate: it identifies the exact bytes the user
  // reviewed even when the content is rejected, so the client's "this is the file
  // I showed you" claim can be checked against something.
  let bundleHash: string;
  try {
    bundleHash = hashCanonical(raw);
  } catch {
    bundleHash = '';
  }

  const parsed = backupBundleSchema.safeParse(raw);
  if (!parsed.success) {
    // Force the version error to the front: "version unsupported" is more useful
    // than a hundred "unknown field" complaints about a format we do not know.
    const problems = zodProblems(parsed.error);
    const versionProblem = problems.find((problem) => problem.path === 'schemaVersion');
    if (versionProblem) {
      const actual = readSchemaVersion(raw);
      versionProblem.message =
        actual === undefined
          ? `缺少 schemaVersion，只支持版本 ${BACKUP_SCHEMA_VERSION}`
          : `不支持的备份版本 ${String(actual)}，本版本只能读取 ${BACKUP_SCHEMA_VERSION}`;
      return {
        valid: false,
        recordCounts: emptyCounts(),
        bundleHash,
        warnings: [],
        errors: [versionProblem, ...problems.filter((problem) => problem !== versionProblem)],
      };
    }

    return {
      valid: false,
      recordCounts: emptyCounts(),
      bundleHash,
      warnings: [],
      errors: problems,
    };
  }

  const bundle = parsed.data;
  const { errors, warnings } = validateBundleReferences(bundle);

  return {
    valid: errors.length === 0,
    recordCounts: countBundle(bundle),
    bundleHash,
    warnings,
    errors,
  };
}

function emptyCounts(): BundleCounts {
  return { items: 0, tags: 0, itemTags: 0, relations: 0, views: 0 };
}

/** Best-effort read of a rejected bundle's version, for the error message. */
function readSchemaVersion(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return undefined;
  return (raw as { schemaVersion?: unknown }).schemaVersion;
}

/**
 * Reasons a validated bundle may still not be restorable.
 *
 * Kept separate from `validateBundle` because this is about the *target*, and the
 * same file can be valid for one library and refused by another (R04/R06).
 */
export function targetProblems(state: TargetLibraryState): ValidationProblem[] {
  if (isTargetEmpty(state)) return [];
  return [
    {
      path: '(target)',
      message:
        '目标知识库已有内容，本版本只支持恢复到空知识库。请先导出并清空现有资料，' +
        '或改用另一个数据目录。已有设置与 Key 不会被改动。',
    },
  ];
}
