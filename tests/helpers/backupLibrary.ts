/**
 * A deliberately awkward knowledge library for backup tests (T070/T071/T072).
 *
 * Backup and restore bugs hide in the features nobody exercised locally, so this
 * seed is built from the cases the contract singles out rather than from tidy
 * happy-path rows. Each entity exists to pin one of them:
 *
 *   - **Manual locks** (`manualFields`) — the contract's whole point that an
 *     export carries the *human* text and a restore cannot quietly re-derive it.
 *   - **A review tombstone** (`reviewStatus: 'rejected'`) — a rejected relation is
 *     still a decision the user made; dropping it would resurrect the link.
 *   - **`structuredBaseRawVersion !== rawVersion`** — the item whose summary is
 *     out of date. Restore must recompute `stale`, not import the old status.
 *   - **A view whose source was deleted** — explicitly *legal* in a backup, and
 *     the reason validation must treat views differently from relations. If a
 *     restored library refused this, no real library could ever be restored.
 *   - **Multiline Chinese with emoji** — byte-fidelity; a `length`-based size
 *     check or a latin1 round-trip corrupts exactly this.
 *   - **Secrets, settings and runs alongside it** — so a test can prove the
 *     export excluded them because they were *there to be excluded*. An absence
 *     assertion over an empty table proves nothing.
 *
 * Ids are fixed constants (not random) so a test can name the entity it is
 * asserting about, and so a failure message points at a specific record.
 */
import type { DatabaseSync } from 'node:sqlite';

export const FIX = {
  itemManual: 'aaaaaaaa-0000-4000-8000-000000000001',
  itemStale: 'aaaaaaaa-0000-4000-8000-000000000002',
  itemPlain: 'aaaaaaaa-0000-4000-8000-000000000003',
  /** Referenced by a view below but never inserted: the "missing source" case. */
  itemDeleted: 'aaaaaaaa-0000-4000-8000-0000000000ff',

  tagAi: 'bbbbbbbb-0000-4000-8000-000000000001',
  tagCareer: 'bbbbbbbb-0000-4000-8000-000000000002',
  tagLife: 'bbbbbbbb-0000-4000-8000-000000000003',

  relationAccepted: 'cccccccc-0000-4000-8000-000000000001',
  relationRejected: 'cccccccc-0000-4000-8000-000000000002',
  relationManual: 'cccccccc-0000-4000-8000-000000000003',

  viewWithDeletedSource: 'dddddddd-0000-4000-8000-000000000001',
  viewPlain: 'dddddddd-0000-4000-8000-000000000002',

  runSucceeded: 'eeeeeeee-0000-4000-8000-000000000001',

  secretKey: 'llm_api_key',
  secretValue: 'sk-backup-test-must-never-export-0123456789',
} as const;

/** Multiline Chinese + emoji, the byte-fidelity probe (T070-C05). */
export const MULTILINE_TEXT = [
  '第一行：模型越强，越需要把问题说清楚。',
  '第二行：换行与缩进\t都要保留。',
  '第三行：emoji 🧠🚀 与全角标点，以及「引号」。',
].join('\n');

export interface SeededLibrary {
  itemIds: string[];
  tagIds: string[];
  relationIds: string[];
  viewIds: string[];
}

interface ItemSeed {
  id: string;
  capturedText: string;
  rawText: string;
  rawVersion: number;
  revision: number;
  structuredBaseRawVersion: number | null;
  title: string;
  summary: string;
  type: string;
  keywords: string[];
  importance: number;
  manualFields: string[];
  sourceType: string;
  sourceRef: string | null;
}

