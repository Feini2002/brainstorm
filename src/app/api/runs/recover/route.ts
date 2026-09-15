/**
 * /api/runs/recover — sweep expired leases (T040-C01).
 *
 * Exposed as an explicit POST rather than folded into every read, because it is a
 * state change and the app should be honest about that. The page calls it on
 * startup so a previous crash is reconciled before the user sees anything, and
 * `GET /api/runs/:id` performs the same recovery for its own row.
 *
 * Like recovery everywhere else, this never calls a model and never deletes a run.
 */
import type { RecoveredIds } from '@/domain/api';
import { getDb } from '@/server/db/database';
import { createRouteHandler } from '@/server/http/routeHandler';
import { recoverExpiredRuns } from '@/server/services/runs/recoverExpiredRuns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = createRouteHandler(
  { route: 'runs.recover', mutation: true },
  (): RecoveredIds => ({
    recoveredIds: recoverExpiredRuns(getDb()),
  }),
);
