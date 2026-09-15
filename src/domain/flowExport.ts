/**
 * Flow export (T068).
 *
 * Same architecture as the mindmap export (`src/domain/viewExport.ts`), with two
 * differences that come from what a flow *is*:
 *
 *  1. **The Mermaid source is compiled here, from the AST.** A flow view stores
 *     nodes and edges, never a Mermaid string, so there is no cached source that
 *     could be exported by accident (T068-R02, T067-R02). The compiler that writes
 *     this file is the one the renderer draws with, which is what makes "what you
 *     see" and "what you exported" the same document (docs/03_contracts/09 §4).
 *  2. **The export says how uncertain it is.** A `hypothesis` edge leaves the
 *     application with its dashed style and its 「推测：」 prefix intact, and the
 *     provenance block repeats it in words. A reader who receives the file without
 *     this application must be able to tell a guess from an established
 *     connection, and inside the app that distinction is carried by styling the
 *     file does not have (T068-C02).
 *
 * What is deliberately absent is the same whitelist-by-type discipline the mindmap
 * export uses: there is no field for an API key, a base URL, a request body or a
 * `messages` array. The only way to add one is to add it to the interface, which is
 * a reviewable change (T068-R03, T068-C04).
 */
import { compileFlow } from './compileFlow';
import type { FlowContent, ViewDTO } from './knowledge';
import { FLOW_COMPILER_VERSION } from './compileFlow';
import { flowHypothesisEdges, flowReferencedRelationIds } from './validateFlow';

/** Bumped when the exported field set or its meaning changes. */
export const FLOW_EXPORT_SCHEMA_VERSION = 1;

/**
 * The formats this build can produce *and* has verified (T068-R01, T068-C05).
 *
 * `svg` is here because it now has a real, tested producer: `sanitizeSvgString`
 * plus `findUnsafeSvgMarkup` in the renderer, exercised by
 * `tests/e2e/flow-security.spec.ts` (the contract names a
 * `mermaid-security.spec.ts`; that file does not exist and this one is the
 * deliberate equivalent — see its header for why the name differs). It was absent
 * while it was not, and the UI had no button for it — a disabled SVG button would
 * have made the menu look complete at exactly the moment the user was finding out
 * what it can do.
 *
 * The server still refuses to *generate* an SVG, and that asymmetry is the point:
 * the sanitized picture only exists after a browser has rendered and purified it
 * (T068-R04 「不直接下载原始Mermaid返回值」). So the SVG is produced client-side
 * from the same sanitized string that is already on screen. `isServerFlowExportFormat`
 * is the guard the route applies, and it is deliberately narrower than this list.
 */
export const FLOW_EXPORT_FORMATS = ['json', 'mermaid', 'svg'] as const;
export type FlowExportFormat = (typeof FLOW_EXPORT_FORMATS)[number];

export function isFlowExportFormat(value: string): value is FlowExportFormat {
  return (FLOW_EXPORT_FORMATS as readonly string[]).includes(value);
}

/** What `GET /api/views/{id}/export` can return for a flow. SVG is browser-side. */
export const FLOW_SERVER_EXPORT_FORMATS = ['json', 'mermaid'] as const;
export type FlowServerExportFormat = (typeof FLOW_SERVER_EXPORT_FORMATS)[number];

export function isServerFlowExportFormat(value: string): value is FlowServerExportFormat {
  return (FLOW_SERVER_EXPORT_FORMATS as readonly string[]).includes(value);
}

/** The export's `kind` discriminator, so a reader can tell the two apart. */
export const FLOW_EXPORT_KIND = 'flow';

export interface FlowExport {
  application: 'feini-brain';
  schemaVersion: number;
  kind: 'flow';
  viewId: string;
  name: string;
  /**
   * When the *content* was generated. Null for a view with no run, and never
   * replaced by the export time — the two mean different things, and an export
   * that overwrote this would misreport when the material was read.
   */
  generatedAt: string | null;
  /** When this file was produced. The only field that differs between two exports. */
  exportedAt: string;
  /** The compiler that produced the Mermaid in this export. */
  compilerVersion: string;
  /** The observation question the flow was asked to answer, as stored on the run. */
  promptVersion: string | null;
  contentHash: string | null;
  /** The canonical content: nodes, edges and the layout direction. */
  content: FlowContent;
  sourceSnapshot: ViewDTO['sourceSnapshot'];
  /**
   * The edges that are guesses, named so a consumer does not have to re-derive
   * them from `kind` (T068-C02).
   */
  hypotheses: { source: string; target: string; label: string }[];
  /** Relation ids the flow cites, with the revision the snapshot recorded. */
  citedRelations: { id: string; revision: number | null }[];
  /**
   * The freshness verdict at export time, so a file opened in an editor still says
   * whether its basis moved (T068-R02).
   */
  freshness: {
    isStale: boolean;
    changedItemCount: number;
    changedRelationCount: number;
    missingSourceCount: number;
    reason: string | null;
  };
  /**
   * What this file is *not*, stated in the file itself (T068-C06).
   *
   * A single view's JSON contains ids and versions, not the notes' text, so it
   * cannot restore a library and must not be presented as if it could. That is the
   * whole of `docs/03_contracts/10_backup_bundle.md`'s warning in one line, and it
   * belongs in the artifact rather than only in the UI, because the file is what
   * gets passed around.
   */
  restoreScope: {
    kind: 'single-view';
    isFullBackup: false;
    note: string;
  };
}

export interface BuildFlowExportInput {
  view: ViewDTO & { kind: 'flow' };
  exportedAt: string;
  freshness: FlowExport['freshness'];
}