function insertItem(db: DatabaseSync, item: ItemSeed): void {
  db.prepare(
    `INSERT INTO knowledge_items (
       id, capture_request_id, capture_request_hash, captured_text, raw_text,
       raw_version, revision, structured_base_raw_version, title, summary, type,
       keywords_json, importance, manual_fields_json, status, source_type,
       source_ref, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    item.id,
    // Derived from the id so each row keeps a unique capture key without a
    // second table of constants.
    `a0000000-0000-4000-8000-${item.id.slice(-12)}`,
    'f'.repeat(64),
    item.capturedText,
    item.rawText,
    item.rawVersion,
    item.revision,
    item.structuredBaseRawVersion,
    item.title,
    item.summary,
    item.type,
    JSON.stringify(item.keywords),
    item.importance,
    JSON.stringify(item.manualFields),
    // Status is intentionally a plausible *stale* value; import must recompute
    // it from the versions rather than trusting this column.
    item.structuredBaseRawVersion === item.rawVersion ? 'done' : 'stale',
    item.sourceType,
    item.sourceRef,
    '2026-09-14T00:00:00.000Z',
    '2026-09-14T00:00:00.000Z',
  );
}

/**
 * Populate a database with the fixture library.
 *
 * Synthetic and always safe: the caller supplies an isolated test database, and
 * nothing here reads the environment or touches a real data directory.
 */
export function seedBackupLibrary(db: DatabaseSync): SeededLibrary {
  insertItem(db, {
    id: FIX.itemManual,
    // `capturedText` and `rawText` differ: an edited item must keep *both*, since
    // the original capture is the evidence that the structured fields describe.
    capturedText: MULTILINE_TEXT,
    rawText: `${MULTILINE_TEXT}\n第四行：采集之后人工补充。`,
    rawVersion: 2,
    revision: 3,
    structuredBaseRawVersion: 2,
    title: '人工锁定的标题',
    summary: '人工摘要：这一条被锁定，不能被模型改写。',
    type: 'idea',
    keywords: ['模型', '问题定义'],
    importance: 5,
    manualFields: ['title', 'summary'],
    sourceType: 'chatgpt',
    sourceRef: 'https://example.invalid/a',
  });

  insertItem(db, {
    id: FIX.itemStale,
    capturedText: '需求不清楚时，自动化会更快地产生不需要的结果。',
    rawText: '需求不清楚时，自动化会更快地产生不需要的结果。补充的第二版。',
    // base(1) != rawVersion(2) => stale after restore, hence status above.
    rawVersion: 2,
    revision: 4,
    structuredBaseRawVersion: 1,
    title: '自动化不能替代需求澄清',
    summary: '这是人工保留的摘要。',
    type: 'observation',
    keywords: [],
    importance: 3,
    manualFields: ['summary'],
    sourceType: 'chatgpt',
    sourceRef: null,
  });

  insertItem(db, {
    id: FIX.itemPlain,
    capturedText: '我今天记录了咖啡的冲泡比例，这条和软件职业没有直接关系。',
    rawText: '我今天记录了咖啡的冲泡比例，这条和软件职业没有直接关系。',
    rawVersion: 1,
    revision: 1,
    structuredBaseRawVersion: 1,
    title: '咖啡冲泡记录',
    summary: '独立的日常记录。',
    type: 'observation',
    keywords: [],
    importance: 2,
    manualFields: [],
    sourceType: 'myself',
    sourceRef: null,
  });

  const insertTag = db.prepare(
    'INSERT INTO tags (id, label, normalized, created_at) VALUES (?,?,?,?)',
  );
  insertTag.run(FIX.tagAi, 'AI开发', 'ai开发', '2026-09-14T00:00:00.000Z');
  insertTag.run(FIX.tagCareer, '职业', '职业', '2026-09-14T00:00:00.000Z');
  insertTag.run(FIX.tagLife, '生活', '生活', '2026-09-14T00:00:00.000Z');

  const insertItemTag = db.prepare(
    'INSERT INTO item_tags (item_id, tag_id, position) VALUES (?,?,?)',
  );
  // Position order is meaningful (it is the user's ordering), so the seed uses a
  // non-alphabetical arrangement: restoring by label sort would reorder these.
  insertItemTag.run(FIX.itemManual, FIX.tagCareer, 0);
  insertItemTag.run(FIX.itemManual, FIX.tagAi, 1);
  insertItemTag.run(FIX.itemStale, FIX.tagAi, 0);
  insertItemTag.run(FIX.itemPlain, FIX.tagLife, 0);

  const insertRelation = db.prepare(
    `INSERT INTO relations (
       id, source_id, target_id, relation_type, origin, review_status, score,
       reason, evidence_json, source_raw_version, target_raw_version, run_id,
       revision, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  // AI, accepted, with citations and a *dropped* runId: the run itself is not
  // exported, so a restore must null the reference without losing the relation.
  insertRelation.run(
    FIX.relationAccepted,
    FIX.itemManual,
    FIX.itemStale,
    'related_to',
    'ai',
    'accepted',
    0.78,
    '共同讨论问题澄清与自动化产出。',
    JSON.stringify([
      { itemId: FIX.itemManual, rawVersion: 2, quote: '越需要把问题说清楚' },
      { itemId: FIX.itemStale, rawVersion: 2, quote: '需求不清楚时' },
    ]),
    2,
    2,
    null,
    1,
    '2026-09-14T00:00:00.000Z',
    '2026-09-14T00:00:00.000Z',
  );

  // A rejected suggestion. It must survive round-trip, or a restore would make
  // the user re-reject the same link on every machine.
  //
  // `similar_to` is symmetric, so the schema requires `source_id < target_id`
  // (itemStale `…002` before itemPlain `…003`); the endpoints are ordered to
  // satisfy that rather than by narrative direction.
  insertRelation.run(
    FIX.relationRejected,
    FIX.itemStale,
    FIX.itemPlain,
    'similar_to',
    'ai',
    'rejected',
    0.31,
    '被拒绝的相似建议。',
    JSON.stringify([]),
    2,
    1,
    null,
    1,
    '2026-09-14T00:00:00.000Z',
    '2026-09-14T00:00:00.000Z',
  );

  // Manual relations carry no score (schema CHECK), and are therefore the rows a
  // naive "skip when score is null" export would silently lose.
  insertRelation.run(
    FIX.relationManual,
    FIX.itemManual,
    FIX.itemPlain,
    'related_to',
    'manual',
    'accepted',
    null,
    '人工确认的关联。',
    JSON.stringify([]),
    2,
    1,
    null,
    1,
    '2026-09-14T00:00:00.000Z',
    '2026-09-14T00:00:00.000Z',
  );

  const insertView = db.prepare(
    `INSERT INTO views (
       id, name, kind, selection_json, source_snapshot_json, content_json,
       content_hash, renderer_version, prompt_version, run_id, revision,
       generated_at, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  // The load-bearing case: `sourceSnapshot` names an item that no longer exists.
  // The contract keeps this legal on purpose (a note can be deleted while its
  // map survives), so validation must not reject the bundle over it.
  insertView.run(
    FIX.viewWithDeletedSource,
    '含已删除来源的旧图',
    'graph',
    JSON.stringify({ mode: 'explicit', itemIds: [FIX.itemManual, FIX.itemDeleted] }),
    JSON.stringify({
      items: [
        { id: FIX.itemManual, revision: 3, rawVersion: 2 },
        { id: FIX.itemDeleted, revision: 1, rawVersion: 1 },
      ],
      relations: [{ id: FIX.relationAccepted, revision: 1 }],
    }),
    JSON.stringify({
      positions: { [FIX.itemManual]: { x: 12, y: -4 } },
      direction: 'LR',
    }),
    null,
    'graph-compiler-v1',
    null,
    null,
    2,
    null,
    '2026-09-14T00:00:00.000Z',
    '2026-09-14T00:00:00.000Z',
  );

  insertView.run(
    FIX.viewPlain,
    '需求与自动化',
    'mindmap',
    JSON.stringify({ mode: 'explicit', itemIds: [FIX.itemManual, FIX.itemStale] }),
    JSON.stringify({
      items: [
        { id: FIX.itemManual, revision: 3, rawVersion: 2 },
        { id: FIX.itemStale, revision: 4, rawVersion: 2 },
      ],
      relations: [],
    }),
    JSON.stringify({
      title: '需求与自动化',
      nodes: [
        { id: 'm1', parentId: null, label: '需求与自动化', itemIds: [FIX.itemManual], kind: 'group' },
        { id: 'm2', parentId: 'm1', label: '问题定义', itemIds: [FIX.itemStale], kind: 'note' },
      ],
    }),
    'd'.repeat(64),
    'mindmap-compiler-v1',
    'mindmap-v1',
    null,
    1,
    '2026-09-14T00:00:00.000Z',
    '2026-09-14T00:00:00.000Z',
    '2026-09-14T00:00:00.000Z',
  );

  // Non-knowledge state, written so exclusion assertions have something real to
  // exclude (T070-C02). These must never appear in the bundle.
  db.prepare(
    'INSERT INTO secrets (key, value, updated_at) VALUES (?,?,?)',
  ).run(FIX.secretKey, FIX.secretValue, '2026-09-14T00:00:00.000Z');

  db.prepare(
    `INSERT INTO settings (id, config_json, revision, updated_at) VALUES (1,?,?,?)`,
  ).run(
    JSON.stringify({
      adapter: 'openai-compatible',
      baseUrl: 'https://api.example.invalid/v1',
      model: 'some-private-model',
      structuredMode: 'prompt_json',
      tokenField: 'none',
      maxOutputTokens: 4096,
      schemaRepairEnabled: false,
    }),
    7,
    '2026-09-14T00:00:00.000Z',
  );

  db.prepare(
    `INSERT INTO ai_runs (
       id, request_key, request_hash, kind, subject_id, input_revision, input_hash,
       state, config_revision, config_snapshot_json, candidate_ids_json, result_ref,
       usage_json, prompt_version, attempt_count, started_at, deadline_at, finished_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    FIX.runSucceeded,
    'req-backup-test',
    'e'.repeat(64),
    'organize',
    FIX.itemStale,
    4,
    'f'.repeat(64),
    'succeeded',
    7,
    // The run snapshot embeds the model name and endpoint, which is exactly why
    // runs are not exported.
    JSON.stringify({ adapter: 'openai-compatible', model: 'some-private-model' }),
    JSON.stringify([FIX.itemStale]),
    FIX.itemStale,
    JSON.stringify({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
    'organize-v1',
    1,
    '2026-09-14T00:00:00.000Z',
    '2026-09-14T00:05:00.000Z',
    '2026-09-14T00:00:10.000Z',
  );

  return {
    itemIds: [FIX.itemManual, FIX.itemStale, FIX.itemPlain],
    tagIds: [FIX.tagAi, FIX.tagCareer, FIX.tagLife],
    relationIds: [FIX.relationAccepted, FIX.relationRejected, FIX.relationManual],
    viewIds: [FIX.viewWithDeletedSource, FIX.viewPlain],
  };
}
