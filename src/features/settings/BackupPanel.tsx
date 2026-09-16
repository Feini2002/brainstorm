'use client';

/**
 * Backup and restore, from the settings page (D1 / G-1).
 *
 * This panel exists because the contract already promised it and nothing had
 * built it: `docs/03_contracts/10_backup_bundle.md` §1 is titled "明确恢复格式，
 * 而**不只**提供下载按钮", `docs/operations/backup-recovery.md:19` tells the user to
 * use "设置页或 GET /api/export", and T078-R01/T084-R05 both require an
 * export→restore journey. Without a control here, that journey could only be
 * performed with `page.request`, which is not a user journey.
 *
 * It is a thin client over the three routes that already existed (T070–T072).
 * There is deliberately **no new service layer**: `GET /api/export`,
 * `POST /api/import/validate` and `POST /api/import` already own the whole
 * behaviour, including the empty-library rule and the bundle-hash check. A
 * second implementation here would be a second place for those rules to drift.
 *
 * Four decisions that are rules rather than styling:
 *
 *  - **The file is read by the browser, not uploaded blind.** The user picks a
 *    file, we parse it locally, and only then send the parsed bundle. That is
 *    what makes "校验 → 显示 counts/warnings → 确认 → 恢复" a sequence the user
 *    actually sees. A malformed file is caught before any request is made, and
 *    the message says the file could not be read as JSON rather than blaming the
 *    server.
 *  - **`expectedBundleHash` comes from the validation response, not a local
 *    hash.** The server hashes exactly the bytes it received; recomputing it in
 *    the browser would let a client validate one file and commit another, which
 *    is the substitution the hash exists to prevent (T072-R01).
 *  - **The empty-library confirmation is an explicit checkbox.** `POST /api/import`
 *    requires `confirmEmptyRestore: true`; the UI must therefore make that a
 *    deliberate act with the consequence spelled out, not an implied default.
 *  - **`IMPORT_NONEMPTY` is shown verbatim.** The contract's message is the
 *    answer, and it already says settings and Key are untouched. Paraphrasing it
 *    into a shorter string, or offering to "merge", would describe a capability
 *    that does not exist.
 */
import { useCallback, useId, useRef, useState } from 'react';

import { ApiClientError, apiDownload, apiRequest, saveBlobAs } from '@/features/shared/apiClient';
import {
  Button,
  InlineError,
  LoadingIndicator,
  SectionCard,
} from '@/components/ui/primitives';

/** The report shape `/api/import/validate` returns (T071). */
export interface ImportValidationReport {
  valid: boolean;
  recordCounts: { items: number; tags: number; itemTags: number; relations: number; views: number };
  bundleHash: string;
  warnings: string[];
  errors: { path: string; message: string }[];
}

/** The result shape `POST /api/import` returns (T072). */
export interface ImportResult {
  imported: { items: number; tags: number; itemTags: number; relations: number; views: number };
  datasetRevision: number;
  bundleHash: string;
  warnings: string[];
}

/**
 * Local-only parse of the picked file.
 *
 * Discriminated rather than throwing: the two failures have different fixes (pick
 * another file vs. pick a file at all), and `read()`'s own rejection is a third
 * one. None of them is a server error, so none of them may be reported as one.
 */
type Picked =
  | { kind: 'parsed'; bundle: unknown; fileName: string }
  | { kind: 'unreadable'; message: string };

