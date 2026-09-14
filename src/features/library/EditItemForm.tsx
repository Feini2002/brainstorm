'use client';

/**
 * Edit form (T019).
 *
 * Manual edits carry `expectedRevision`. On a 409 the draft is kept exactly as
 * typed — nothing is reloaded over it — and the user chooses to re-read the
 * current value or reapply. The form never sends `capturedText`, `status` or a
 * revision of its own choosing beyond `expectedRevision`.
 */
import { useState } from 'react';

import { ITEM_TYPES, ITEM_TYPE_LABELS, IMPORTANCE_MAX, IMPORTANCE_MIN } from '@/domain/knowledge';
import type { ItemDTO, ManualField } from '@/domain/knowledge';
import { MANUAL_FIELD_LABELS } from '@/domain/manualFields';
import { LIMITS } from '@/domain/limits';
import { codePointLength } from '@/domain/text';
import {
  Button,
  Field,
  InlineError,
  Select,
  TextArea,
  TextInput,
} from '@/components/ui/primitives';
import { ApiClientError } from '@/features/shared/apiClient';
import { TagInput } from '@/features/shared/TagInput';

export interface EditItemFormProps {
  item: ItemDTO;
  /** Sends the patch; must throw `ApiClientError` on failure. */
  onSubmit: (patch: EditPatch, options: { unlockFields?: ManualField[] }) => Promise<void>;
  onCancel: () => void;
}

export interface EditPatch {
  rawText?: string;
  title?: string;
  summary?: string;
  type?: ItemDTO['type'];
  tags?: string[];
  keywords?: string[];
  importance?: number;
  sourceType?: ItemDTO['sourceType'];
  sourceRef?: string | null;
}

interface Draft {
  rawText: string;
  title: string;
  summary: string;
  type: ItemDTO['type'];
  tags: string[];
  keywords: string[];
  importance: number;
  sourceRef: string;
}

function draftFrom(item: ItemDTO): Draft {
  return {
    rawText: item.rawText,
    title: item.title,
    summary: item.summary,
    type: item.type,
    tags: item.tags,
    keywords: item.keywords,
    importance: item.importance,
    sourceRef: item.sourceRef ?? '',
  };
}

/** Only send fields that actually differ, so revision bumps reflect real edits. */
export function buildPatch(original: ItemDTO, draft: Draft): EditPatch {
  const patch: EditPatch = {};
  if (draft.rawText !== original.rawText) patch.rawText = draft.rawText;
  if (draft.title !== original.title) patch.title = draft.title;
  if (draft.summary !== original.summary) patch.summary = draft.summary;
  if (draft.type !== original.type) patch.type = draft.type;
  if (!sameSet(draft.tags, original.tags)) patch.tags = draft.tags;
  if (!sameSet(draft.keywords, original.keywords)) patch.keywords = draft.keywords;
  if (draft.importance !== original.importance) patch.importance = draft.importance;
  const originalRef = original.sourceRef ?? '';
  if (draft.sourceRef !== originalRef) patch.sourceRef = draft.sourceRef.length > 0 ? draft.sourceRef : null;
  return patch;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((value) => setB.has(value));
}

