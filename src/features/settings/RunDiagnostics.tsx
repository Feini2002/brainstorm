'use client';

/**
 * Readable detail for one run (T041).
 *
 * Two things this panel refuses to do, because both would turn a diagnosis into
 * a false statement:
 *
 *   - **It never estimates.** When the provider returned no usage, the row says
 *     未知 rather than a number derived from the text length, and there is no
 *     price column at all (T041-R02). A guessed cost looks exactly like a
 *     measured one once it is on screen.
 *   - **It never promises the provider stopped working.** A locally terminated
 *     request (timeout or interrupted lease) shows the billing caveat, because
 *     this machine cannot observe what the provider did after the request left
 *     (T041-R04/C05).
 *
 * The copy button produces the whitelisted export from
 * `src/domain/runDiagnosticsExport.ts`. The preview is shown before copying so
 * the user can see the exact bytes that will leave the page — a share action that
 * silently includes note text is the failure mode T041-C04 tests for.
 */
import { useCallback, useState } from 'react';

import type { RunDiagnostics } from '@/domain/runDto';
import { formatDuration, runKindLabel, runStateLabel } from '@/domain/runDto';
import { diagnosticExportToJson, diagnosticExportToText } from '@/domain/runDiagnosticsExport';
import { Button, InlineError, LoadingIndicator } from '@/components/ui/primitives';
import { useApiQuery } from '@/features/shared/useApiQuery';

export interface RunDiagnosticsProps {
  runId: string | null;
  /**
   * Opens the item this run belongs to. Optional on purpose: when no handler is
   * given, no navigation control is rendered (an inert button would be worse
   * than none), and the byte count entry is omitted rather than faked.
   */
  onOpenItem?: (id: string) => void;
}

/** One labelled row; `data-testid` carries the field name for assertions. */
function Row({
  label,
  value,
  testId,
  hint,
}: {
  label: string;
  value: string;
  testId: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-[var(--ink-muted)]">{label}</dt>
      <dd className="text-sm text-[var(--ink)]" data-testid={testId}>
        {value}
        {hint ? <span className="ml-2 text-xs text-[var(--ink-muted)]">{hint}</span> : null}
      </dd>
    </div>
  );
}

function usageLines(diagnostics: RunDiagnostics): { label: string; value: string; testId: string }[] {
  if (!diagnostics.usage.reported) {
    return [{ label: '服务商返回用量', value: '未知（服务商没有返回）', testId: 'diag-usage' }];
  }
  const { inputTokens, outputTokens, totalTokens } = diagnostics.usage;
  return [
    {
      label: '服务商返回用量',
      value:
        `输入 ${inputTokens ?? '未知'} · 输出 ${outputTokens ?? '未知'} · 合计 ${totalTokens ?? '未知'}`,
      testId: 'diag-usage',
    },
  ];
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the manual copy path below.
  }
  // A local HTTP page can be denied clipboard access; telling the user to select
  // the preview is more useful than a silent failure.
  return false;
}

