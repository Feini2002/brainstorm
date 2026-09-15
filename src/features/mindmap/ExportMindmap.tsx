'use client';

/**
 * Export a saved mindmap (T060).
 *
 * Two formats, both real. There is no PDF button and no SVG button: neither is
 * implemented, and a disabled control that suggests a capability the product does
 * not have is worse than an absent one — it makes the export menu look complete at
 * exactly the moment the user is trying to find out what it can do (T060-R06,
 * T060-C06). When those formats exist they get their own task.
 *
 * The download is described before it happens, because the file's honesty is the
 * point of the feature: what leaves the app is a *snapshot* with its sources and
 * generation time attached, not a claim to be the current state of the library.
 */
import { useState } from 'react';

import type { ViewFreshness } from '@/domain/view';
import { Button, InlineError } from '@/components/ui/primitives';
import { ApiClientError, apiDownload, saveBlobAs } from '@/features/shared/apiClient';

/** The formats the server can actually produce, and what each one is for. */
const FORMATS = [
  {
    id: 'markdown' as const,
    label: '导出 Markdown',
    hint: '带来源清单与导出说明，适合阅读和再次引用。',
  },
  {
    id: 'json' as const,
    label: '导出 JSON',
    hint: '包含完整树结构与来源版本，适合机器读取或留档校验。',
  },
];

export function ExportMindmap({
  viewId,
  freshness,
}: {
  viewId: string;
  freshness: ViewFreshness | null;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const download = async (format: 'markdown' | 'json') => {
    setBusy(format);
    setError(null);
    setDone(null);
    try {
      const { blob, filename } = await apiDownload(`/api/views/${viewId}/export`, { format });
      // The server named it; fall back only if the header was unreadable.
      saveBlobAs(blob, filename ?? `feini-mindmap-${viewId}.${format === 'json' ? 'json' : 'md'}`);
      setDone(format);
    } catch (caught) {
      setError(
        caught instanceof ApiClientError ? caught.message : '导出失败，请稍后重试',
      );
    } finally {
      setBusy(null);
    }
  };

  // A stale view still exports — it is a record of what was organised, and
  // refusing to export it would destroy the user's own history. But the export
  // says so, and this notice says so too, so the warning is not a surprise
  // discovered inside the file (T060-R05, T060-C04).
  const stale = freshness !== null && (freshness.isStale || freshness.missingSourceCount > 0);

  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3"
      data-testid="export-mindmap"
      aria-label="导出脑图"
    >
      <h3 className="text-sm text-[var(--ink)]">导出</h3>

      <div className="flex flex-wrap items-center gap-2">
        {FORMATS.map((format) => (
          <Button
            key={format.id}
            variant="secondary"
            data-testid={`export-${format.id}`}
            disabled={busy !== null}
            onClick={() => void download(format.id)}
          >
            {busy === format.id ? '正在导出…' : format.label}
          </Button>
        ))}
      </div>

      <ul className="flex flex-col gap-1 text-xs text-[var(--ink-muted)]">
        {FORMATS.map((format) => (
          <li key={format.id} data-testid={`export-hint-${format.id}`}>
            {format.label}：{format.hint}
          </li>
        ))}
      </ul>

      {stale ? (
        <p className="text-xs text-[var(--warn-ink)]" data-testid="export-stale-warning">
          {freshness?.reason ?? '来源版本已变化'}
          ，导出的文件会写明生成时间与过期状态，不会被标成最新整理。
        </p>
      ) : null}

      {done ? (
        <p className="text-xs text-[var(--ink)]" role="status" data-testid="export-done">
          已开始下载。
        </p>
      ) : null}

      {error ? (
        <InlineError message={error}>
          <span className="text-xs" data-testid="export-error-note">
            导出失败不会保存任何文件，可以重试。
          </span>
        </InlineError>
      ) : null}
    </section>
  );
}
