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
import { useCallback, useEffect, useRef, useState } from 'react';

import { SOURCE_TYPE_LABELS } from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import { Button, Field, InlineError, Select, TextArea } from '@/components/ui/primitives';
import { SavePhaseStatus } from '@/features/shared/MutationStatus';
import { useCapture, type CaptureResult } from './useCapture';

const SOURCE_TYPE_ORDER = ['other', 'chatgpt', 'claude', 'web', 'book', 'myself'] as const;

export interface CaptureBoxProps {
  onCreated?: (result: CaptureResult) => void;
  /** Opens the settings page; used when "save & organize" has no model yet. */
  onConfigureModel?: () => void;
  /** Whether an API key is configured; the parent knows, the box does not ask. */
  modelConfigured?: boolean;
}

export function CaptureBox({ onCreated, onConfigureModel, modelConfigured = false }: CaptureBoxProps) {
  const capture = useCapture({
    ...(onCreated ? { onCreated } : {}),
  });
  const [configureHint, setConfigureHint] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const saving = capture.phase === 'saving';

  const onSubmitShortcut = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // `isComposing` guards the IME: Enter during composition selects a
      // candidate and must not submit (T013-R03).
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void capture.submit();
      }
    },
    [capture],
  );

  // Keep focus in the textarea so capturing stays low friction.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const onSaveAndOrganize = useCallback(() => {
    if (!modelConfigured) {
      // Never lose the text: save first, then explain that organizing needs a model.
      setConfigureHint(true);
      void capture.submit();
      return;
    }
    setConfigureHint(false);
    void capture.submit();
  }, [capture, modelConfigured]);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
      <label htmlFor="capture-text" className="text-sm font-semibold text-[var(--ink)]">
        记录一条
      </label>
      <TextArea
        id="capture-text"
        ref={textareaRef}
        data-testid="capture-input"
        rows={4}
        value={capture.draft}
        disabled={saving}
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
            onClick={() => {
              setConfigureHint(false);
              void capture.submit();
            }}
          >
            {saving ? '保存中…' : '只保存'}
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

      {configureHint ? (
        <div className="rounded-md border border-[var(--warn)] bg-[var(--surface-raised)] p-3 text-sm text-[var(--ink)]">
          <p>
            {capture.phase === 'saved'
              ? '原文已经保存。整理功能需要先在设置里配置模型。'
              : '整理功能需要先在设置里配置模型；原文仍会照常保存。'}
          </p>
          {onConfigureModel ? (
            <Button variant="secondary" className="mt-2" onClick={onConfigureModel}>
              去设置模型
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
