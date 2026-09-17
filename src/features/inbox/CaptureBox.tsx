'use client';

/**
 * Capture box (T013, T025).
 *
 * One textarea, two explicit actions. Nothing about organization is required to
 * save: tags, title and type are not part of capture at all. Ctrl/Cmd+Enter
 * submits, but Enter alone inserts a newline and an in-progress IME composition
 * never submits — with a Chinese IME, Enter is how the user picks a candidate.
 *
 * "只保存" and "保存并整理" report different phases. Save success comes from the
 * create response; the organize step is reported afterwards and never rewrites
 * "已保存" into a failure (T025-R04). With no model configured, "保存并整理"
 * still saves first and then explains the missing configuration (T013-R06).
 */
import { useCallback, useEffect, useRef } from 'react';

import { SOURCE_TYPE_LABELS } from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import { Button, Field, InlineError, Select, TextArea } from '@/components/ui/primitives';
import { SavePhaseStatus } from '@/features/shared/MutationStatus';
import { ACTIONS, waitingFor } from '@/features/shared/StatusLabel';
import { shouldSubmitFromKeyboard } from './captureShortcuts';
import { useCapture, type CaptureResult, type OrganizeUiOutcome } from './useCapture';

const SOURCE_TYPE_ORDER = ['other', 'chatgpt', 'claude', 'web', 'book', 'myself'] as const;

export interface CaptureBoxProps {
  onCreated?: (result: CaptureResult) => void;
  /** Opens the settings page; used when "save & organize" has no model yet. */
  onConfigureModel?: () => void;
  /** Whether an API key is configured; the parent knows, the box does not ask. */
  modelConfigured?: boolean;
  /**
   * The organize step, run only after the raw text is stored (T036). Passed down
   * rather than implemented here: the page owns the run id so it can show the
   * diagnostics for the run it just started (T041).
   */
  organize?: (
    item: { id: string; revision: number },
    context: { requestKey: string },
  ) => Promise<OrganizeUiOutcome>;
}