export function BackupPanel() {
  const fileInputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<ApiClientError | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const [picked, setPicked] = useState<Picked | null>(null);
  const [report, setReport] = useState<ImportValidationReport | null>(null);
  const [validating, setValidating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [restoreError, setRestoreError] = useState<ApiClientError | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);

  const onExport = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    setExportNotice(null);
    try {
      // The filename comes from the server's `Content-Disposition`; the rule that
      // builds it (fixed name + UTC date, never a title) lives in
      // `domain/exportBundle.ts` and is applied once, on the side that knows it.
      const { blob, filename } = await apiDownload('/api/export');
      const name = filename ?? 'feini-brain-backup.json';
      saveBlobAs(blob, name);
      setExportNotice(
        `已开始下载 ${name}。逻辑备份不含 Key 与模型设置；它能在另一台机器上恢复知识。`,
      );
    } catch (caught) {
      setExportError(toApiError(caught));
    } finally {
      setExporting(false);
    }
  }, []);

  const resetValidation = useCallback(() => {
    setReport(null);
    setConfirmed(false);
    setRestoreError(null);
    setRestoreNotice(null);
  }, []);

  const onPick = useCallback(
    async (file: File | null) => {
      resetValidation();
      if (file === null) {
        setPicked(null);
        return;
      }
      let text: string;
      try {
        text = await file.text();
      } catch {
        setPicked({ kind: 'unreadable', message: `无法读取文件 ${file.name}` });
        return;
      }
      try {
        setPicked({ kind: 'parsed', bundle: JSON.parse(text) as unknown, fileName: file.name });
      } catch {
        setPicked({
          kind: 'unreadable',
          message: `${file.name} 不是合法的 JSON 文件，请选择由「导出」生成的备份。`,
        });
      }
    },
    [resetValidation],
  );

  const onValidate = useCallback(async () => {
    if (picked === null || picked.kind !== 'parsed') return;
    setValidating(true);
    setRestoreError(null);
    setRestoreNotice(null);
    try {
      const result = await apiRequest<ImportValidationReport>('/api/import/validate', {
        method: 'POST',
        body: { bundle: picked.bundle },
      });
      setReport(result);
    } catch (caught) {
      setReport(null);
      setRestoreError(toApiError(caught));
    } finally {
      setValidating(false);
    }
  }, [picked]);

  const onRestore = useCallback(async () => {
    if (report === null || picked === null || picked.kind !== 'parsed' || !confirmed) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      const result = await apiRequest<ImportResult>('/api/import', {
        method: 'POST',
        body: {
          bundle: picked.bundle,
          // Server-derived, from the validation it just performed.
          expectedBundleHash: report.bundleHash,
          confirmEmptyRestore: true,
        },
      });
      setRestoreNotice(
        `已恢复到空知识库：条目 ${result.imported.items} · 标签 ${result.imported.tags} · ` +
          `关系 ${result.imported.relations} · 视图 ${result.imported.views}。` +
          '恢复不触发整理，也不会带回 Key：请重新配置模型连接，然后重新载入页面。',
      );
      // The library on screen is stale now; the user must reload to see it.
      setReport(null);
      setPicked(null);
      setConfirmed(false);
      if (inputRef.current !== null) inputRef.current.value = '';
    } catch (caught) {
      setRestoreError(toApiError(caught));
    } finally {
      setRestoring(false);
    }
  }, [confirmed, picked, report]);

  return (
    <SectionCard
      title="备份与恢复"
      description="导出是把知识写成可读的 JSON；恢复只允许写进空知识库。两者都不涉及 Key。"
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            data-testid="backup-export"
            disabled={exporting}
            onClick={() => void onExport()}
          >
            {exporting ? '正在导出…' : '导出整库（JSON）'}
          </Button>
          <span className="text-xs text-[var(--ink-muted)]">
            逻辑导出不含 API Key、模型设置与运行记录。
          </span>
        </div>
        {exportError !== null ? <InlineError message={`导出失败：${exportError.message}`} /> : null}
        {exportNotice !== null ? (
          <p className="text-sm text-[var(--ink)]" data-testid="backup-export-notice">
            {exportNotice}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 border-t border-[var(--line)] pt-3">
        <p className="text-sm text-[var(--ink)]">从备份恢复</p>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-[var(--ink-muted)]">
          <li>
            只能恢复到<strong>空</strong>知识库；已经有内容时服务端会拒绝，不会合并、也不会覆盖。
          </li>
          <li>文件先在浏览器里读出来再校验，校验通过后仍要你确认一次才会写入。</li>
          <li>恢复不会触发模型整理，也不会带回 Key；恢复后请重新配置模型连接。</li>
          <li>恢复只写知识数据，已有设置与 Key 不受影响。</li>
        </ul>

        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={fileInputId} className="text-sm text-[var(--ink)]">
            选择备份文件
          </label>
          <input
            ref={inputRef}
            id={fileInputId}
            data-testid="backup-file"
            type="file"
            accept="application/json,.json"
            className="text-sm text-[var(--ink-muted)]"
            onChange={(event) => void onPick(event.target.files?.[0] ?? null)}
          />
          <Button
            variant="secondary"
            data-testid="backup-validate"
            disabled={picked === null || picked.kind !== 'parsed' || validating}
            onClick={() => void onValidate()}
          >
            {validating ? '正在校验…' : '校验这个文件'}
          </Button>
          {validating ? <LoadingIndicator label="正在校验备份" /> : null}
        </div>

        {picked !== null && picked.kind === 'unreadable' ? (
          <p className="text-sm text-[var(--danger)]" data-testid="backup-file-error">
            {picked.message}
          </p>
        ) : null}

        {picked !== null && picked.kind === 'parsed' ? (
          <p className="text-xs text-[var(--ink-muted)]" data-testid="backup-picked-file">
            已读取 {picked.fileName}，尚未提交。先校验再恢复。
          </p>
        ) : null}

        {report !== null ? (
          <div className="flex flex-col gap-2 rounded-md border border-[var(--line)] p-3">
            <p
              className="text-sm text-[var(--ink)]"
              data-testid="backup-validation-counts"
              data-valid={report.valid ? 'true' : 'false'}
            >
              {report.valid ? '校验通过。' : '校验未通过。'}备份内容：条目{' '}
              {report.recordCounts.items} · 标签 {report.recordCounts.tags} · 标签连接{' '}
              {report.recordCounts.itemTags} · 关系 {report.recordCounts.relations} · 视图{' '}
              {report.recordCounts.views}
            </p>

            {report.warnings.length > 0 ? (
              <ul
                className="flex list-disc flex-col gap-1 pl-5 text-xs text-[var(--ink-muted)]"
                data-testid="backup-warnings"
              >
                {report.warnings.map((warning, index) => (
                  <li key={`${index}-${warning.slice(0, 24)}`}>{warning}</li>
                ))}
              </ul>
            ) : null}

            {report.errors.length > 0 ? (
              <ul
                className="flex list-disc flex-col gap-1 pl-5 text-xs text-[var(--danger)]"
                data-testid="backup-errors"
              >
                {report.errors.map((problem, index) => (
                  <li key={`${index}-${problem.path}`}>
                    {problem.path}：{problem.message}
                  </li>
                ))}
              </ul>
            ) : null}

            <label className="flex items-start gap-2 text-sm text-[var(--ink)]">
              <input
                type="checkbox"
                data-testid="backup-confirm-empty"
                checked={confirmed}
                disabled={!report.valid}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>
                我确认当前知识库是空的，并同意把这份备份写进去。已有内容时服务端会拒绝。
              </span>
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="danger"
                data-testid="backup-restore"
                disabled={!report.valid || !confirmed || restoring}
                onClick={() => void onRestore()}
              >
                {restoring ? '正在恢复…' : '恢复到这个空知识库'}
              </Button>
              <span className="text-xs text-[var(--ink-muted)]">
                恢复提交时服务端会再校验一次文件哈希与空库状态。
              </span>
            </div>
          </div>
        ) : null}

        {restoreError !== null ? (
          <InlineError message={`恢复未执行：${restoreError.message}`} />
        ) : null}
        {restoreNotice !== null ? (
          <p className="text-sm text-[var(--ink)]" data-testid="backup-restore-notice">
            {restoreNotice}
          </p>
        ) : null}
      </div>
    </SectionCard>
  );
}

/** Normalize anything thrown into the one error type the panel renders. */
function toApiError(caught: unknown): ApiClientError {
  if (caught instanceof ApiClientError) return caught;
  return new ApiClientError({ code: 'INTERNAL', message: '本地服务没有返回结果', retryable: true });
}
