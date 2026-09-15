/**
 * Zod schemas for every external trust boundary.
 *
 * Three boundaries, deliberately separate (docs/02_architecture/02_component_assembly.md §2):
 *   - http:   browser -> API request bodies and query parameters
 *   - llm:    model output -> domain objects (see ./llm.ts)
 *   - backup: import bundle -> database rows (see ./backup.ts)
 *
 * Objects are strict: unknown fields are rejected, never stripped, so a contract
 * drift cannot silently pass through.
 */
import { z } from 'zod';
import {
  IMPORTANCE_MAX,
  IMPORTANCE_MIN,
  ITEM_TYPES,
  RELATION_TYPES,
  REVIEW_STATUSES,
  RUN_KINDS,
  RUN_STATES,
  SOURCE_TYPES,
  STRUCTURED_MODES,
  TOKEN_FIELDS,
  MANUAL_FIELDS,
} from '../knowledge';
import { LIMITS } from '../limits';

export const uuidSchema = z.uuid();
export const isoDateSchema = z.iso.datetime();

/**
 * Boolean query parameter. `z.coerce.boolean()` would turn the string "false"
 * into `true`, so the accepted wire values are explicit.
 */
export const booleanQuerySchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

export const itemTypeSchema = z.enum(ITEM_TYPES);
export const sourceTypeSchema = z.enum(SOURCE_TYPES);
export const relationTypeSchema = z.enum(RELATION_TYPES);
export const reviewStatusSchema = z.enum(REVIEW_STATUSES);
export const runKindSchema = z.enum(RUN_KINDS);
export const runStateSchema = z.enum(RUN_STATES);
export const manualFieldSchema = z.enum(MANUAL_FIELDS);
export const viewKindSchema = z.enum(['graph', 'mindmap', 'flow']);
export const directionSchema = z.enum(['LR', 'TB']);

/** Code-point bounded string. The count is measured with `Array.from`, not length. */
export function codePointString(max: number, min = 0): z.ZodType<string> {
  return z.string().refine((value) => Array.from(value).length >= min, {
    message: `至少 ${min} 个字符`,
  }).refine((value) => Array.from(value).length <= max, {
    message: `不能超过 ${max} 个字符`,
  });
}

export const rawTextSchema = codePointString(LIMITS.rawTextCodePoints, 1).refine(
  (value) => value.trim().length > 0,
  { message: '原文不能只有空白字符' },
);

export const querySchema = codePointString(LIMITS.queryCodePoints);
export const intentSchema = codePointString(LIMITS.intentCodePoints, 1);
export const viewNameSchema = codePointString(LIMITS.viewNameCodePoints, 1);

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const sourceRefSchema = codePointString(LIMITS.sourceRefCodePoints);

export const captureRequestSchema = z.strictObject({
  captureRequestId: uuidSchema,
  rawText: rawTextSchema,
  sourceType: sourceTypeSchema,
  sourceRef: sourceRefSchema.nullable().optional().transform((value) => value ?? null),
});

export type CaptureRequestInput = z.input<typeof captureRequestSchema>;

export const itemPatchSchema = z.strictObject({
  rawText: rawTextSchema.optional(),
  title: codePointString(LIMITS.titleCodePoints).optional(),
  summary: codePointString(LIMITS.summaryCodePoints).optional(),
  type: itemTypeSchema.optional(),
  tags: z.array(z.string()).max(LIMITS.tagsPerItem * 4).optional(),
  keywords: z.array(z.string()).max(LIMITS.keywordsPerItem * 4).optional(),
  importance: z.int().min(IMPORTANCE_MIN).max(IMPORTANCE_MAX).optional(),
  sourceType: sourceTypeSchema.optional(),
  sourceRef: sourceRefSchema.nullable().optional(),
});

export const editItemRequestSchema = z.strictObject({
  expectedRevision: z.int().nonnegative(),
  patch: itemPatchSchema,
  unlockFields: z.array(manualFieldSchema).max(MANUAL_FIELDS.length).optional(),
});

