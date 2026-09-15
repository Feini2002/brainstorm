/**
 * /api/views/{id} — read, rename and delete one saved view (T053).
 *
 * Only GET returns the full content; PATCH is limited to the name and the graph
 * layout, so a rename cannot silently rewrite a projection's structure. DELETE
 * removes the view row and nothing else (T053-R03).
 */
import type { ViewDTO } from '@/domain/knowledge';
import { editViewSchema } from '@/domain/schemas/http';
import { getDb } from '@/server/db/database';
import { createDynamicRouteHandler } from '@/server/http/routeHandler';
import { editView, getView, removeView } from '@/server/services/views/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = createDynamicRouteHandler({ route: 'views.get' }, ({ params }) =>
  getView(getDb(), params.id),
);

export const PATCH = createDynamicRouteHandler(
  { route: 'views.edit', mutation: true, schema: editViewSchema },
  ({ body, params }): ViewDTO =>
    editView(getDb(), {
      id: params.id,
      expectedRevision: body.expectedRevision,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.graphLayout !== undefined
        ? {
            graphLayout: {
              positions: body.graphLayout.positions,
              direction: body.graphLayout.direction,
            },
          }
        : {}),
    }),
);

export const DELETE = createDynamicRouteHandler(
  { route: 'views.delete', mutation: true, schema: editViewSchema.pick({ expectedRevision: true }) },
  ({ body, params }) => removeView(getDb(), params.id, body.expectedRevision),
);
