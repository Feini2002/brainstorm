/**
 * /api/selection — resolve a selection without sending anything (T021-R05).
 *
 * This exists so the "what will be sent" panel is not an invention of the
 * browser: the server resolves the tag snapshot, re-checks that every id still
 * exists and returns versions. A read-only call — no model is touched, so
 * navigating between pages can never incur a request (T021-C06).
 */
import { selectionQuerySchema } from '@/domain/schemas/http';
import { getDb } from '@/server/db/database';
import { createRouteHandler, parseQuery } from '@/server/http/routeHandler';
import { resolveSelection, type SelectionResolution } from '@/server/services/selection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = createRouteHandler(
  { route: 'selection.preview' },
  ({ request }): SelectionResolution => {
    const query = parseQuery(request, selectionQuerySchema);
    return resolveSelection(getDb(), {
      ...(query.itemId ? { itemIds: query.itemId } : {}),
      ...(query.fromTagId ? { fromTagId: query.fromTagId } : {}),
      ...(query.filterTagId ? { filterTagId: query.filterTagId } : {}),
    });
  },
);
