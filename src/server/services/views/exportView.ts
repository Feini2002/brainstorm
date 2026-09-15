/**
 * Export one saved projection (T060 mindmap, T068 flow).
 *
 * The whole module is a read: it composes the view's canonical content with its
 * freshness verdict and hands back bytes plus a filename. Three properties are
 * worth stating because they are the ones a caller could break from outside:
 *
 *  - **Nothing is written anywhere.** No temp file, no path assembled from user
 *    input, no cache updated. The response body *is* the artifact (T060-R04,
 *    T068-R05). This is why the function returns a value rather than a stream it
 *    manages.
 *  - **No model is called and no `generatedAt` is touched.** Exporting is not
 *    re-analysis, so two exports of an unchanged view differ only in `exportedAt`
 *    (T060-C05, T068-C01).
 *  - **Format support is a property of the *kind*, not of the endpoint.** A graph
 *    has neither a tree nor a diagram, a mindmap has no Mermaid, and a flow has no
 *    Markdown *display* form in this build (its Mermaid source is the readable
 *    derivative). Crossing them is refused rather than coerced: an export named
 *    "mindmap" that contained a flowchart would be a file that lies about what it
 *    is (T068-R01, T060-R06).
 *
 * The freshness figures are computed here from the same `computeStaleness` the
 * banner uses, rather than copied from a cached flag, so the file and the screen
 * cannot disagree about whether the basis moved.
 *
 * **SVG is deliberately absent from the server's flow formats.** It is the output
 * of a render, and the contract forbids handing the user Mermaid's raw return
 * value (T068-R04); the only sanitized SVG in the system is the one a browser has
 * already purified. The client exports that string, and the server refuses the
 * format so a direct API caller cannot get an unpurified one.
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import {
  buildFlowExportJson,
  buildFlowMermaid,
  flowExportContentType,
  flowExportFileName,
  isServerFlowExportFormat,
  type FlowServerExportFormat,
} from '@/domain/flowExport';
import type { UUID } from '@/domain/knowledge';
import { computeStaleness, describeStaleness } from '@/domain/view';
import {
  buildViewExportJson,
  buildViewMarkdown,
  exportContentType,
  exportFileName,
  isViewExportFormat,
  type ViewExportFormat,
} from '@/domain/viewExport';
import { getView, readCurrentSourceState } from './views';

/** Every format the endpoint accepts, across all kinds. */
export const EXPORT_FORMATS = ['markdown', 'json', 'mermaid'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}

export interface ViewExportFile {
  body: string;
  contentType: string;
  fileName: string;
}

/**
 * Produce the download for one saved view.
 *
 * `format` has already been validated as *a* known format by the caller's query
 * schema; whether it fits *this kind* is decided here, because only here is the
 * stored kind known. The parameter is typed as a plain string so a direct service
 * caller asking for `svg` gets the named refusal below rather than a type error it
 * would have to work around.
 */
export function exportView(
  db: DatabaseSync,
  input: { id: UUID; format: string; now: string },
): ViewExportFile {
  const view = getView(db, input.id);

  const staleness = computeStaleness(
    view.sourceSnapshot,
    readCurrentSourceState(db, view.sourceSnapshot),
  );
  const freshness = {
    isStale: staleness.isStale,
    changedItemCount: staleness.changedItemIds.length,
    changedRelationCount: staleness.changedRelationIds.length,
    missingSourceCount: staleness.missingSources.length,
    reason: describeStaleness(staleness),
  };

  if (view.kind === 'flow') {
    if (!isServerFlowExportFormat(input.format)) {
      throw new AppError(
        'VALIDATION',
        (input.format as string) === 'svg'
          ? 'SVG 只在浏览器里由已净化的渲染结果生成，不能从服务器直接导出'
          : '流程图只支持导出 JSON 与 Mermaid 源码',
      );
    }
    const format: FlowServerExportFormat = input.format;
    const buildInput = { view, exportedAt: input.now, freshness };
    return {
      body: format === 'json' ? buildFlowExportJson(buildInput) : buildFlowMermaid(buildInput),
      contentType: flowExportContentType(format),
      fileName: flowExportFileName({ format, viewId: view.id, exportedAt: input.now }),
    };
  }

  if (view.kind !== 'mindmap') {
    // Graphs have positions rather than a tree or a diagram, so every format would
    // produce a file whose name misdescribes it.
    throw new AppError('VALIDATION', '当前只支持导出思维导图与流程图视图');
  }

  if (!isViewExportFormat(input.format)) {
    throw new AppError('VALIDATION', '思维导图只支持导出 Markdown 与 JSON');
  }
  const format: ViewExportFormat = input.format;
  const buildInput = { view, exportedAt: input.now, freshness };
  return {
    body: format === 'markdown' ? buildViewMarkdown(buildInput) : buildViewExportJson(buildInput),
    contentType: exportContentType(format),
    fileName: exportFileName({ format, viewId: view.id, exportedAt: input.now }),
  };
}
