/**
 * GET /api/diagnostics — version, capability and safety summary (T074).
 *
 * ## Why this is a private route and not a "health" endpoint
 *
 * `GET /api/health` exists and stays public, but it is allowed to say almost
 * nothing: an application name, a healthy flag and a protocol version. This route
 * reports row counts, the schema version, the model *host*, whether a key is
 * configured and the observability journal — a description of the library and
 * the machine, which is exactly what a hostile page in the user's own browser
 * would like to read off `127.0.0.1`. So it goes through the same local guard as
 * every other private API (T074-R01): the guard runs before this handler body,
 * which means a request without the process token is rejected without a single
 * database read. Being called "health" or "diagnostics" does not make config
 * public.
 *
 * ## What this route does not do
 *
 * It never calls a model, never writes a row, and contacts no third-party
 * service. The one deliberate lock operation is
 * `probeWriteLock`, which reserves the SQLite write lock and immediately
 * releases it so the response can say whether another connection holds it
 * (T074-C02); it leaves no transaction open and changes no data. Because that
 * probe is a genuine write reservation, `Cache-Control: no-store` is set by the
 * shared envelope helper like every other route.
 *
 * The latency sample for this read is recorded *after* the report is built, so
 * the number inside a response describes earlier reads. Recording a value
 * measured halfway through the work would be a number that does not mean what it
 * says; the note in `observability.apiLatency` states the delay instead.
 */
import { getDb } from '@/server/db/database';
import { createRouteHandler } from '@/server/http/routeHandler';
import {
  buildDiagnosticsReport,
  recordDiagnosticsRead,
} from '@/server/observability/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = createRouteHandler({ route: 'diagnostics.read' }, () => {
  const startedAt = performance.now();
  const report = buildDiagnosticsReport(getDb());
  const durationMs = Math.round(performance.now() - startedAt);
  recordDiagnosticsRead(durationMs, 200);
  return report;
});
