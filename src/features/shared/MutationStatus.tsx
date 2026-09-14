'use client';

/**
 * Honest status lines for writes (T025).
 *
 * The distinctions this file exists to keep:
 *
 *  - **saving vs saved** — "saved" is only shown after the server said so; the
 *    in-flight state says "正在保存" and never claims success (T025-R01).
 *  - **unknown completion** — when the response was lost, the outcome is stated
 *    as unknown with a retry that reuses the same request key, so the retry can
 *    only ever produce the one record (T025-R02).
 *  - **saved but organize failed** — the two phases are reported separately. A
 *    failed organize never rewrites "已保存" into "保存失败" (T025-R04).
 *
 * The status line is text, not a blocking overlay: an error must not cover the
 * input area or the user cannot keep writing (T025-R06).
 */
import { Button, InlineError } from '@/components/ui/primitives';

export type MutationPhase = 'idle' | 'saving' | 'saved' | 'unknown' | 'failed';

export interface MutationStatusProps {
  message: string | null;
  onDismiss?: () => void;
  testId?: string;
}

/** A quiet confirmation line that reserves its space to avoid layout jumps. */
export function StatusLine({ message, onDismiss, testId }: MutationStatusProps) {
  return (
    <p
      role="status"
      aria-live="polite"
      data-testid={testId ?? 'mutation-status'}
      className="min-h-5 text-xs text-[var(--success)]"
    >
      {message ?? ''}
      {message && onDismiss ? (
        <Button variant="ghost" className="ml-1" onClick={onDismiss}>
          知道了
        </Button>
      ) : null}
    </p>
  );
}

export interface SavePhaseProps {
  phase: MutationPhase;
  /** True when the record is already stored; distinct from the organize result. */
  stored: boolean;
  message: string | null;
  onRetry?: () => void;
  onDismiss?: () => void;
}

/**
 * The combined "save / save & organize" status.
 *
 * `stored` is passed in rather than derived, because only the caller knows
 * whether an item id came back — that fact is what makes "已保存" truthful even
 * when a later step failed.
 */
export function SavePhaseStatus({
  phase,
  stored,
  message,
  onRetry,
  onDismiss,
}: SavePhaseProps) {
  if (phase === 'saving') {
    return (
      <p role="status" aria-live="polite" data-testid="save-phase" className="min-h-5 text-xs text-[var(--ink-muted)]">
        正在保存…
      </p>
    );
  }

  if (phase === 'unknown') {
    return (
      <div data-testid="save-phase" className="text-xs text-[var(--warn-ink)]">
        <p role="status" aria-live="polite">
          保存结果未知：请求可能已经提交。重试会复用同一次请求，不会重复创建。
        </p>
        {onRetry ? (
          <Button variant="secondary" className="mt-1" onClick={onRetry}>
            用同一次请求重试
          </Button>
        ) : null}
      </div>
    );
  }

  if (phase === 'failed') {
    return (
      <InlineError message={message ?? '保存失败'}>
        {onRetry ? (
          <Button variant="secondary" onClick={onRetry}>
            重试
          </Button>
        ) : null}
      </InlineError>
    );
  }

  if (phase === 'saved') {
    return (
      <StatusLine
        message={stored ? (message ?? '已保存') : message}
        {...(onDismiss ? { onDismiss } : {})}
        testId="save-phase"
      />
    );
  }

  return <p data-testid="save-phase" className="min-h-5 text-xs text-[var(--ink-muted)]" />;
}
