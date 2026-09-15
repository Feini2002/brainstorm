/**
 * /api/views/{id}/freshness — why a view is out of date, and what regenerating
 * it would send (T059).
 *
 * A separate route rather than more fields on `GET /api/views/{id}` for the same
 * reason `…/diagnostics` is separate from `/api/runs/{id}`: the freshness report
 * re-resolves the stored selection against the live database, which is real work
 * and a different question from "what is this view". Attaching it to every view
 * read would make opening a list of views resolve every selection.
 *
 * A read in the strict sense (T059-R05): it resolves material to *count* it, and
 * writes nothing — no view update, no `generatedAt` bump, no model request.
 */
import { getDb } from '@/server/db/database';
import { createDynamicRouteHandler } from '@/server/http/routeHandler';
import { getViewFreshness } from '@/server/services/views/getFreshness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = createDynamicRouteHandler({ route: 'views.freshness' }, ({ params }) =>
  getViewFreshness(getDb(), params.id),
);