export function RunDiagnosticsPanel({ runId, onOpenItem }: RunDiagnosticsProps) {
  const state = useApiQuery<RunDiagnostics>(runId === null ? '' : `/api/runs/${runId}/diagnostics`, {
    enabled: runId !== null,
  });
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle');

  const onCopy = useCallback(async () => {
    if (!state.data) return;
    const ok = await copyText(diagnosticExportToText(state.data));
    setCopyState(ok ? 'copied' : 'manual');
  }, [state.data]);

  if (runId === null) return null;
  if (state.loading && state.data === null) {
    return <LoadingIndicator label="正在读取运行详情" />;
  }
  if (state.error && state.data === null) {
    return (
      <InlineError message={state.error.message}>
        <Button variant="secondary" onClick={state.reload}>
          重新读取
        </Button>
      </InlineError>
    );
  }
  const diagnostics = state.data;
  if (!diagnostics) return null;

  const canOpenItem = onOpenItem !== undefined && diagnostics.subjectId !== null;
  const json = diagnosticExportToJson(diagnostics);

  return (
    <div className="flex flex-col gap-4" data-testid="run-diagnostics">
      <dl className="grid gap-3 sm:grid-cols-2">
        <Row
          label="操作与状态"
          value={`${runKindLabel(diagnostics.kind)} · ${runStateLabel(diagnostics.state)}`}
          testId="diag-run-summary"
        />
        <Row label="运行 ID" value={diagnostics.runId} testId="diag-run-id" />
        <Row label="模型" value={diagnostics.model || '（未记录）'} testId="diag-model" />
        <Row label="接口地址" value={diagnostics.endpointOrigin} testId="diag-endpoint" hint="只显示 origin" />
        <Row label="提示词版本" value={diagnostics.promptVersion} testId="diag-prompt-version" />
        <Row
          label="结构化档位"
          value={`${diagnostics.structuredMode || '（未记录）'} · 长度参数 ${diagnostics.tokenField || '（未记录）'}`}
          testId="diag-structured-mode"
        />
        <Row label="开始时间" value={diagnostics.startedAt} testId="diag-started-at" />
        <Row label="结束时间" value={diagnostics.finishedAt ?? '（未结束）'} testId="diag-finished-at" />
        <Row label="耗时" value={formatDuration(diagnostics.durationMs)} testId="diag-duration" />
        <Row
          label="服务商请求次数"
          value={String(diagnostics.providerRequestCount)}
          testId="diag-request-count"
          hint={diagnostics.repairAttempts > 0 ? `其中格式修复 ${diagnostics.repairAttempts} 次` : '未发生格式修复'}
        />
        <Row
          label="本次发送候选数"
          value={String(diagnostics.candidateCount)}
          testId="diag-candidate-count"
          hint="这是实际发送数量，不是上限"
        />
        {usageLines(diagnostics).map((line) => (
          <Row key={line.testId} label={line.label} value={line.value} testId={line.testId} />
        ))}
      </dl>

      {diagnostics.error ? (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-md border border-[var(--danger)] p-3 text-sm"
        >
          <p data-testid="diag-error-category" className="font-medium text-[var(--danger)]">
            {diagnostics.error.categoryLabel}
          </p>
          <p data-testid="diag-error-code" className="text-xs text-[var(--ink-muted)]">
            错误码 {diagnostics.error.code}
            {diagnostics.error.retryable ? ' · 可以显式重试' : ' · 重试前请先改配置'}
          </p>
          <p data-testid="diag-error-message" className="text-[var(--ink)]">
            {diagnostics.error.message}
          </p>
        </div>
      ) : null}

      {diagnostics.billingNote ? (
        <p
          data-testid="diag-billing-note"
          className="rounded-md border border-[var(--warn)] bg-[var(--surface-raised)] p-3 text-sm"
        >
          {diagnostics.billingNote}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" data-testid="diag-copy" onClick={() => void onCopy()}>
          复制脱敏摘要
        </Button>
        {canOpenItem ? (
          <Button
            variant="ghost"
            data-testid="diag-open-source"
            onClick={() => onOpenItem(diagnostics.subjectId as string)}
          >
            回到这次整理的知识条目
          </Button>
        ) : null}
        <span className="text-xs text-[var(--ink-muted)]" data-testid="diag-copy-state">
          {copyState === 'copied'
            ? '已复制。摘要只含运行元信息，不含 Key、原文或本地路径。'
            : copyState === 'manual'
              ? '浏览器拒绝了剪贴板访问，请手动选中下面的预览内容复制。'
              : '摘要不含 Key、原文、完整服务端路径或本地令牌。'}
        </span>
      </div>

      <details className="rounded-md border border-[var(--line)] p-3">
        <summary className="cursor-pointer text-sm text-[var(--ink)]">查看将要复制的脱敏摘要</summary>
        <pre
          data-testid="diag-export-preview"
          className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs text-[var(--ink-muted)]"
        >
          {json}
        </pre>
      </details>

      <p className="text-xs text-[var(--ink-muted)]">
        诊断只读取本地账本：它不会调用模型，不会修改知识或运行记录，也不会把这些内容发送到任何第三方。
      </p>
    </div>
  );
}