export type EditItemRequestInput = z.input<typeof editItemRequestSchema>;

export const expectedRevisionSchema = z.strictObject({
  expectedRevision: z.int().nonnegative(),
});

export const deleteItemRequestSchema = z.strictObject({
  expectedRevision: z.int().nonnegative(),
});

export const itemListQuerySchema = z.strictObject({
  q: querySchema.optional(),
  type: itemTypeSchema.optional(),
  status: z.enum(['raw', 'processing', 'done', 'error', 'stale']).optional(),
  tagId: uuidSchema.optional(),
  sort: z.enum(['newest', 'oldest', 'importance']).default('newest'),
  limit: z.coerce.number().int().min(1).max(LIMITS.listPageSizeMax).optional(),
  cursor: z.string().optional(),
});

export type ItemListQuery = z.infer<typeof itemListQuerySchema>;

export const tagListQuerySchema = z.strictObject({
  q: querySchema.optional(),
});

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const manualRelationRequestSchema = z
  .strictObject({
    sourceId: uuidSchema,
    targetId: uuidSchema,
    type: relationTypeSchema,
    reason: codePointString(LIMITS.relationReasonCodePoints).optional().default(''),
    sourceExpectedRevision: z.int().nonnegative(),
    targetExpectedRevision: z.int().nonnegative(),
  })
  .refine((value) => value.sourceId !== value.targetId, {
    message: '不能把记录连到自己',
    path: ['targetId'],
  });

export type ManualRelationRequestInput = z.input<typeof manualRelationRequestSchema>;

export const relationReviewActionSchema = z.enum([
  'accept',
  'reject',
  'restoreSuggestion',
  'reconfirm',
]);

export const reviewRelationRequestSchema = z.strictObject({
  expectedRevision: z.int().nonnegative(),
  action: relationReviewActionSchema,
});

export const relationQuerySchema = z.strictObject({
  itemId: uuidSchema.optional(),
  reviewStatus: reviewStatusSchema.optional(),
  includeStale: booleanQuerySchema.optional(),
  includeRejected: booleanQuerySchema.optional(),
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Preview request (T021-R05). The client sends ids, or a tag whose members are
 * resolved once, here — never a saved query that could widen later. This is a
 * read: it must not reach a model.
 *
 * `itemId` accepts either one occurrence or several (`?itemId=a` or
 * `?itemId=a&itemId=b`) and always normalizes to an array, because both are the
 * same request in a URL. Before this, the field was array-only while a query
 * string can only ever produce a string, so *every* explicit-id preview answered
 * 400 — the "what will be sent" panel could only be built from a tag, and the
 * deleted-record check on an explicit selection was unreachable (T062-C02/C05).
 * `parseQuery` collects repeats rather than overwriting them, so the multi-id form
 * now survives as well.
 */
const itemIdQuerySchema = z
  .union([uuidSchema, z.array(uuidSchema)])
  .optional()
  .transform((value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]));

export const selectionQuerySchema = z.strictObject({
  itemId: itemIdQuerySchema,
  fromTagId: uuidSchema.optional(),
  filterTagId: uuidSchema.optional(),
});

export type SelectionQueryInput = z.infer<typeof selectionQuerySchema>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const llmConfigObject = z.strictObject({
  adapter: z.literal('openai-compatible'),
  baseUrl: codePointString(LIMITS.baseUrlCodePoints),
  model: codePointString(LIMITS.modelCodePoints),
  structuredMode: z.enum(STRUCTURED_MODES),
  tokenField: z.enum(TOKEN_FIELDS),
  maxOutputTokens: z.int().min(1).max(LIMITS.maxOutputTokens),
  schemaRepairEnabled: z.boolean(),
});

export const llmConfigSchema = llmConfigObject;

const apiKeyValueSchema = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= LIMITS.apiKeyBytes, {
    message: `API Key 不能超过 ${LIMITS.apiKeyBytes} 字节`,
  })
  .refine((value) => !/[\r\n]/.test(value), { message: 'API Key 不能包含换行' });

