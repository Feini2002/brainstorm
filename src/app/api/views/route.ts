/**
 * /api/views — list summaries and create a saved graph view (T053).
 *
 * GET returns **summaries only** (T053-R02): the views list must not download
 * every saved projection. POST only creates the `graph` kind, because a mindmap
 * or flow arrives through its own generation route, where the model output has
 * been validated — accepting one here would be a way to store unvalidated content.
 */
import type { ViewDTO } from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import { createGraphViewSchema, viewListQuerySchema } from '@/domain/schemas/http';
import { getDb } from '@/server/db/database';
import { createRouteHandler, parseQuery } from '@/server/http/routeHandler';
import { createGraphView, listViews } from '@/server/services/views/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = createRouteHandler({ route: 'views.list' }, ({ request }) => {
  const query = parseQuery(request, viewListQuerySchema);
  const limit = query.limit ?? LIMITS.listPageSizeDefault;
  const result = listViews(getDb(), {
    ...(query.kind !== undefined ? { kind: query.kind } : {}),
    limit,
    offset: 0,
  });
  // Summaries only: the list response must not carry a single projection body.
  return { views: result.views, nextCursor: null };
});

export const POST = createRouteHandler(
  { route: 'views.create', mutation: true, schema: createGraphViewSchema },
  ({ body, status }): ReturnType<typeof status> => {
    const view: ViewDTO = createGraphView(getDb(), {
      name: body.name,
      selection: body.selection as never,
      positions: body.positions,
      direction: body.direction,
    });
    return status(201, view);
  },
);
