/**
 * Export one saved mindmap (T060).
 *
 * The whole module is a read: it composes the view's canonical content with its
 * freshness verdict and hands back bytes plus a filename. Two properties are worth
 * stating because they are the ones a caller could break from outside:
 *
 *  - **Nothing is written anywhere.** No temp file, no path assembled from user
 *    input, no cache updated. The response body is the artifact (T060-R04). This
 *    is why the function returns a value rather than a stream it manages.
 *  - **No model is called and no `generatedAt` is touched.** Exporting is not
 *    re-analysis, so two exports of an unchanged view differ only in
 *    `exportedAt` (T060-C05).
 *
 * The freshness figures are computed here from the same `computeStaleness` the
 * banner uses, rather than copied from a cached flag, so the file and the screen
 * cannot disagree about whether the basis moved.
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import type { UUID } from '@/domain/knowledge';
import { computeStaleness, describeStaleness } from '@/domain/view';
import {
  buildViewExportJson,
  buildViewMarkdown,
  exportContentType,
  exportFileName,
  type BuildViewExportInput,
  type ViewExportFormat,
} from '@/domain/viewExport';
import { getView, readCurrentSourceState } from './views';

export interface ViewExportFile {
  body: string;
  contentType: string;
  fileName: string;
}

/**
 * Produce the download for one mindmap view.
 *
 * `format` has already been validated by the caller's query schema; the guard here
 * is for direct service callers, which are the ones a test drives.
 */
export function exportView(
  db: DatabaseSync,
  input: { id: UUID; format: ViewExportFormat; now: string },
): ViewExportFile {
  const view = getView(db, input.id);
  if (view.kind !== 'mindmap') {
    // Only mindmap export is in scope for T060. Refusing is the honest answer: a
    // graph has positions rather than a tree, and emitting its JSON under a
    // "mindmap export" name would be a file that lies about what it is.
    throw new AppError('VALIDATION', '当前只支持导出思维导图视图');
  }

  const staleness = computeStaleness(
    view.sourceSnapshot,
    readCurrentSourceState(db, view.sourceSnapshot),
  );

  const buildInput: BuildViewExportInput = {
    view,
    exportedAt: input.now,
    freshness: {
      isStale: staleness.isStale,
      changedItemCount: staleness.changedItemIds.length,
      changedRelationCount: staleness.changedRelationIds.length,
      missingSourceCount: staleness.missingSources.length,
      reason: describeStaleness(staleness),
    },
  };

  return {
    body:
      input.format === 'markdown' ? buildViewMarkdown(buildInput) : buildViewExportJson(buildInput),
    contentType: exportContentType(input.format),
    fileName: exportFileName({
      format: input.format,
      viewId: view.id,
      exportedAt: input.now,
    }),
  };
}