/**
 * Key-change intent. A discriminated union cannot be `.extend`ed, so the three
 * variants are built explicitly wherever extra fields are required. This keeps
 * each variant strict: `keep` may not carry a key, `replace` must.
 */
const keyChangeSchema = z.discriminatedUnion('keyAction', [
  z.strictObject({
    keyAction: z.literal('keep'),
    confirmKeyTransfer: z.boolean().optional(),
  }),
  z.strictObject({
    keyAction: z.literal('replace'),
    apiKey: apiKeyValueSchema,
  }),
  z.strictObject({
    keyAction: z.literal('delete'),
  }),
]);

export { keyChangeSchema };

export const saveLlmSettingsSchema = z.discriminatedUnion('keyAction', [
  z.strictObject({
    keyAction: z.literal('keep'),
    confirmKeyTransfer: z.boolean().optional(),
    expectedRevision: z.int().nonnegative(),
    config: llmConfigObject,
  }),
  z.strictObject({
    keyAction: z.literal('replace'),
    apiKey: apiKeyValueSchema,
    expectedRevision: z.int().nonnegative(),
    config: llmConfigObject,
  }),
  z.strictObject({
    keyAction: z.literal('delete'),
    expectedRevision: z.int().nonnegative(),
    config: llmConfigObject,
  }),
]);

export type SaveLlmSettingsInput = z.input<typeof saveLlmSettingsSchema>;

export const testLlmDraftSchema = z.strictObject({
  requestKey: uuidSchema,
  draft: z.discriminatedUnion('keyAction', [
    z.strictObject({
      keyAction: z.literal('keep'),
      confirmKeyTransfer: z.boolean().optional(),
      config: llmConfigObject,
    }),
    z.strictObject({
      keyAction: z.literal('replace'),
      apiKey: apiKeyValueSchema,
      config: llmConfigObject,
    }),
    z.strictObject({
      keyAction: z.literal('delete'),
      config: llmConfigObject,
    }),
  ]),
  expectedSettingsRevision: z.int().nonnegative(),
});

export type TestLlmDraftInput = z.input<typeof testLlmDraftSchema>;

// ---------------------------------------------------------------------------
// Organize / generation runs
// ---------------------------------------------------------------------------

export const organizeRequestSchema = z.strictObject({
  requestKey: uuidSchema,
  expectedRevision: z.int().nonnegative(),
});

export type OrganizeRequestInput = z.input<typeof organizeRequestSchema>;

export const explicitSelectionSchema = z.strictObject({
  mode: z.literal('explicit'),
  itemIds: z.array(uuidSchema).min(1).max(LIMITS.selectedItemsPerProjection),
});

export const generationRequestSchema = z.strictObject({
  requestKey: uuidSchema,
  selection: explicitSelectionSchema,
  intent: codePointString(LIMITS.intentCodePoints).optional(),
});

export type GenerationRequestInput = z.input<typeof generationRequestSchema>;

/**
 * Export format for `GET /api/views/{id}/export` (T060 mindmap, T068 flow).
 *
 * A closed set rather than a free string: the registry types the response as
 * `File`, and a caller asking for `format=pdf` must get a clear refusal instead of
 * an empty download that looks like a broken PDF (T060-C06 「不能用不可用按钮制造
 * 完整感」). Defaults to markdown, the format a person is most likely to want.
 *
 * `mermaid` is part of the set even though a mindmap cannot produce it, and `svg`
 * is absent even though a flow's menu offers it. Both asymmetries are deliberate:
 * the set describes what the *endpoint* may be asked for, and the service then
 * refuses a format that does not fit the stored kind with a message naming it.
 * `svg` is refused for every kind because a sanitized SVG only exists after a
 * browser has rendered one (T068-R04), so the server has no safe bytes to send.
 */
export const viewExportFormatSchema = z.enum(['json', 'markdown', 'mermaid']);

