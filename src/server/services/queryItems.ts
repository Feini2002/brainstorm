/**
 * Library query service (T016).
 *
 * Sits between the HTTP route and the item repository: it validates the shape of
 * a query, applies the page-size budget, and returns a stable page. It shares
 * the normalization rules with the UI (`src/domain/query.ts`) but keeps a
 * different product goal from candidate retrieval: this is browsing, not
 * building model context.
 */
import 'server-only';

import type { ItemPageResult } from '@/domain/api';
import {
  DEFAULT_ITEM_SORT,
  ITEM_SORTS,
  type ItemSort,
  type LibraryQuery,
} from '@/domain/query';
import { ITEM_STATUSES, ITEM_TYPES, type ItemStatus, type ItemType } from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import { validationError } from '@/domain/errors';
import { listItemsService } from '@/server/services/items';
import type { DatabaseSync } from 'node:sqlite';

export interface QueryItemsInput {
  q?: string | undefined;
  type?: string | undefined;
  status?: string | undefined;
  tagId?: string | undefined;
  sort?: string | undefined;
  limit?: string | number | undefined;
  cursor?: string | undefined;
}

/**
 * Validate a query coming from the wire.
 *
 * Enum values and the page size are checked here rather than silently coerced,
 * because the library page passes user-chosen filters — a bad value there is a
 * client bug worth reporting (T016-R04). (The UI separately clamps values it
 * reads out of a hand-edited URL so a stale link still renders.)
 */
export function validateQueryItemsInput(input: QueryItemsInput): {
  query: LibraryQuery;
  limit: number;
  cursor: string | undefined;
} {
  const fieldErrors: Record<string, string[]> = {};

  if (input.type !== undefined && !ITEM_TYPES.includes(input.type as ItemType)) {
    fieldErrors.type = ['类型筛选不合法'];
  }
  if (input.status !== undefined && !ITEM_STATUSES.includes(input.status as ItemStatus)) {
    fieldErrors.status = ['状态筛选不合法'];
  }
  if (input.sort !== undefined && !ITEM_SORTS.includes(input.sort as ItemSort)) {
    fieldErrors.sort = ['排序方式不合法'];
  }

  let limit: number = LIMITS.listPageSizeDefault;
  if (input.limit !== undefined && input.limit !== null && `${input.limit}`.length > 0) {
    const parsed = typeof input.limit === 'number' ? input.limit : Number.parseInt(input.limit, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > LIMITS.listPageSizeMax) {
      fieldErrors.limit = [`每页数量必须在 1 到 ${LIMITS.listPageSizeMax} 之间`];
    } else {
      limit = parsed;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw validationError('查询条件不合法', fieldErrors);
  }

  const query: LibraryQuery = {
    q: (input.q ?? '').trim(),
    type: (input.type as ItemType | undefined) ?? null,
    status: (input.status as ItemStatus | undefined) ?? null,
    tagId: input.tagId && input.tagId.trim().length > 0 ? input.tagId.trim() : null,
    sort: (input.sort as ItemSort | undefined) ?? DEFAULT_ITEM_SORT,
  };

  return {
    query,
    limit,
    cursor: input.cursor,
  };
}

/** Run the query and return one stable page of items. */
export function queryItems(db: DatabaseSync, input: QueryItemsInput): ItemPageResult {
  const { query, limit, cursor } = validateQueryItemsInput(input);
  return listItemsService(db, {
    filters: {
      q: query.q.length > 0 ? query.q : undefined,
      type: query.type ?? undefined,
      status: query.status ?? undefined,
      tagId: query.tagId ?? undefined,
    },
    sort: query.sort,
    limit,
    ...(cursor !== undefined ? { cursor } : {}),
  });
}
