'use client';

/**
 * Source reference (T018-R04).
 *
 * Shows where a record came from and, for a stale AI result, which raw version
 * the organization was based on versus the current one. The source reference is
 * plain text and never rendered as HTML: a "URL" from the user is data, not
 * something the app should fetch or execute.
 */
import { SOURCE_TYPE_LABELS, type ItemDTO } from '@/domain/knowledge';

export interface SourceReferenceProps {
  item: ItemDTO;
}

export function SourceReference({ item }: SourceReferenceProps) {
  const stale = item.isStructuredStale;
  const hasRef = item.sourceRef !== null && item.sourceRef.trim().length > 0;
  const base = item.structuredBaseRawVersion;

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-[var(--ink-muted)]">
      <dt>来源类型</dt>
      <dd className="text-[var(--ink)]" data-testid="source-type">
        {SOURCE_TYPE_LABELS[item.sourceType]}
      </dd>

      <dt>来源引用</dt>
      <dd className="break-all text-[var(--ink)]" data-testid="source-ref">
        {hasRef ? item.sourceRef : '未填写'}
      </dd>

      <dt>原文版本</dt>
      <dd className="text-[var(--ink)]">v{item.rawVersion}</dd>

      <dt>整理基线</dt>
      <dd className={stale ? 'text-[var(--warn)]' : 'text-[var(--ink)]'}>
        {base === null
          ? '尚未整理'
          : `基于 v${base}${stale ? `（当前已是 v${item.rawVersion}）` : ''}`}
      </dd>
    </dl>
  );
}