export const viewExportQuerySchema = z.strictObject({
  format: viewExportFormatSchema.default('markdown'),
});

export type ViewExportQueryInput = z.input<typeof viewExportQuerySchema>;

export const flowGenerationRequestSchema = z.strictObject({
  requestKey: uuidSchema,
  selection: explicitSelectionSchema,
  intent: intentSchema,
  direction: directionSchema,
});

export type FlowGenerationRequestInput = z.input<typeof flowGenerationRequestSchema>;

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export const graphFilterSchema = z.strictObject({
  tagId: uuidSchema.optional(),
  type: itemTypeSchema.optional(),
  reviewStatuses: z.array(reviewStatusSchema).max(REVIEW_STATUSES.length).optional(),
  minimumScore: z.number().min(0).max(1).optional(),
  includeStale: z.boolean().optional(),
});

export const graphQuerySchema = z.strictObject({
  filter: graphFilterSchema.default({}),
  itemIds: z.array(uuidSchema).max(LIMITS.graphNodes).optional(),
});

export type GraphQueryInput = z.input<typeof graphQuerySchema>;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const coordinateSchema = z
  .number()
  .finite()
  .refine((value) => Math.abs(value) <= LIMITS.viewCoordinateAbsMax, {
    message: '坐标超出允许范围',
  });

export const graphLayoutSchema = z.strictObject({
  positions: z.record(uuidSchema, z.strictObject({ x: coordinateSchema, y: coordinateSchema })),
  direction: directionSchema,
  viewport: z
    .strictObject({
      x: coordinateSchema,
      y: coordinateSchema,
      zoom: z.number().finite().min(LIMITS.viewZoomMin).max(LIMITS.viewZoomMax),
    })
    .optional(),
});

export const createGraphViewSchema = z.strictObject({
  name: viewNameSchema,
  selection: z.union([
    explicitSelectionSchema,
    z.strictObject({ mode: z.literal('filter'), filter: graphFilterSchema }),
  ]),
  positions: z.record(uuidSchema, z.strictObject({ x: coordinateSchema, y: coordinateSchema })),
  direction: directionSchema,
});

export type CreateGraphViewInput = z.input<typeof createGraphViewSchema>;

export const editViewSchema = z.strictObject({
  expectedRevision: z.int().nonnegative(),
  name: viewNameSchema.optional(),
  graphLayout: graphLayoutSchema.optional(),
});

export type EditViewInput = z.input<typeof editViewSchema>;

/**
 * Focused layout-save body (T047).
 *
 * Carries only what a debounced drag commit knows: the revision it started from,
 * the positions it changed, and optionally the direction/viewport. It is
 * deliberately not `EditView` — a drag must not be able to rename a view as a
 * side effect of a typo in an unrelated field.
 */
export const saveGraphLayoutSchema = z.strictObject({
  expectedRevision: z.int().nonnegative(),
  positions: z.record(uuidSchema, z.strictObject({ x: coordinateSchema, y: coordinateSchema })),
  direction: directionSchema.optional(),
  viewport: z
    .strictObject({
      x: coordinateSchema,
      y: coordinateSchema,
      zoom: z.number().finite().min(LIMITS.viewZoomMin).max(LIMITS.viewZoomMax),
    })
    .optional(),
});

export type SaveGraphLayoutBody = z.input<typeof saveGraphLayoutSchema>;

export const viewListQuerySchema = z.strictObject({
  kind: viewKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.listPageSizeMax).optional(),
  cursor: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export const importValidateSchema = z.strictObject({
  bundle: z.unknown(),
});

/**
 * The bundle is only parsed as "some JSON object" here; the real structural
 * validation happens in the backup schema so that both /validate and /import
 * share exactly one definition.
 */
export const importConfirmSchema = z.strictObject({
  bundle: z.unknown(),
  expectedBundleHash: z.string().regex(/^[0-9a-f]{64}$/),
  confirmEmptyRestore: z.literal(true),
});