export function EditItemForm({ item, onSubmit, onCancel }: EditItemFormProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(item));
  const [error, setError] = useState<ApiClientError | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmUnlock, setConfirmUnlock] = useState(false);

  // The parent remounts this form (keyed by item id + revision) when a different
  // record is shown or the record is re-read, so the draft never has to be
  // patched from an effect — which would discard in-progress typing.
  const lockedFields = item.manualFields;
  const patch = buildPatch(item, draft);
  const dirty = Object.keys(patch).length > 0 || confirmUnlock;
  const rawTooLong = codePointLength(draft.rawText) > LIMITS.rawTextCodePoints;

  const onSave = async () => {
    if (!dirty || rawTooLong) return;
    setSaving(true);
    setError(null);
    try {
      const unlockFields = confirmUnlock ? [...lockedFields] : undefined;
      await onSubmit(
        patch,
        unlockFields && unlockFields.length > 0 ? { unlockFields } : {},
      );
    } catch (caught) {
      if (caught instanceof ApiClientError) setError(caught);
      else
        setError(
          new ApiClientError({ code: 'INTERNAL', message: '保存修改失败', retryable: false }),
        );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3"
      data-testid="edit-item-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave();
      }}
    >
      <Field
        label="原文"
        htmlFor="edit-raw"
        hint="修改原文会保留已有整理结果，但会标记为来源已变化。"
        error={
          rawTooLong ? `原文不能超过 ${LIMITS.rawTextCodePoints} 个字符` : undefined
        }
      >
        <TextArea
          id="edit-raw"
          data-testid="edit-raw"
          rows={5}
          value={draft.rawText}
          onChange={(event) => setDraft((current) => ({ ...current, rawText: event.target.value }))}
        />
      </Field>

      <Field
        label="标题"
        htmlFor="edit-title"
        error={fieldError(error, 'title')}
        hint={lockedFields.includes('title') ? '已由人工修改锁定' : undefined}
      >
        <TextInput
          id="edit-title"
          data-testid="edit-title"
          value={draft.title}
          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
        />
      </Field>

      <Field
        label="摘要"
        htmlFor="edit-summary"
        error={fieldError(error, 'summary')}
        hint={lockedFields.includes('summary') ? '已由人工修改锁定' : undefined}
      >
        <TextArea
          id="edit-summary"
          data-testid="edit-summary"
          rows={3}
          value={draft.summary}
          onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))}
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="类型" htmlFor="edit-type">
          <Select
            id="edit-type"
            data-testid="edit-type"
            value={draft.type}
            onChange={(event) =>
              setDraft((current) => ({ ...current, type: event.target.value as ItemDTO['type'] }))
            }
          >
            {ITEM_TYPES.map((value) => (
              <option key={value} value={value}>
                {ITEM_TYPE_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="重要度" htmlFor="edit-importance">
          <Select
            id="edit-importance"
            data-testid="edit-importance"
            value={String(draft.importance)}
            onChange={(event) =>
              setDraft((current) => ({ ...current, importance: Number(event.target.value) }))
            }
          >
            {Array.from({ length: IMPORTANCE_MAX - IMPORTANCE_MIN + 1 }, (_, index) => {
              const value = IMPORTANCE_MIN + index;
              return (
                <option key={value} value={value}>
                  {value}
                </option>
              );
            })}
          </Select>
        </Field>
      </div>

      <Field label="标签" htmlFor="edit-tags">
        <TagInput
          id="edit-tags"
          testId="edit-tags"
          value={draft.tags}
          onChange={(tags) => setDraft((current) => ({ ...current, tags }))}
        />
      </Field>

      <Field label="关键词" htmlFor="edit-keywords">
        <TagInput
          id="edit-keywords"
          testId="edit-keywords"
          value={draft.keywords}
          onChange={(keywords) => setDraft((current) => ({ ...current, keywords }))}
        />
      </Field>

      <Field label="来源引用" htmlFor="edit-source-ref">
        <TextInput
          id="edit-source-ref"
          data-testid="edit-source-ref"
          value={draft.sourceRef}
          onChange={(event) =>
            setDraft((current) => ({ ...current, sourceRef: event.target.value }))
          }
        />
      </Field>

      {lockedFields.length > 0 ? (
        <label className="flex items-start gap-2 text-xs text-[var(--ink-muted)]">
          <input
            type="checkbox"
            data-testid="edit-unlock"
            checked={confirmUnlock}
            onChange={(event) => setConfirmUnlock(event.target.checked)}
          />
          <span>
            解除人工锁定（{lockedFields.map((field) => MANUAL_FIELD_LABELS[field]).join('、')}）
            后，下次整理可以覆盖这些字段。
          </span>
        </label>
      ) : null}

      {error ? (
        <InlineError message={error.message}>
          {error.code === 'REVISION_CONFLICT' ? (
            <p className="text-xs">
              这条记录在别处被改过。你的修改还留在表单里，可以先对照当前版本再决定。
            </p>
          ) : null}
          {error.fieldErrors ? (
            <ul className="list-disc pl-5 text-xs">
              {Object.entries(error.fieldErrors).map(([field, messages]) => (
                <li key={field}>
                  {field}: {messages.join('；')}
                </li>
              ))}
            </ul>
          ) : null}
        </InlineError>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          data-testid="edit-save"
          disabled={!dirty || saving || rawTooLong}
        >
          {saving ? '保存中…' : '保存修改'}
        </Button>
        <Button variant="ghost" data-testid="edit-cancel" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

function fieldError(error: ApiClientError | null, field: string): string | undefined {
  const messages = error?.fieldErrors?.[field];
  return messages && messages.length > 0 ? messages.join('；') : undefined;
}
