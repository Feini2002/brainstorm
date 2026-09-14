'use client';

/**
 * Relation editor (T022).
 *
 * A relation is a statement, so the editor confirms it as a sentence — "A 依赖
 * B" — rather than showing a bare English type. Direction matters and the two
 * selectors make it explicit which endpoint is which; symmetric types say so and
 * do not pretend an arrow exists.
 *
 * Versions are captured with the endpoints, so a note edited in another window
 * between opening the form and submitting produces an honest conflict instead of
 * a relation built on text the user never saw (T022-R06).
 */
import { useCallback, useMemo, useState } from 'react';

import type { ItemDTO, RelationDTO, RelationType } from '@/domain/knowledge';
import { RELATION_TYPES } from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import { RELATION_TYPE_META, relationTypeMeta } from '@/domain/relations';
import { describeRelation } from '@/domain/relation';
import { codePointLength } from '@/domain/text';
import { ApiClientError, apiRequestFull } from '@/features/shared/apiClient';
import {
  Button,
  Field,
  InlineError,
  Select,
  TextArea,
} from '@/components/ui/primitives';

export interface RelationEditorProps {
  source: Pick<ItemDTO, 'id' | 'title' | 'capturedText' | 'revision'>;
  /** Candidate endpoints; the form never lets the same item be both ends. */
  candidates: Pick<ItemDTO, 'id' | 'title' | 'capturedText' | 'revision'>[];
  /** Called with the created or upgraded relation. */
  onCreated: (relation: RelationDTO, created: boolean) => void;
  onCancel?: () => void;
}

function shortLabel(item: { title: string; capturedText: string }): string {
  const title = item.title.trim();
  if (title.length > 0) return title;
  const firstLine = item.capturedText.split('\n')[0]?.trim() ?? '';
  const points = [...firstLine];
  return points.length > 18 ? `${points.slice(0, 18).join('')}…` : firstLine;
}

export function RelationEditor({ source, candidates, onCreated, onCancel }: RelationEditorProps) {
  const options = useMemo(
    () => candidates.filter((candidate) => candidate.id !== source.id),
    [candidates, source.id],
  );
  const [targetId, setTargetId] = useState('');
  const [type, setType] = useState<RelationType>('related_to');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // A candidate disappearing (deleted in another window) is handled by deriving
  // the selection rather than storing a second copy: if the id is no longer in
  // the list there is simply no target, and submit stays disabled.
  const target = options.find((option) => option.id === targetId) ?? null;
  const meta = relationTypeMeta(type);
  const reasonPoints = codePointLength(reason);
  const reasonOverLimit = reasonPoints > LIMITS.relationReasonCodePoints;

  const preview = useMemo(() => {
    if (!target) return null;
    return describeRelation(type, shortLabel(source), shortLabel(target));
  }, [source, target, type]);

  const submit = useCallback(async () => {
    if (!target) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { data: relation, status } = await apiRequestFull<RelationDTO>('/api/relations', {
        method: 'POST',
        body: {
          sourceId: source.id,
          targetId: target.id,
          type,
          reason: reason.trim(),
          sourceExpectedRevision: source.revision,
          targetExpectedRevision: target.revision,
        },
      });
      // 201 = a new edge; 200 = an existing AI suggestion was upgraded in place.
      onCreated(relation, status === 201);
      setNotice(status === 201 ? '关系已保存' : '已把原来的 AI 建议升级为人工确认');
      setReason('');
    } catch (caught) {
      setError(
        caught instanceof ApiClientError
          ? caught
          : new ApiClientError({ code: 'INTERNAL', message: '保存关系失败', retryable: false }),
      );
    } finally {
      setSaving(false);
    }
  }, [onCreated, reason, source, target, type]);

  return (
    <section
      className="flex flex-col gap-3 rounded-md border border-[var(--line)] bg-[var(--surface-raised)] p-3"
      aria-label="建立关系"
      data-testid="relation-editor"
    >
      <h3 className="text-sm font-semibold text-[var(--ink)]">手动建立关系</h3>

      {options.length === 0 ? (
        <p className="text-sm text-[var(--ink-muted)]">
          还没有可以连接的另一条记录。先记录更多内容，再回来建立关系。
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="起点" htmlFor="relation-source">
              <p
                id="relation-source"
                className="truncate rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--ink)]"
              >
                {shortLabel(source)}
              </p>
            </Field>
            <Field label="终点" htmlFor="relation-target">
              <Select
                id="relation-target"
                data-testid="relation-target"
                value={target ? targetId : ''}
                onChange={(event) => setTargetId(event.target.value)}
              >
                <option value="">请选择</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {shortLabel(option)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="关系类型" htmlFor="relation-type" hint={meta.directionHint}>
            <Select
              id="relation-type"
              data-testid="relation-type"
              value={type}
              onChange={(event) => setType(event.target.value as RelationType)}
            >
              {RELATION_TYPES.map((value) => {
                const entry = RELATION_TYPE_META.find((item) => item.type === value);
                return (
                  <option key={value} value={value}>
                    {entry?.label ?? value}
                    {entry?.symmetric ? '（对称）' : ''}
                  </option>
                );
              })}
            </Select>
          </Field>

          <Field
            label="理由（可选）"
            htmlFor="relation-reason"
            hint={`最多 ${LIMITS.relationReasonCodePoints} 个字符，当前 ${reasonPoints}`}
          >
            <TextArea
              id="relation-reason"
              data-testid="relation-reason"
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="例如：这条笔记为那条提供了依据"
            />
          </Field>

          {preview ? (
            <p className="text-sm text-[var(--ink)]" data-testid="relation-preview">
              将保存为：{preview}
            </p>
          ) : null}

          {reasonOverLimit ? (
            <InlineError
              message={`理由不能超过 ${LIMITS.relationReasonCodePoints} 个字符`}
            />
          ) : null}

          {error ? (
            <InlineError message={error.message}>
              {error.code === 'REVISION_CONFLICT' ? (
                <p className="text-xs">其中一条记录已经被修改，请关闭后重新打开。</p>
              ) : null}
            </InlineError>
          ) : null}

          {notice ? (
            <p role="status" className="text-xs text-[var(--success)]">
              {notice}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              data-testid="relation-submit"
              disabled={!target || saving || reasonOverLimit}
              onClick={() => void submit()}
            >
              {saving ? '保存中…' : '建立关系'}
            </Button>
            {onCancel ? (
              <Button variant="ghost" onClick={onCancel}>
                取消
              </Button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
