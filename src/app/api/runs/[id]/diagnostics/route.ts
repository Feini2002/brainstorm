/**
 * /api/runs/:id/diagnostics — the readable detail behind one run (T041).
 *
 * Why this is a separate route rather than more fields on `GET /api/runs/:id`:
 * `RunDTO` is a versioned contract shape shared with the client, and widening it
 * with model/endpoint/prompt fields would change what every existing consumer
 * receives. The diagnostics view is a distinct, larger projection with its own
 * disclosure rules (T041-R06), so it gets its own endpoint and its own DTO.
 *
 * The read is safe to repeat: it performs lease recovery, reads, and returns.
 * It never calls a model (a GET that could start a paid request would make a page
 * refresh expensive), and the recovery it triggers is idempotent.
 */
import type { RunDiagnostics } from '@/domain/runDto';
import { getDb } from '@/server/db/database';
import { createDynamicRouteHandler } from '@/server/http/routeHandler';
import { getRunDiagnostics } from '@/server/services/getRunDiagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = createDynamicRouteHandler(
  { route: 'runs.diagnostics' },
  ({ params }): RunDiagnostics => getRunDiagnostics(getDb(), params.id),
);
