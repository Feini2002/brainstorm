/**
 * /api/runs/:id — read one run's status (T040).
 *
 * This endpoint answers "where is the thing I started?" and does nothing else.
 * In particular it never calls a model (T040-R05): a GET that could start a paid
 * request would turn a page refresh into a charge, and would make the browser the
 * scheduler for work the contract says has no queue.
 *
 * It also performs lease recovery before reading, so a process killed mid-request
 * cannot leave an item stuck on `processing` forever (T040-C01). Recovery only
 * touches rows whose deadline has genuinely passed, which is why a reload of a
 * healthy in-flight run still reports `running` (T040-C02).
 */
import { AppError } from '@/domain/errors';
import type { RunDTO } from '@/domain/knowledge';
import { getDb } from '@/server/db/database';
import { createDynamicRouteHandler } from '@/server/http/routeHandler';
import { findRunById } from '@/server/repositories/runs';
import { recoverExpiredRuns } from '@/server/services/runs/recoverExpiredRuns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = createDynamicRouteHandler(
  { route: 'runs.get' },
  ({ params }): RunDTO => {
    const db = getDb();

    // Recover first, then read: a still-running row past its lease must be
    // reported as interrupted rather than as an operation that is still working.
    recoverExpiredRuns(db);

    const run = findRunById(db, params.id);
    if (!run) throw new AppError('NOT_FOUND', '没有找到这次运行的记录');
    return run;
  },
);
