'use client';

/**
 * Knowledge card (T015-R01/R02).
 *
 * The card shows what is known without pretending more exists: the captured
 * text is always shown verbatim, and organized fields (title, summary, type,
 * tags) appear as clearly secondary. A record that has never been organized
 * shows an honest "仅保存" state rather than an invented summary.
 */
import {
  ITEM_STATUS_LABELS,
  ITEM_TYPE_LABELS,
  SOURCE_TYPE_LABELS,
  type ItemDTO,
} from '@/domain/knowledge';
import { isStructuredStale } from '@/domain/knowledge';
import { formatTime } from './formatTime';

export interface KnowledgeCardProps {
  item: ItemDTO;
  onOpen?: (id: string) => void;
  /** Selectable cards expose a checkbox for cross-view material selection. */
  selection?: {
    selected: boolean;
    onToggle: (id: string, selected: boolean) => void;
    /** Disabled when the selection budget is full and this item is not in it. */
    disabled?: boolean;
  };
  /** Extra controls (delete, relation) rendered in the card footer. */
  actions?: React.ReactNode;
}

const STATUS_TONE: Record<ItemDTO['status'], string> = {
  raw: 'text-[var(--ink-muted)]',
  processing: 'text-[var(--warn)]',
  done: 'text-[var(--success)]',
  error: 'text-[var(--danger)]',
  stale: 'text-[var(--warn)]',
};

export function KnowledgeCard({ item, onOpen, selection, actions }: KnowledgeCardProps) {
  const time = formatTime(item.createdAt);
  // A stale record still shows its content, but the badge says the source moved:
  // the displayed organization is based on an older raw version.
  const stale = isStructuredStale(item.structuredBaseRawVersion, item.rawVersion);

  return (
    <article
      data-testid="knowledge-card"
      data-item-id={item.id}
      className="flex flex-col gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3"
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {selection ? (
            <input
              type="checkbox"
              data-testid="card-select"
              aria-label={`选择：${item.title || item.capturedText.slice(0, 20)}`}
              checked={selection.selected}
              disabled={selection.disabled && !selection.selected}
              onChange={(event) => selection.onToggle(item.id, event.target.checked)}
            />
          ) : null}
          <button
            type="button"
            className="min-w-0 truncate text-left text-sm font-medium text-[var(--ink)] hover:underline"
            onClick={() => onOpen?.(item.id)}
          >
            {item.title.trim().length > 0 ? item.title : '未命名'}
          </button>
        </div>
        <time
          dateTime={time.iso}
          title={time.absolute}
          className="shrink-0 text-xs text-[var(--ink-muted)]"
        >
          {time.label}
        </time>
      </header>

      {/* Captured text is verbatim and never truncated in the data model. */}
      <p className="line-clamp-4 whitespace-pre-wrap text-sm text-[var(--ink)]">
        {item.capturedText}
      </p>

      {item.summary.trim().length > 0 ? (
        <p className="text-xs text-[var(--ink-muted)]">摘要：{item.summary}</p>
      ) : null}

      <footer className="flex flex-wrap items-center gap-2 text-xs text-[var(--ink-muted)]">
        <span className={STATUS_TONE[item.status]}>{ITEM_STATUS_LABELS[item.status]}</span>
        <span aria-hidden="true">·</span>
        <span>{ITEM_TYPE_LABELS[item.type]}</span>
        <span aria-hidden="true">·</span>
        <span>{SOURCE_TYPE_LABELS[item.sourceType]}</span>
        {stale ? <span className="text-[var(--warn)]">来源版本已变化，需要重新整理</span> : null}
        {item.tags.map((tag) => (
          <span
            key={tag}
            className="rounded-full border border-[var(--line)] px-2 py-0.5 text-[var(--ink-muted)]"
          >
            {tag}
          </span>
        ))}
        {actions ? <span className="ml-auto flex items-center gap-1">{actions}</span> : null}
      </footer>
    </article>
  );
}
