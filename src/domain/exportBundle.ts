/**
 * Logical backup bundle: the one shape export writes and import reads (T070).
 *
 * The contract (docs/03_contracts/10_backup_bundle.md §1) is a **whitelist**:
 * every field here is named explicitly, and nothing else leaves the database.
 * That direction matters — a deny-list would silently ship any column added
 * later, and the column most likely to be added next is a secret. So the type is
 * built field by field from the domain DTOs, and a new column simply does not
 * appear until someone deliberately adds it in two places (here and the export
 * query) *and* argues for it.
 *
 * Deliberately **not** in the bundle, each for its own reason:
 *
 *   - `settings`, `secrets`, `app_meta` — the API key must never ride along in a
 *     file users are told to keep and share (R01/R06). The bundle is explicitly
 *     not a credential backup; restoring it does not restore a connection.
 *   - `ai_runs` — the ledger is evidence of work this machine paid for, not
 *     knowledge. A run's `config_snapshot_json` also names the model and
 *     endpoint, so exporting runs would leak configuration. Every `runId`
 *     reference is therefore dropped (relations, views), not remapped.
 *   - item `status` / `lastRunId` / `error*` — those describe a *run*, and the
 *     contract requires recomputing them on import rather than restoring a
 *     stale `processing`.
 *   - item `tags` — tag identity lives in `tags` + `itemTags`, so shipping a
 *     second `tags` array would give one fact two representations that can
 *     disagree (the contract calls this out explicitly).
 *
 * This module is pure: no fs, no db, no env (T070 target-file rule). The byte
 * budget arithmetic and the canonical hash live here so the writer and the
 * reader cannot disagree about what "the same bundle" means.
 */
import { LIMITS } from './limits';
import { hashCanonical } from './hash';
import type {
  Evidence,
  GraphFilter,
  ISODate,
  ItemType,
  ManualField,
  RelationOrigin,
  RelationType,
  ReviewStatus,
  SelectionSpec,
  SourceSnapshot,
  SourceType,
  UUID,
  ViewKind,
} from './knowledge';

/** Only version 1 exists; an unknown version is refused, never guessed (T071-R02). */
export const BACKUP_SCHEMA_VERSION = 1;

/** Fixed download name; the title never reaches the path (T070-R05). */
export function backupFileName(exportedAt: ISODate): string {
  // UTC date, so two machines in different time zones agree on the name.
  const date = new Date(exportedAt);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `feini-brain-${yyyy}-${mm}-${dd}.json`;
}

/**
 * Item fields the backup keeps.
 *
 * Note what is absent: `tags` (rebuilt from tags+itemTags), `status`,
 * `lastRunId`, `error`, `isStructuredStale` (all derived on import).
 */
export interface BackupItem {
  id: UUID;
  captureRequestId: UUID;
  captureRequestHash: string;
  capturedText: string;
  rawText: string;
  rawVersion: number;
  revision: number;
  structuredBaseRawVersion: number | null;
  title: string;
  summary: string;
  type: ItemType;
  keywords: string[];
  importance: number;
  manualFields: ManualField[];
  sourceType: SourceType;
  sourceRef: string | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface BackupTag {
  id: UUID;
  label: string;
  normalized: string;
  createdAt: ISODate;
}

export interface BackupItemTag {
  itemId: UUID;
  tagId: UUID;
  position: number;
}

/** Relations keep domain fields; `runId` is deliberately not exported. */
export interface BackupRelation {
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
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** Views keep `contentHash`; `runId` is dropped for the same reason as relations. */
export interface BackupView {
  id: UUID;
  name: string;
  kind: ViewKind;
  selection: SelectionSpec;
  sourceSnapshot: SourceSnapshot;
  content: unknown;
  contentHash: string | null;
  rendererVersion: string;
  promptVersion: string | null;
  revision: number;
  generatedAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface BackupData {
  knowledgeItems: BackupItem[];
  tags: BackupTag[];
  itemTags: BackupItemTag[];
  relations: BackupRelation[];
  views: BackupView[];
}

export interface BackupBundle {
  schemaVersion: number;
  exportedAt: ISODate;
  data: BackupData;
}

export interface BundleCounts {
  items: number;
  tags: number;
  itemTags: number;
  relations: number;
  views: number;
}

export function countBundle(bundle: BackupBundle): BundleCounts {
  return {
    items: bundle.data.knowledgeItems.length,
    tags: bundle.data.tags.length,
    itemTags: bundle.data.itemTags.length,
    relations: bundle.data.relations.length,
    views: bundle.data.views.length,
  };
}

/**
 * Serialized size of the bundle in bytes.
 *
 * `Buffer.byteLength` rather than `text.length`: the budget is twenty **MiB**
 * (T070-R04) and the material is Chinese, so a character count would understate
 * the size by roughly a factor of three and wave through an oversized file.
 */
export function bundleByteLength(bundle: BackupBundle): number {
  return Buffer.byteLength(JSON.stringify(bundle), 'utf8');
}

/**
 * Hash identifying the exact bundle the user reviewed.
 *
 * `hashCanonical` sorts keys before hashing, so the digest follows the *content*
 * and not the key order a particular `JSON.stringify` happened to emit. That is
 * what lets `/validate` and `/import` agree on "the same bundle": the client
 * re-serializes what it was shown, and key order must not change the answer.
 */
export function bundleHash(bundle: BackupBundle): string {
  return hashCanonical(bundle);
}

export interface SizeBudgetResult {
  bytes: number;
  max: number;
  exceeded: boolean;
}

/** Whether a serialized bundle fits the twenty-MiB budget (T070-R04). */
export function checkSizeBudget(bundle: BackupBundle): SizeBudgetResult {
  const bytes = bundleByteLength(bundle);
  const max = LIMITS.exportBytesMax;
  return { bytes, max, exceeded: bytes > max };
}

/**
 * Human-readable size failure.
 *
 * Names the actual limit and suggests the honest next step rather than trimming
 * the bundle: a truncated backup that still looks valid is worse than no backup
 * (T070-C04), and silently dropping `capturedText` or relation reasons would
 * satisfy the byte count by destroying the thing being backed up.
 */
export function sizeExceededMessage(result: SizeBudgetResult): string {
  const mib = (result.max / (1024 * 1024)).toFixed(0);
  const actual = (result.bytes / (1024 * 1024)).toFixed(1);
  return (
    `导出内容约 ${actual} MiB，超过 ${mib} MiB 上限，因此没有生成文件。` +
    '没有提供半截备份：可以先用标签筛选后分批导出，或减少一次性导出的记录量。'
  );
}

/** The item type `GraphFilter` uses, re-exported so readers need one import. */
export type { GraphFilter };