const RESTORE_SCOPE_NOTE =
  '这是单张流程视图的导出，不是完整知识库备份：它只含结构化画法与来源 ID、版本，不含原文。恢复整个知识库请使用 /api/export 的整库导出。';

export function buildFlowExport(input: BuildFlowExportInput): FlowExport {
  const { view } = input;
  return {
    application: 'feini-brain',
    schemaVersion: FLOW_EXPORT_SCHEMA_VERSION,
    kind: FLOW_EXPORT_KIND,
    viewId: view.id,
    name: view.name,
    generatedAt: view.generatedAt,
    exportedAt: input.exportedAt,
    compilerVersion: FLOW_COMPILER_VERSION,
    promptVersion: view.promptVersion,
    contentHash: view.contentHash,
    content: view.content,
    sourceSnapshot: view.sourceSnapshot,
    hypotheses: flowHypothesisEdges(view.content),
    citedRelations: flowReferencedRelationIds(view.content).map((id) => ({
      id,
      revision: view.sourceSnapshot.relations.find((entry) => entry.id === id)?.revision ?? null,
    })),
    freshness: input.freshness,
    restoreScope: { kind: 'single-view', isFullBackup: false, note: RESTORE_SCOPE_NOTE },
  };
}

/**
 * The Mermaid source file, with a provenance header above it.
 *
 * The header is a Mermaid comment (`%%`), not Markdown: the file has a `.mmd`
 * extension and the user may well paste it straight into another Mermaid
 * renderer, so a `#` heading would either break that renderer or be silently
 * swallowed. Comments are the one construct that is inert in every Mermaid
 * version, and the compiler never emits one itself — so the header cannot be
 * confused with the compiled diagram body.
 */
export function buildFlowMermaid(input: BuildFlowExportInput): string {
  const exported = buildFlowExport(input);
  const compiled = compileFlow(exported.content);
  if (!compiled.ok) {
    // A view whose content is no longer drawable is reported as a failure rather
    // than exported as an empty diagram: an empty file looks like a flow with
    // nothing in it, which is a different claim (T063-C03).
    throw new Error(
      `这张流程图的内容无法编译为 Mermaid：${compiled.issues.map((issue) => issue.message).join('；')}`,
    );
  }

  const lines: string[] = [];
  lines.push('%% 由 Feini Brain 导出，内容由受限编译器生成，不是模型直接给出的源码。');
  lines.push(`%% 视图名称：${exported.name}`);
  lines.push(`%% 视图 ID：${exported.viewId}`);
  lines.push(`%% 生成时间：${exported.generatedAt ?? '（没有生成记录）'}`);
  lines.push(`%% 导出时间：${exported.exportedAt}`);
  lines.push(`%% 编译器版本：${exported.compilerVersion}`);
  if (exported.contentHash !== null) lines.push(`%% 内容哈希：${exported.contentHash}`);

  if (exported.hypotheses.length > 0) {
    lines.push(
      `%% 图中有 ${exported.hypotheses.length} 条虚线边是模型标注的推测，不是已确认的因果，文字里保留了「推测」前缀。`,
    );
  } else {
    lines.push('%% 图中没有推测连接。');
  }

  if (exported.freshness.reason !== null || exported.freshness.missingSourceCount > 0) {
    lines.push(
      `%% ⚠️ 依据可能已过期：${exported.freshness.reason ?? `${exported.freshness.missingSourceCount} 条来源已删除`}`,
    );
    lines.push('%% 这份导出反映生成当时的材料，不代表知识库的最新状态。');
  }

  lines.push(`%% 来源：${exported.sourceSnapshot.items.length} 条笔记，${exported.sourceSnapshot.relations.length} 条关系`);
  for (const item of exported.sourceSnapshot.items) {
    lines.push(`%% - item ${item.id} 原文 v${item.rawVersion} · revision ${item.revision}`);
  }
  for (const relation of exported.citedRelations) {
    lines.push(
      `%% - relation ${relation.id} ${relation.revision === null ? '（不在快照中）' : `revision ${relation.revision}`}`,
    );
  }
  lines.push('');
  lines.push(compiled.compiled.source);
  lines.push('');
  return lines.join('\n');
}

export function buildFlowExportJson(input: BuildFlowExportInput): string {
  return `${JSON.stringify(buildFlowExport(input), null, 2)}\n`;
}

/**
 * A download filename that cannot become a path.
 *
 * Exactly the mindmap export's rule: the title is not used *at all*, and the name
 * is built from a fixed prefix, the view id and a date. Any title-derived name has
 * to survive its own sanitization, and every such rule is a bet on having caught
 * encoding tricks, Unicode separators and Windows reserved device names. A UUID and
 * a date have no such surface, and the title is preserved inside the file
 * (docs/03_contracts/09 §6). `name` is accepted and deliberately unused.
 */
export function flowExportFileName(input: {
  format: FlowExportFormat;
  viewId: string;
  exportedAt: string;
}): string {
  const extension = input.format === 'mermaid' ? 'mmd' : input.format === 'svg' ? 'svg' : 'json';
  const date = input.exportedAt.slice(0, 10);
  return `feini-flow-${input.viewId}-${date}.${extension}`;
}

/** The MIME type to serve each format with. */
export function flowExportContentType(format: FlowExportFormat): string {
  switch (format) {
    case 'json':
      return 'application/json; charset=utf-8';
    case 'mermaid':
      return 'text/plain; charset=utf-8';
    case 'svg':
      return 'image/svg+xml; charset=utf-8';
    default: {
      const exhaustive: never = format;
      return exhaustive;
    }
  }
}
