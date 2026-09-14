/**
 * /api/relations — list and manual creation (T022).
 *
 * Both directions of trust meet here: a manual create is a user declaration and
 * is validated against the live rows (endpoints exist, differ, versions match),
 * while a list is a read that a detail panel may widen to include stale and
 * rejected rows so the review history stays visible.
 */
import type { RelationDTO } from '@/domain/knowledge';
import { manualRelationRequestSchema, relationQuerySchema } from '@/domain/schemas/http';
import { getDb } from '@/server/db/database';
import { createRouteHandler, parseQuery } from '@/server/http/routeHandler';
import { createManualRelation, queryRelations } from '@/server/services/relations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/relations — rejects are hidden unless explicitly requested. */
export const GET = createRouteHandler({ route: 'relations.list' }, ({ request }): RelationDTO[] => {
  const query = parseQuery(request, relationQuerySchema);
  return queryRelations(getDb(), {
    ...(query.itemId ? { itemId: query.itemId } : {}),
    ...(query.reviewStatus ? { reviewStatus: query.reviewStatus } : {}),
    ...(query.includeStale !== undefined ? { includeStale: query.includeStale } : {}),
    ...(query.includeRejected !== undefined ? { includeRejected: query.includeRejected } : {}),
  });
});

/**
 * POST /api/relations — the user states a relation directly.
 *
 * 201 for a new row, 200 when an existing AI suggestion for the same canonical
 * pair is upgraded in place: the row identity is what keeps "one edge, two
 * histories" impossible.
 */
export const POST = createRouteHandler(
  { route: 'relations.create', mutation: true, schema: manualRelationRequestSchema },
  ({ body, status }) => {
    const result = createManualRelation(getDb(), body);
    return status(result.created ? 201 : 200, result.relation);
  },
);
