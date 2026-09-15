'use client';

/**
 * Graph filters (T048).
 *
 * A filter narrows what is *read*. Nothing here writes: raising the score
 * threshold cannot delete a relation, and unticking a tag cannot untag an item
 * (T048-R01). The wording follows T048-R02 — the score is labelled 「关联评分」
 * with an explicit note that it is not a correctness rate, so nobody reads 0.8 as
 * "80% right".
 */
import type { GraphFilter, ItemType, ReviewStatus, TagDTO } from '@/domain/knowledge';
import { ITEM_TYPE_LABELS, ITEM_TYPES, REVIEW_STATUSES } from '@/domain/knowledge';
import { Button, Field, Select } from '@/components/ui/primitives';
import { RELATION_TYPE_META } from '@/domain/relations';

export interface GraphFiltersProps {
  filter: GraphFilter;
  onChange: (next: GraphFilter) => void;
  tags: TagDTO[];
  /** Number of edges hidden because their evidence moved (T051). */
  hiddenStaleCount: number;
  disabled?: boolean;
}

/** Thresholds offered as a choice rather than a free slider of arbitrary values. */
const SCORE_STEPS = [0, 0.5, 0.7, 0.8, 0.9] as const;

export function GraphFilters({
  filter,
  onChange,
  tags,
  hiddenStaleCount,
  disabled = false,
}: GraphFiltersProps) {
  const statuses = filter.reviewStatuses ?? ['accepted', 'suggested'];

  function patch(next: Partial<GraphFilter>) {
    // A field set to `undefined` is removed rather than sent as null, so the
    // request body matches the contract's optional fields exactly.
    const merged: GraphFilter = { ...filter, ...next };
    const cleaned: GraphFilter = {};
    if (merged.tagId) cleaned.tagId = merged.tagId;
    if (merged.type) cleaned.type = merged.type;
    if (merged.reviewStatuses) cleaned.reviewStatuses = merged.reviewStatuses;
    if (merged.minimumScore !== undefined) cleaned.minimumScore = merged.minimumScore;
    if (merged.includeStale === true) cleaned.includeStale = true;
    onChange(cleaned);
  }

  function toggleStatus(status: ReviewStatus) {
    const next = statuses.includes(status)
      ? statuses.filter((entry) => entry !== status)
      : [...statuses, status];
    // Never send an empty status list: that would read as "no status matches"
    // and hide the whole graph instead of showing more.
    patch({ reviewStatuses: next.length > 0 ? next : [status] });
  }

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3"
      aria-label="关系图筛选"
      data-testid="graph-filters"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="标签" htmlFor="graph-filter-tag">
          <Select
            id="graph-filter-tag"
            data-testid="graph-filter-tag"
            disabled={disabled}
            value={filter.tagId ?? ''}
            onChange={(event) => patch({ tagId: event.target.value || undefined })}
          >
            <option value="">全部标签</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.label}（{tag.itemCount}）
              </option>
            ))}
          </Select>
        </Field>

        <Field label="类型" htmlFor="graph-filter-type">
          <Select
            id="graph-filter-type"
            data-testid="graph-filter-type"
            disabled={disabled}
            value={filter.type ?? ''}
            onChange={(event) =>
              patch({ type: (event.target.value || undefined) as ItemType | undefined })
            }
          >
            <option value="">全部类型</option>
            {ITEM_TYPES.map((type) => (
              <option key={type} value={type}>
                {ITEM_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="最低关联评分"
          htmlFor="graph-filter-score"
          hint="模型判断的关联强度，不是正确率；人工关系没有评分，不受此项影响"
        >
          <Select
            id="graph-filter-score"
            data-testid="graph-filter-score"
            disabled={disabled}
            value={String(filter.minimumScore ?? 0)}
            onChange={(event) => patch({ minimumScore: Number(event.target.value) })}
          >
            {SCORE_STEPS.map((step) => (
              <option key={step} value={step}>
                {step === 0 ? '不限制（含全部 AI 评分）' : `≥ ${step.toFixed(2)}`}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <fieldset className="flex flex-wrap items-center gap-3" disabled={disabled}>
        <legend className="text-xs font-medium text-[var(--ink-muted)]">审核状态</legend>
        {REVIEW_STATUSES.filter((status) => status !== 'rejected').map((status) => (
          <label key={status} className="flex items-center gap-1.5 text-sm text-[var(--ink)]">
            <input
              type="checkbox"
              data-testid={`graph-status-${status}`}
              checked={statuses.includes(status)}
              onChange={() => toggleStatus(status)}
            />
            {status === 'suggested' ? '待确认' : '已确认'}
          </label>
        ))}
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={filter.includeStale === true ? 'primary' : 'secondary'}
          data-testid="graph-toggle-stale"
          disabled={disabled}
          onClick={() => patch({ includeStale: filter.includeStale === true ? undefined : true })}
        >
          {filter.includeStale === true ? '隐藏过期关系' : '显示过期关系'}
        </Button>
        {filter.includeStale !== true && hiddenStaleCount > 0 ? (
          <span className="text-xs text-[var(--warn-ink)]" data-testid="graph-stale-hidden">
            有 {hiddenStaleCount} 条关系的原文已变化，依据已过期，默认隐藏
          </span>
        ) : null}
      </div>

      <p className="text-xs text-[var(--ink-muted)]">
        虚线表示待确认建议，点线表示依据过期；颜色之外的线型同样表达状态。
      </p>

      {/*
        A real legend (T050-R06). Listing the types with their direction meaning is
        what tells `causes` apart from `related_to`; a single "关联" label for every
        relation would make the graph's most important distinction unreadable.
      */}
      <details className="text-xs" data-testid="graph-legend">
        <summary className="cursor-pointer text-[var(--ink-muted)]">
          图例：{RELATION_TYPE_META.length} 种关系类型与状态
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <ul className="grid gap-1 sm:grid-cols-2">
            {RELATION_TYPE_META.map((entry) => (
              <li
                key={entry.type}
                className="text-[var(--ink)]"
                data-testid="graph-legend-type"
                data-relation-type={entry.type}
              >
                <span className="font-medium">{entry.label}</span>
                <span className="text-[var(--ink-muted)]">
                  ：{entry.symmetric ? '两端含义相同' : entry.directionHint}
                </span>
              </li>
            ))}
          </ul>
          <ul className="flex flex-col gap-1 text-[var(--ink)]">
            <li>实线：已确认的关系</li>
            <li>虚线：待确认的模型建议</li>
            <li>点线：依据已过期（原文版本已变化）</li>
            <li>线上文字：待确认 / 依据过期 / 端点已删除</li>
          </ul>
        </div>
      </details>
    </section>
  );
}
