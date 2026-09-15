/**
 * The exportable shape of a run's diagnostics (T041-R06).
 *
 * The whitelist lives in the *type*, and the builder below is the only way to
 * produce one. Two consequences follow, and both are the point:
 *
 *   - There is no field for an API key, note text, an absolute path, a session
 *     token or a provider response body, so no future caller can leak one by
 *     adding a key to an object and passing it along.
 *   - A test can assert that the serialized export contains exactly the
 *     whitelisted keys, which turns "the export is safe" into a checkable claim
 *     rather than a review of prose.
 *
 * Import is intentionally absent: this is a one-way projection.
 */
import {
  formatDuration,
  runKindLabel,
  type RunDiagnostics,
  type RunErrorCategory,
  type RunUsageView,
} from './runDto';

export interface DiagnosticUsageExport {
  reported: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface DiagnosticExport {
  application: 'feini-brain';
  runId: string;
  kind: string;
  kindLabel: string;
  state: string;
  model: string;
  endpointOrigin: string;
  promptVersion: string;
  structuredMode: string;
  tokenField: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  durationText: string;
  providerRequestCount: number;
  repairAttempts: number;
  usage: DiagnosticUsageExport;
  candidateCount: number;
  errorCode: string | null;
  errorCategory: RunErrorCategory | null;
  errorCategoryLabel: string | null;
  errorMessage: string | null;
  errorRetryable: boolean | null;
  billingNote: string | null;
}

function usageExport(usage: RunUsageView): DiagnosticUsageExport {
  return {
    reported: usage.reported,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

/**
 * Project diagnostics onto the exportable whitelist.
 *
 * Every field is named explicitly. Note what is dropped rather than copied:
 * `candidateIds` (ids are structure, not a diagnosis), `subjectId` and
 * `resultRef` (local entity identifiers that add nothing to a bug report), and
 * the endpoint path (the origin alone is enough to identify the provider).
 */
export function toDiagnosticExport(diagnostics: RunDiagnostics): DiagnosticExport {
  return {
    application: 'feini-brain',
    runId: diagnostics.runId,
    kind: diagnostics.kind,
    kindLabel: runKindLabel(diagnostics.kind),
    state: diagnostics.state,
    model: diagnostics.model,
    endpointOrigin: diagnostics.endpointOrigin,
    promptVersion: diagnostics.promptVersion,
    structuredMode: diagnostics.structuredMode,
    tokenField: diagnostics.tokenField,
    startedAt: diagnostics.startedAt,
    finishedAt: diagnostics.finishedAt,
    durationMs: diagnostics.durationMs,
    durationText: formatDuration(diagnostics.durationMs),
    providerRequestCount: diagnostics.providerRequestCount,
    repairAttempts: diagnostics.repairAttempts,
    usage: usageExport(diagnostics.usage),
    candidateCount: diagnostics.candidateCount,
    errorCode: diagnostics.error?.code ?? null,
    errorCategory: diagnostics.error?.category ?? null,
    errorCategoryLabel: diagnostics.error?.categoryLabel ?? null,
    errorMessage: diagnostics.error?.message ?? null,
    errorRetryable: diagnostics.error?.retryable ?? null,
    billingNote: diagnostics.billingNote,
  };
}

/**
 * Export as indented JSON.
 *
 * JSON rather than a prose block so the user can paste it into a report without
 * anyone re-typing field names, and so a test can parse it and compare key sets.
 */
export function diagnosticExportToJson(diagnostics: RunDiagnostics): string {
  return JSON.stringify(toDiagnosticExport(diagnostics), null, 2);
}

/**
 * Export as short Chinese lines, for users who would rather read it first.
 *
 * Unknown usage is spelled out as 未知 rather than omitted: an absent line reads
 * as "zero" or "fine", while 未知 states the fact that the provider returned
 * nothing usable (T041-R02).
 */
export function diagnosticExportToText(diagnostics: RunDiagnostics): string {
  const exported = toDiagnosticExport(diagnostics);
  const lines: string[] = [
    'feini-brain 运行诊断（已脱敏，可直接粘贴）',
    `运行：${exported.kindLabel}（${exported.kind}）· ${exported.state}`,
    `运行 ID：${exported.runId}`,
    `模型：${exported.model || '（未记录）'}`,
    `接口地址：${exported.endpointOrigin}`,
    `提示词版本：${exported.promptVersion}`,
    `结构化档位：${exported.structuredMode || '（未记录）'}`,
    `长度参数：${exported.tokenField || '（未记录）'}`,
    `开始：${exported.startedAt}`,
    `结束：${exported.finishedAt ?? '（未结束）'}`,
    `耗时：${exported.durationText}`,
    `服务商请求次数：${exported.providerRequestCount}`,
    `其中格式修复次数：${exported.repairAttempts}`,
  ];

  if (exported.usage.reported) {
    lines.push(
      `用量（服务商返回）：输入 ${exported.usage.inputTokens ?? '未知'} · ` +
        `输出 ${exported.usage.outputTokens ?? '未知'} · 合计 ${exported.usage.totalTokens ?? '未知'}`,
    );
  } else {
    lines.push('用量：未知（服务商没有返回）');
  }

  lines.push(`本次发送候选数：${exported.candidateCount}`);

  if (exported.errorCode) {
    lines.push(
      `错误：${exported.errorCode}（${exported.errorCategoryLabel ?? '未分类'}）`,
      `说明：${exported.errorMessage ?? ''}`,
    );
  }
  if (exported.billingNote) lines.push(`计费说明：${exported.billingNote}`);

  return lines.join('\n');
}
