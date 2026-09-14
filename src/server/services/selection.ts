/**
 * Selection resolution service (T021).
 *
 * The client sends ids, never a query. Two consequences must hold server-side:
 *
 *  - a tag or filter is resolved to an explicit id list **at this moment**, so
 *    adding a note later cannot silently widen what was sent (T021-R05);
 *  - every id is re-read and its version compared, so a note deleted after the
 *    tick is reported instead of quietly dropped (T021-R04).
 *
 * Only ids, versions and titles cross back to the client: the preview must not
 * become a second copy of the source text.
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import { validationError } from '@/domain/errors';
import { LIMITS } from '@/domain/limits';
import type { UUID } from '@/domain/knowledge';
import { getItemOrNull, listItems } from '@/server/repositories/items';

export interface SelectionSourcePreview {
  id: UUID;
  title: string;
  revision: number;
  rawVersion: number;
  /** First line of the captured text, short enough for a chip. */
  excerpt: string;
}

export interface SelectionResolution {
  itemIds: UUID[];
  /** One entry per resolved id, in the requested order. */
  sources: SelectionSourcePreview[];
  count: number;
  limit: number;
  /** How many of the resolved sources the current filter would hide. */
  hiddenByFilter: number | null;
}

export interface ResolveSelectionInput {
  itemIds?: readonly UUID[];
  /** A saved filter is re-run once, here, to freeze the id list. */
  fromTagId?: UUID;
  /** Optional current filter, used only to report how many are hidden. */
  filterTagId?: UUID;
  /** Reject rather than shorten when the request exceeds the budget. */
  enforceBudget?: boolean;
}

function excerptOf(capturedText: string): string {
  const firstLine = capturedText.split('\n')[0]?.trim() ?? '';
  const limit = 40;
  const points = [...firstLine];
  if (points.length <= limit) return firstLine;
  return `${points.slice(0, limit).join('')}…`;
}

/**
 * Turn a selection request into the exact id list that a projection may send.
 *
 * Returns versions alongside the ids so a later generation call can compare and
 * detect that the material changed between preview and send.
 */
export function resolveSelection(
  db: DatabaseSync,
  input: ResolveSelectionInput,
): SelectionResolution {
  const limit = LIMITS.selectedItemsPerProjection;

  // A tag-selected batch is snapshotted once; the ids are then the authority.
  let ids: UUID[] = input.itemIds ? [...input.itemIds] : [];
  if (input.fromTagId) {
    const matched = listItems(db, {
      filters: { tagId: input.fromTagId },
      sort: 'newest',
      limit: limit + 1,
      cursor: null,
    });
    if (matched.items.length > limit) {
      throw validationError(`一次最多发送 ${limit} 条，请先缩小标签范围`);
    }
    for (const item of matched.items) {
      if (!ids.includes(item.id)) ids.push(item.id);
    }
  }

  ids = ids.filter((id, index) => ids.indexOf(id) === index);

  if (ids.length === 0) {
    throw validationError('请先选择要使用的记录', { itemIds: ['至少要选一条'] });
  }
  if (input.enforceBudget !== false && ids.length > limit) {
    // Never truncate: the user must know that part of the material is missing.
    throw validationError(`一次最多发送 ${limit} 条，当前选中 ${ids.length} 条`, {
      itemIds: [`最多 ${limit} 条，请减少选择`],
    });
  }

  const missing: string[] = [];
  const sources: SelectionSourcePreview[] = [];
  for (const id of ids) {
    const item = getItemOrNull(db, id);
    if (!item) {
      missing.push(id);
      continue;
    }
    sources.push({
      id: item.id,
      title: item.title.trim().length > 0 ? item.title : excerptOf(item.capturedText),
      revision: item.revision,
      rawVersion: item.rawVersion,
      excerpt: excerptOf(item.capturedText),
    });
  }

  if (missing.length > 0) {
    // Deleted selections are a hard error: silently skipping them would send an
    // incomplete basis into a generated view (T021-C04).
    throw validationError('部分选中的记录已经不存在，请重新选择', {
      itemIds: [`已不存在：${missing.join('、')}`],
    });
  }

  let hiddenByFilter: number | null = null;
  if (input.filterTagId) {
    const visible = new Set(
      listItems(db, {
        filters: { tagId: input.filterTagId },
        sort: 'newest',
        limit: limit + 1,
        cursor: null,
      }).items.map((entry) => entry.id),
    );
    hiddenByFilter = sources.filter((source) => !visible.has(source.id)).length;
  }

  return {
    itemIds: sources.map((source) => source.id),
    sources,
    count: sources.length,
    limit,
    hiddenByFilter,
  };
}
