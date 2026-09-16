'use client';

/**
 * Export a saved flow (T068).
 *
 * Three formats, and the third one is the interesting case. JSON and Mermaid are
 * **server** reads: the canonical content is the truth, the Mermaid is recompiled
 * from it by the same compiler the renderer uses, and the browser only saves the
 * bytes it is handed. SVG cannot work that way — it is the *output of a render*,
 * and the contract forbids handing the user Mermaid's raw return value
 * (T068-R04). So the SVG comes from the sanitized string the renderer is already
 * displaying, and this component refuses to offer it when there is nothing
 * sanitized to offer.
 *
 * That produces the honesty rule of this file: **a button exists only when it can
 * do the real thing.** When the diagram has not rendered, the SVG button is not
 * rendered either — not disabled, not present — because a grey control reads as
 * "this would work if you were luckier", which is the impression T068-C05 rules
 * out.
 *
 * Every download goes through `saveBlobAs`, which revokes its object URL
 * immediately after the click. Holding the URL would keep the whole file alive for
 * the life of the page (T068-R05).
 */
import { useState } from 'react';

import type { ViewFreshness } from '@/domain/view';
import { Button, InlineError } from '@/components/ui/primitives';
import { ApiClientError, apiDownload, saveBlobAs } from '@/features/shared/apiClient';

import { flowExportFileName } from '@/domain/flowExport';

export interface ExportFlowProps {
  viewId: string;
  freshness: ViewFreshness | null;
  /**
   * The *sanitized* SVG currently on screen, or null when there is none.
   *
   * Typed as the sanitized artifact rather than as "some SVG string" so a caller
   * cannot hand over Mermaid's raw output by passing the wrong variable. The
   * renderer only ever produces this value through `sanitizeSvgString`.
   */
  sanitizedSvg: string | null;
  /** Asserted before the SVG is offered, so a bad string is never downloadable. */
  isSanitizedSvgSafe: (svg: string) => boolean;
}

export function ExportFlow({ viewId, freshness, sanitizedSvg, isSanitizedSvgSafe }: ExportFlowProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const downloadServerFormat = async (format: 'json' | 'mermaid') => {
    setBusy(format);
    setError(null);
    setDone(null);
    try {
      const { blob, filename } = await apiDownload(`/api/views/${viewId}/export`, { format });
      saveBlobAs(
        blob,
        filename ?? `feini-flow-${viewId}.${format === 'json' ? 'json' : 'mmd'}`,
      );
      setDone(format);
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : '导出失败，请稍后重试');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Save the on-screen picture as a file.
   *
   * The safety check runs again here, immediately before the write, even though the
   * string came from the sanitizer. That is not redundancy for its own sake: this is
   * the one place where an artifact leaves the machine, and the check answers
   * "is what I am about to hand over safe?" rather than "was the sanitizer called?"
   * — a question worth being able to answer at the boundary (T068-C03).
   */
  const downloadSvg = () => {
    setError(null);
    setDone(null);
    if (sanitizedSvg === null) {
      setError('流程图还没有成功渲染，因此没有可导出的安全 SVG');
      return;
    }
    if (!isSanitizedSvgSafe(sanitizedSvg)) {
      setError('当前渲染结果没有通过安全净化，已拒绝导出');
      return;
    }
    setBusy('svg');
    try {
      const blob = new Blob([sanitizedSvg], { type: 'image/svg+xml; charset=utf-8' });
      saveBlobAs(
        blob,
        flowExportFileName({ format: 'svg', viewId, exportedAt: new Date().toISOString() }),
      );
      setDone('svg');
    } finally {
      setBusy(null);
    }
  };

  const svgAvailable = sanitizedSvg !== null && isSanitizedSvgSafe(sanitizedSvg);
  const stale = freshness !== null && (freshness.isStale || freshness.missingSourceCount > 0);

  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3"
      data-testid="export-flow"
      aria-label="导出流程图"
    >
      <h3 className="text-sm text-[var(--ink)]">导出</h3>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          data-testid="export-flow-json"
          disabled={busy !== null}
          onClick={() => void downloadServerFormat('json')}
        >
          {busy === 'json' ? '正在导出…' : '导出 JSON'}
        </Button>
        <Button
          variant="secondary"
          data-testid="export-flow-mermaid"
          disabled={busy !== null}
          onClick={() => void downloadServerFormat('mermaid')}
        >
          {busy === 'mermaid' ? '正在导出…' : '导出 Mermaid 源码'}
        </Button>
        {svgAvailable ? (
          <Button
            variant="secondary"
            data-testid="export-flow-svg"
            disabled={busy !== null}
            onClick={downloadSvg}
          >
            {busy === 'svg' ? '正在导出…' : '导出当前 SVG'}
          </Button>
        ) : null}
      </div>

      <ul className="flex flex-col gap-1 text-xs text-[var(--ink-muted)]">
        <li data-testid="export-flow-hint-json">
          JSON：包含结构化节点与边、来源版本与推测标记，适合机器读取或留档校验。
        </li>
        <li data-testid="export-flow-hint-mermaid">
          Mermaid 源码：由受限编译器从结构化内容重新生成，不是模型直接给出的文本。
        </li>
        <li data-testid="export-flow-hint-svg">
          {svgAvailable
            ? 'SVG：导出画面上这张经过净化的图，事件、外部引用与脚本都已被移除。'
            : 'SVG：当前没有成功渲染的图，因此这个入口不显示。渲染成功后才会出现。'}
        </li>
      </ul>

      <p className="text-xs text-[var(--ink-muted)]" data-testid="export-flow-restore-note">
        单张流程的导出只是投影快照：它含来源 ID 与版本，不含原文，不能用来恢复整个知识库。
      </p>

      {stale ? (
        <p className="text-xs text-[var(--warn-ink)]" data-testid="export-flow-stale-warning">
          {freshness?.reason ?? '来源版本已变化'}
          ，导出的文件会写明生成时间与依据是否已变化，不会被标成最新整理。
        </p>
      ) : null}

      {done ? (
        <p className="text-xs text-[var(--ink)]" role="status" data-testid="export-flow-done">
          已开始下载。
        </p>
      ) : null}

      {error ? (
        <InlineError message={error}>
          <span className="text-xs" data-testid="export-flow-error-note">
            导出失败不会保存任何文件，可以重试。
          </span>
        </InlineError>
      ) : null}
    </section>
  );
}
