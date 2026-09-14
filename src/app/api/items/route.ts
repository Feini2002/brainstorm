/**
 * /api/items — capture and list (T014, T015, T016).
 *
 * Capture order is the product invariant: the raw text is persisted and gets an
 * ID before any AI step can run, so a provider timeout never loses material.
 */
import type { ItemPageResult } from '@/domain/api';
import { captureRequestSchema } from '@/domain/schemas/http';
import { getDb } from '@/server/db/database';
import { createRouteHandler } from '@/server/http/routeHandler';
import { createCapture } from '@/server/services/items';
import { queryItems } from '@/server/services/queryItems';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/items — capture one fragment (idempotent per captureRequestId).
 *
 * 201 marks the call that actually inserted; replaying the same key keeps 200,
 * so a client can tell "created" from "already created" without a second lookup.
 */
export const POST = createRouteHandler(
  { route: 'items.create', mutation: true, schema: captureRequestSchema },
  ({ body, status }) => {
    const result = createCapture(getDb(), body);
    return status(result.replayed ? 200 : 201, result);
  },
);

/** GET /api/items — inbox timeline / library list; a read never mutates. */
export const GET = createRouteHandler({ route: 'items.list' }, ({ request }): ItemPageResult => {
  const url = new URL(request.url);
  const readParam = (key: string): string | undefined => url.searchParams.get(key) ?? undefined;
  return queryItems(getDb(), {
    q: readParam('q'),
    type: readParam('type'),
    status: readParam('status'),
    tagId: readParam('tagId'),
    sort: readParam('sort'),
    limit: readParam('limit'),
    cursor: readParam('cursor'),
  });
});