export function CaptureBox({
  onCreated,
  onConfigureModel,
  modelConfigured = false,
  organize,
}: CaptureBoxProps) {
  const capture = useCapture({
    ...(onCreated ? { onCreated } : {}),
    /**
     * The organize step is attached only when a model is configured.
     *
     * Passing it unconditionally would make "保存并整理" fire a doomed request in
     * a keyless install: the user gets a model error on top of the explanation
     * they were already shown, and the offline path stops being the quiet one
     * (T013-R06 / T024-R01). The hint below is the whole response in that case.
     */
    ...(organize && modelConfigured ? { organize } : {}),
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const saving = capture.phase === 'saving';

  const onSubmitShortcut = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Ctrl/Cmd+Enter is always "只保存". Having a Key does not authorize AI.
      if (!shouldSubmitFromKeyboard(event.nativeEvent)) return;
      event.preventDefault();
      void capture.submit({ mode: 'save' });
    },
    [capture],
  );

  // Keep focus in the textarea so capturing stays low friction.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const onSaveAndOrganize = useCallback(() => {
    if (!modelConfigured) {
      // Never lose the text: save first, then explain that organizing needs a
      // model. The explanation is written into the draft store rather than local
      // state so navigating to the settings page and back does not erase it
      // (T024-R04/R06). The copy comes from the shared vocabulary so this hint and
      // the empty-state hint in Settings say the same thing about the same
      // prerequisite (T082-R03, T082-C03).
      capture.setInputHint(
        `${ACTIONS.organize}需要先在设置里配置模型；这条原文仍会照常保存，离线功能不受影响。`,
      );
      void capture.submit({ mode: 'save-and-organize' });
      return;
    }
    capture.setInputHint(null);
    void capture.submit({ mode: 'save-and-organize' });
  }, [capture, modelConfigured]);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
      <label htmlFor="capture-text" className="text-sm font-semibold text-[var(--ink)]">
        记录一条
      </label>
      {/*
        The textarea stays editable while a save is in flight (T025-C06/R06).
        Disabling it would make the concurrency case impossible instead of
        handled: a slow request must not stop the user from starting the next
        thought. The draft is protected by `draftRevision` in `useCapture`, which
        clears only the exact snapshot the server accepted — so text typed during
        the round trip is kept. Double submission is prevented on the buttons
        (`canSubmit` is false while saving), not by blocking input.
      */}
      <TextArea
        id="capture-text"
        ref={textareaRef}
        data-testid="capture-input"
        rows={4}
        value={capture.draft}
        placeholder="一个词、一句话，或一段资料。原文会先保存。"
        onChange={(event) => capture.setDraft(event.target.value)}
        onKeyDown={onSubmitShortcut}
        aria-describedby="capture-help"
      />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <p id="capture-help" className="text-xs text-[var(--ink-muted)]">
          {capture.codePoints}/{capture.limit} 字 · Ctrl+Enter 保存 · Enter 换行
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            data-testid="capture-save"
            disabled={!capture.canSubmit}
            onClick={() => void capture.submit({ mode: 'save' })}
          >
            {saving ? waitingFor(ACTIONS.save) : '只保存'}
          </Button>
          <Button
            variant="secondary"
            data-testid="capture-save-organize"
            disabled={!capture.canSubmit}
            onClick={onSaveAndOrganize}
          >
            保存并整理
          </Button>
          {capture.phase === 'unknown' ? (
            <Button variant="ghost" data-testid="capture-retry" onClick={() => void capture.retry()}>
              重试
            </Button>
          ) : null}
        </div>
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer text-[var(--ink-muted)]">来源（可选）</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="来源类型" htmlFor="capture-source-type">
            <Select
              id="capture-source-type"
              data-testid="capture-source-type"
              value={capture.sourceType}
              onChange={(event) =>
                capture.setSourceType(event.target.value as typeof capture.sourceType)
              }
            >
              {SOURCE_TYPE_ORDER.map((value) => (
                <option key={value} value={value}>
                  {SOURCE_TYPE_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="来源引用" htmlFor="capture-source-ref" hint="例如书名页码、链接或对话标题">
            <TextArea
              id="capture-source-ref"
              data-testid="capture-source-ref"
              rows={2}
              value={capture.sourceRef}
              onChange={(event) => capture.setSourceRef(event.target.value)}
              placeholder="可不填"
            />
          </Field>
        </div>
      </details>

      {capture.overLimit ? (
        <InlineError message={`原文只能有 ${LIMITS.rawTextCodePoints} 个字符，请拆成两条记录`} />
      ) : null}

      {/* A failure message is never a blocking overlay: the textarea stays usable
          so the user can keep writing (T025-R06). */}
      {capture.error && capture.phase === 'failed' ? (
        <InlineError message={capture.error.message}>
          {capture.error.fieldErrors ? (
            <ul className="list-disc pl-5 text-xs">
              {Object.entries(capture.error.fieldErrors).map(([field, messages]) => (
                <li key={field}>
                  {field}: {messages.join('；')}
                </li>
              ))}
            </ul>
          ) : null}
        </InlineError>
      ) : null}

      <SavePhaseStatus
        phase={capture.phase}
        stored={capture.outcome !== null}
        message={capture.notice}
        {...(capture.phase === 'unknown' || capture.phase === 'failed'
          ? { onRetry: () => void capture.retry() }
          : {})}
        onDismiss={capture.acknowledge}
      />

      {capture.organizeOutcome ? (
        <p
          role="status"
          data-testid="organize-status"
          className={
            capture.organizeOutcome.ok
              ? 'text-xs text-[var(--success)]'
              : 'text-xs text-[var(--warn-ink)]'
          }
        >
          {capture.organizeOutcome.message}
        </p>
      ) : null}

      {/*
        The hint lives with the draft, so it survives navigation. It is a notice,
        not an overlay: the textarea above stays editable (T025-R06) and the user
        can dismiss it without resolving anything.
      */}
      {capture.inputHint ? (
        <div
          role="status"
          data-testid="capture-hint"
          className="flex flex-col items-start gap-2 rounded-md border border-[var(--warn)] bg-[var(--surface-raised)] p-3 text-sm text-[var(--ink)]"
        >
          <p>{capture.inputHint}</p>
          <div className="flex flex-wrap gap-2">
            {!modelConfigured && onConfigureModel ? (
              <Button variant="secondary" onClick={onConfigureModel}>
                去设置模型
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => capture.setInputHint(null)}>
              知道了
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
