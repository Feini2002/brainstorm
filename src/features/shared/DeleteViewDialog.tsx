'use client';

/**
 * Delete confirmation for a *saved view* (T053-R03, T082-R05).
 *
 * The item-deleting dialog and this one must never be mistakable for each other.
 * Both are destructive and both are one click from the same page, so the words
 * carry the whole difference: this one deletes a projection, and it says out loud
 * that the knowledge behind it survives (T082-R05). A confirmation that only said
 * 「确定删除？」 would make the two operations look alike and the user would learn
 * the difference afterwards.
 *
 * Three parts, in this order:
 *
 *  1. **What goes.** The view's name, quoted, plus its kind, so the user deletes
 *     the one they are looking at.
 *  2. **What stays.** Knowledge items, tags and relations. This is the sentence
 *     that makes the choice informed rather than merely confirmed.
 *  3. **The way back.** Regeneration is possible from the same page, so the
 *     consequence is recoverable and saying so is not reassurance, it is fact.
 *
 * `expectedRevision` is required by the API, which is why the caller passes the
 * revision it displayed: deleting a view someone changed elsewhere must fail with
 * a conflict instead of discarding a newer name or layout.
 */
import { useEffect, useRef, useState } from 'react';

import { Button, InlineError } from '@/components/ui/primitives';
import { ApiClientError } from '@/features/shared/apiClient';
import { DANGER_SCOPE, waitingFor } from '@/features/shared/StatusLabel';

export interface DeleteViewDialogProps {
  /** The view's display name, so the dialog names what is being deleted. */
  viewName: string;
  /** Kind label (`脑图` / `流程` / `关系图`), for a name that is not unique. */
  kindLabel: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

export function DeleteViewDialog({
  viewName,
  kindLabel,
  onConfirm,
  onCancel,
}: DeleteViewDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  /**
   * Focus lands on *cancel*, opposite to the item dialog.
   *
   * The item dialog focuses its confirm button because deleting a record is a
   * decision the user already made in the drawer and the dialog is the last step.
   * A view is deleted from a list the user is browsing, so an Enter that was
   * meant for "open" must not delete; the safe control takes focus and the
   * destructive one requires a deliberate Tab.
   */
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const run = async () => {
    setDeleting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (caught) {
      if (caught instanceof ApiClientError) setError(caught);
      else
        setError(
          new ApiClientError({ code: 'INTERNAL', message: '删除视图失败', retryable: false }),
        );
      setDeleting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-view-title"
      aria-describedby="delete-view-scope"
      data-testid="delete-view-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4 shadow-lg">
        <h2 id="delete-view-title" className="text-base font-semibold text-[var(--ink)]">
          删除这张{kindLabel}视图？
        </h2>
        <p
          id="delete-view-scope"
          className="mt-2 text-sm text-[var(--ink-muted)]"
          data-testid="delete-view-scope"
        >
          「{viewName}」{DANGER_SCOPE.deleteView}
        </p>

        {error ? (
          <div className="mt-3">
            <InlineError message={error.message}>
              {error.code === 'REVISION_CONFLICT' ? (
                <p className="text-xs">
                  这张视图刚被改过（可能改了名字或布局），请重新载入列表再决定，避免丢掉新改动。
                </p>
              ) : null}
              {error.code === 'NOT_FOUND' ? (
                <p className="text-xs">这张视图已经不在了，刷新列表即可看到最新状态。</p>
              ) : null}
            </InlineError>
          </div>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button
            ref={cancelRef}
            variant="secondary"
            data-testid="delete-view-cancel"
            disabled={deleting}
            onClick={onCancel}
          >
            取消
          </Button>
          <Button
            variant="danger"
            data-testid="delete-view-confirm"
            disabled={deleting}
            onClick={() => void run()}
          >
            {deleting ? waitingFor('删除') : '删除这张视图'}
          </Button>
        </div>
      </div>
    </div>
  );
}
