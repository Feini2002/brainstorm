/**
 * /api/graph — bounded subgraph read (T043).
 *
 * POST rather than GET by contract: a tag or type filter plus an explicit
 * selection of up to 200 item UUIDs would not survive a URL (docs/03_contracts/
 * 04_api_contract.md §Graph). It is still a pure read — `createRouteHandler`
 * is called without `mutation`, so the body is validated but no write guard,
 * no transaction and no provider call is involved.
 */
import { graphQuerySchema } from '@/domain/schemas/http';
import { getDatasetRevision, getDb } from '@/server/db/database';
import { createRouteHandler } from '@/server/http/routeHandler';
import { getGraphData } from '@/server/services/getGraphData';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = createRouteHandler(
  { route: 'graph.read', schema: graphQuerySchema },
  ({ body }) => {
    const db = getDb();
    return getGraphData(
      db,
      {
        filter: body.filter,
        ...(body.itemIds !== undefined ? { itemIds: body.itemIds } : {}),
      },
      getDatasetRevision(db),
    );
  },
);
