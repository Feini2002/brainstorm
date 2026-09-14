'use client';

/**
 * Delete confirmation (T020-R01).
 *
 * Deleting knowledge is irreversible from the UI, so it always requires an
 * explicit confirmation that names the record and states the consequence
 * (relations are removed with it; saved views keep their history but go stale).
 * A keyboard shortcut in the graph view must not reach this action directly.
 */
import { useEffect, useRef, useState } from 'react';

import { Button, InlineError } from '@/components/ui/primitives';
import { ApiClientError } from '@/features/shared/apiClient';

export interface DeleteItemDialogProps {
  /** Title or a short excerpt, so the dialog names what is being deleted. */
  itemLabel: string;
  /** Count of relations that will be removed with the record. */
  relationCount?: number;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

export function DeleteItemDialog({
  itemLabel,
  relationCount = 0,
  onConfirm,
  onCancel,
}: DeleteItemDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Focus the destructive control so a keyboard user lands on a deliberate spot,
  // but never auto-submit on Enter from the surrounding page.
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  const run = async () => {
    setDeleting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (caught) {
      if (caught instanceof ApiClientError) setError(caught);
      else
        setError(new ApiClientError({ code: 'INTERNAL', message: '删除失败', retryable: false }));
      setDeleting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-title"
      data-testid="delete-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4 shadow-lg">
        <h2 id="delete-title" className="text-base font-semibold text-[var(--ink)]">
          删除这条记录？
        </h2>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">
          「{itemLabel}」的原文与整理结果都会被删除，无法撤销。
          {relationCount > 0
            ? `与它相关的 ${relationCount} 条关系会一并删除。`
            : ''}
          已经保存的图表不会被删除，但会提示来源已变化。
        </p>

        {error ? (
          <div className="mt-3">
            <InlineError message={error.message}>
              {error.code === 'REVISION_CONFLICT' ? (
                <p className="text-xs">这条记录刚被改过，请先重新载入再决定是否删除。</p>
              ) : null}
            </InlineError>
          </div>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" data-testid="delete-cancel" disabled={deleting} onClick={onCancel}>
            取消
          </Button>
          <Button
            ref={confirmRef}
            variant="danger"
            data-testid="delete-confirm"
            disabled={deleting}
            onClick={() => void run()}
          >
            {deleting ? '删除中…' : '确认删除'}
          </Button>
        </div>
      </div>
    </div>
  );
}
