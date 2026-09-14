/**
 * Library query contract (T016).
 *
 * This is plain literal matching, not semantic understanding: the search covers
 * raw text, title, summary and tag names, and it never calls a model (T016-R06).
 * Chinese text has no word boundaries, so a query is matched as a normalized
 * substring rather than tokenized.
 *
 * Pure functions only — no database, no environment.
 */
import { ITEM_STATUSES, ITEM_TYPES, type ItemStatus, type ItemType } from './knowledge';
import { LIMITS } from './limits';

export const ITEM_SORTS = ['newest', 'oldest', 'importance'] as const;
export type ItemSort = (typeof ITEM_SORTS)[number];
export const DEFAULT_ITEM_SORT: ItemSort = 'newest';

export interface LibraryQuery {
  q: string;
  type: ItemType | null;
  status: ItemStatus | null;
  tagId: string | null;
  sort: ItemSort;
}

export const EMPTY_LIBRARY_QUERY: LibraryQuery = {
  q: '',
  type: null,
  status: null,
  tagId: null,
  sort: DEFAULT_ITEM_SORT,
};

/**
 * Normalize raw query values from the URL.
 *
 * Invalid enum values become `null` (i.e. "no filter") rather than throwing: a
 * hand-edited or stale URL should show more results, not an error page.
 */
export function normalizeLibraryQuery(
  raw: Partial<Record<string, string | null | undefined>>,
): LibraryQuery {
  const q = (raw.q ?? '').trim().slice(0, LIMITS.queryCodePoints);
  const type = ITEM_TYPES.includes(raw.type as ItemType) ? (raw.type as ItemType) : null;
  const status = ITEM_STATUSES.includes(raw.status as ItemStatus)
    ? (raw.status as ItemStatus)
    : null;
  const tagId = raw.tagId && raw.tagId.trim().length > 0 ? raw.tagId.trim() : null;
  const sort = ITEM_SORTS.includes(raw.sort as ItemSort) ? (raw.sort as ItemSort) : DEFAULT_ITEM_SORT;
  return { q, type, status, tagId, sort };
}

/** Serialize the query back into URL parameters, omitting empty filters. */
export function libraryQueryToParams(query: LibraryQuery): Record<string, string> {
  const params: Record<string, string> = {};
  if (query.q.trim().length > 0) params.q = query.q.trim();
  if (query.type) params.type = query.type;
  if (query.status) params.status = query.status;
  if (query.tagId) params.tagId = query.tagId;
  if (query.sort !== DEFAULT_ITEM_SORT) params.sort = query.sort;
  return params;
}

/**
 * Identity of a query for staleness checks (T016-R05).
 *
 * The page compares this string to decide whether a late response still belongs
 * to the conditions the user is currently looking at.
 */
export function libraryQueryIdentity(query: LibraryQuery): string {
  return [query.q.trim(), query.type ?? '-', query.status ?? '-', query.tagId ?? '-', query.sort].join(
    '\u0000',
  );
}

/** How many filters beyond the free-text query are active, for the UI summary. */
export function activeFilterCount(query: LibraryQuery): number {
  let count = 0;
  if (query.type) count += 1;
  if (query.status) count += 1;
  if (query.tagId) count += 1;
  return count;
}

/**
 * Page size handling (T016-R04).
 *
 * Oversized values are clamped rather than rejected so a shared link with a
 * large `limit` still renders; the default applies when absent or unparsable.
 */
export function resolvePageSize(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return LIMITS.listPageSizeDefault;
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return LIMITS.listPageSizeDefault;
  return Math.min(Math.floor(parsed), LIMITS.listPageSizeMax);
}
