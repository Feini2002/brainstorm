'use client';

/**
 * Connection-test result panel (T032-R02/R06).
 *
 * Two facts are shown separately because they fail separately: the request
 * reached the provider (`connected`), and the reply matched the required shape
 * (`replyAccepted`). Collapsing them into one green tick is how a format problem
 * gets misreported as a network problem.
 *
 * The footer is not decoration. A successful test proves one small request
 * worked; it does not prove long organizes will, and saying so is cheaper than
 * letting the user discover it later (T032-R06).
 */
export interface TestResultValue {
  connected: boolean;
  replyAccepted: boolean;
  latencyMs: number;
  message: string;
  model?: string | null;
  /** True while the request is in flight, so the button can stay busy. */
  running?: boolean;
}

export interface TestResultProps {
  value: TestResultValue | null;
}

export function TestResult({ value }: TestResultProps) {
  if (!value) return null;
  const ok = value.connected && value.replyAccepted;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="settings-test-result"
      data-ok={ok ? 'true' : 'false'}
      className={`rounded-md border p-3 text-sm ${
        ok ? 'border-[var(--line)]' : 'border-[var(--danger)] text-[var(--danger)]'
      }`}
    >
      <ul className="flex flex-col gap-1">
        <li data-testid="test-connection-state">
          连接：{value.connected ? '通过' : '未通过'}
        </li>
        <li data-testid="test-format-state">
          结构校验：{value.replyAccepted ? '通过' : '未通过'}
        </li>
        {value.latencyMs > 0 ? (
          <li className="text-[var(--ink-muted)]">用时约 {value.latencyMs} ms</li>
        ) : null}
      </ul>

      <p className="mt-2">{value.message}</p>
      {value.model ? (
        <p className="text-xs text-[var(--ink-muted)]">请求使用的模型：{value.model}</p>
      ) : null}
      <p className="mt-1 text-xs text-[var(--ink-muted)]">
        这次测试只证明当前地址、Key、模型和 JSON 档位能完成一次小请求；不代表长任务、所有材料或所有模型都可靠。
      </p>
    </div>
  );
}
