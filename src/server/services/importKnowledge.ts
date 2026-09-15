/**
 * Restore a validated bundle into an empty library (T072).
 *
 * The load-bearing rule is R04: a failure leaves the library exactly as it was.
 * That is why every write happens inside one `BEGIN IMMEDIATE` and why nothing
 * here awaits anything — `withTransaction` rejects a thenable callback outright
 * (blueprint §2 forbids waiting on the network inside a transaction), and this
 * function is fully synchronous as a result.
 *
 * Re-validation on entry (R01) is not redundant with `/api/import/validate`.
 * Between the two calls another window can create an item, and a client can lie
 * about which file it is sending; so the hash, the schema and the empty-target
 * check are all re-established *inside* the transaction, where the answer cannot
 * change before the inserts run.
 *
 * Two things are deliberately *not* restored:
 *
 *   - **Runs.** `run_id` is written as `NULL`. A run's `config_snapshot_json`
 *     names a model and endpoint, and a restored run would be a fabricated claim
 *     about work this machine never did. Dropping the pointer keeps the relation
 *     and its evidence, which is the knowledge; the provenance of *this*
 *     machine's organize pass is not portable.
 *   - **Settings, secrets, `app_meta`.** Not written, so credentials on the
 *     target survive untouched (R03). A backup that could overwrite the API key
 *     would turn "restore my notes" into "accept this file's endpoint".
 *
 * Insert order follows the foreign keys (Item → Tag → ItemTag → Relation → View)
 * so no statement ever references a row that does not exist yet, and the
 * `datasetRevision` bump at the end invalidates every derived projection at once
 * (R05) instead of leaving stale graph caches behind.
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import type { BackupBundle } from '@/domain/exportBundle';
import { hashCanonical } from '@/domain/hash';
import {
  IMPORT_STATUSES,
  deriveImportStatus,
  validateBundle,
  type ImportValidationReport,
} from '@/domain/importBundle';
import { bumpDatasetRevision, withTransaction } from '@/server/db/database';
import { readTargetState } from '@/server/services/validateImport';

export interface ImportConfirmInput {
  bundle: unknown;
  /** Hash the user's file was reported to have at validation time. */
  expectedBundleHash: string;
}

export interface ImportResult {
  imported: {
    items: number;
    tags: number;
    itemTags: number;
    relations: number;
    views: number;
  };
  datasetRevision: number;
  bundleHash: string;
  /** What the user must still do by hand after a restore (R06). */
  warnings: string[];
}

/**
 * Insert every entity in dependency order.
 *
 * Written out rather than routed through `insertCapture`/`insertRelation`
 * because those helpers are built for *new* records and intentionally normalise
 * fields a restore must preserve verbatim — `insertCapture` resets
 * `structured_base_raw_version` to `NULL` and `revision` to 1, which would
 * silently discard the version history that makes an item's stale/done state
 * meaningful.
 */
