/**
 * /api/views/{id}/layout — save graph node positions (T047).
 *
 * Separate from `PATCH /api/views/{id}` because a debounced drag commit and a
 * rename are different user actions with different payloads: this route accepts
 * only coordinates, so a layout save can never change a name, and a rename can
 * never move a node. Positions are merged into `content_json`; no item field is
 * written (T047-R01).
 */
import { saveGraphLayoutSchema } from '@/domain/schemas/http';
import { getDb } from '@/server/db/database';
import { createDynamicRouteHandler } from '@/server/http/routeHandler';
import { existingItemIds } from '@/server/repositories/items';
import { saveGraphLayout, type SaveGraphLayoutResult } from '@/server/services/saveGraphLayout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PUT = createDynamicRouteHandler(
  { route: 'views.layout', mutation: true, schema: saveGraphLayoutSchema },
  ({ body, params }): SaveGraphLayoutResult => {
    const db = getDb();

    return saveGraphLayout(
      db,
      {
        viewId: params.id,
        expectedRevision: body.expectedRevision,
        positions: body.positions,
        ...(body.direction !== undefined ? { direction: body.direction } : {}),
        ...(body.viewport !== undefined ? { viewport: body.viewport } : {}),
      },
      // Asked after the stored content is read, so it covers the union of stored
      // and incoming ids.
      (ids) => existingItemIds(db, ids),
    );
  },
);