function insertBundle(db: DatabaseSync, bundle: BackupBundle): ImportResult['imported'] {
  const insertItem = db.prepare(
    `INSERT INTO knowledge_items (
       id, capture_request_id, capture_request_hash, captured_text, raw_text,
       raw_version, revision, structured_base_raw_version, title, summary, type,
       keywords_json, importance, manual_fields_json, status, last_run_id,
       error_code, error_message, source_type, source_ref, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
  );

  for (const item of bundle.data.knowledgeItems) {
    // No run can have produced a restored item, so the status is *derived* from
    // the version fields instead of trusted (R02). Importing the stored status
    // would let a file claim `processing` forever, or `error` with no run.
    const status = deriveImportStatus(item.structuredBaseRawVersion, item.rawVersion);
    insertItem.run(
      item.id,
      item.captureRequestId,
      item.captureRequestHash,
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
      status,
      item.sourceType,
      item.sourceRef,
      item.createdAt,
      item.updatedAt,
    );
  }

  const insertTag = db.prepare(
    'INSERT INTO tags (id, label, normalized, created_at) VALUES (?, ?, ?, ?)',
  );
  for (const tag of bundle.data.tags) {
    insertTag.run(tag.id, tag.label, tag.normalized, tag.createdAt);
  }

  const insertItemTag = db.prepare(
    'INSERT INTO item_tags (item_id, tag_id, position) VALUES (?, ?, ?)',
  );
  for (const link of bundle.data.itemTags) {
    insertItemTag.run(link.itemId, link.tagId, link.position);
  }

  const insertRelation = db.prepare(
    `INSERT INTO relations (
       id, source_id, target_id, relation_type, origin, review_status, score,
       reason, evidence_json, source_raw_version, target_raw_version, run_id,
       revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  );
  for (const relation of bundle.data.relations) {
    // `run_id` is NULL by construction: see the module note on runs.
    insertRelation.run(
      relation.id,
      relation.sourceId,
      relation.targetId,
      relation.type,
      relation.origin,
      relation.reviewStatus,
      relation.score,
      relation.reason,
      JSON.stringify(relation.evidence),
      relation.sourceRawVersion,
      relation.targetRawVersion,
      relation.revision,
      relation.createdAt,
      relation.updatedAt,
    );
  }

  const insertView = db.prepare(
    `INSERT INTO views (
       id, name, kind, selection_json, source_snapshot_json, content_json,
       content_hash, renderer_version, prompt_version, run_id, revision,
       generated_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  );
  for (const view of bundle.data.views) {
    insertView.run(
      view.id,
      view.name,
      view.kind,
      JSON.stringify(view.selection),
      JSON.stringify(view.sourceSnapshot),
      JSON.stringify(view.content),
      view.contentHash,
      view.rendererVersion,
      view.promptVersion,
      view.revision,
      view.generatedAt,
      view.createdAt,
      view.updatedAt,
    );
  }

  return {
    items: bundle.data.knowledgeItems.length,
    tags: bundle.data.tags.length,
    itemTags: bundle.data.itemTags.length,
    relations: bundle.data.relations.length,
    views: bundle.data.views.length,
  };
}

/** Fail loudly if a run is in flight; a restore must not race a live model call. */
function assertNoRunningOperation(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE state = 'running'")
    .get() as { n: number } | undefined;
  if ((row?.n ?? 0) > 0) {
    throw new AppError(
      'RUN_BUSY',
      '有正在进行的模型操作，导入会与旧响应冲突。请等它结束后再恢复。',
    );
  }
}

/**
 * Restore `bundle` into the database, or change nothing at all.
 *
 * `expectedBundleHash` is compared against the bundle actually received (R01):
 * if they differ, the user is about to write a file they never reviewed and the
 * commit is refused. The check runs before the transaction because it needs no
 * database state, then the transaction re-checks the target.
 */
export function importKnowledge(db: DatabaseSync, input: ImportConfirmInput): ImportResult {
  const actualHash = hashCanonical(input.bundle);
  if (actualHash !== input.expectedBundleHash) {
    throw new AppError(
      'IMPORT_INVALID',
      '备份内容与校验时不一致，可能被修改过，已拒绝恢复。请重新选择文件并再次校验。',
    );
  }

  const report: ImportValidationReport = validateBundle(input.bundle);
  if (!report.valid) {
    const first = report.errors[0];
    throw new AppError(
      'IMPORT_INVALID',
      first ? `备份不合法（${first.path}）：${first.message}` : '备份不合法',
    );
  }

  const bundle = input.bundle as BackupBundle;

  return withTransaction(db, () => {
    // Re-check *inside* the transaction: this is the only point at which "the
    // library is still empty" and "it stays empty until my inserts commit" are
    // both true. `BEGIN IMMEDIATE` has already taken the write lock, so no other
    // writer can intervene after this read.
    const target = readTargetState(db);
    if (target.items > 0 || target.relations > 0 || target.views > 0 || target.tags > 0 || target.itemTags > 0) {
      throw new AppError(
        'IMPORT_NONEMPTY',
        '目标知识库已有内容，只支持恢复到空知识库。已有设置与 Key 未被改动。',
      );
    }

    assertNoRunningOperation(db);

    const imported = insertBundle(db, bundle);
    const datasetRevision = bumpDatasetRevision(db);

    return {
      imported,
      datasetRevision,
      bundleHash: actualHash,
      warnings: [
        ...report.warnings,
        '知识已恢复，但来源过期提示与模型配置需要你自行确认；导入不会自动请求 AI 重新整理。',
      ],
    };
  });
}

export { IMPORT_STATUSES };
