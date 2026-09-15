/**
 * /api/export — download the whole library as a logical backup (T070).
 *
 * The registry types this response as `BundleFile`, so like the single-view
 * export it returns the document itself rather than the `{ok, data}` envelope:
 * a JSON envelope wrapping a JSON backup would not open in a text editor as a
 * backup, and the point of the logical format is that a user can read it.
 *
 * The read guard is applied by hand in the same order as every other route
 * because returning a file must not mean being unguarded. A failure is emitted as
 * the normal JSON error envelope with its real status — the contract is explicit
 * that a failed download must not leave the user with an error message saved
 * under a plausible backup filename (`docs/03_contracts/10_backup_bundle.md` §2).
 *
 * No request body and no query parameters: this is a whole-library operation.
 */
import { toSafeError } from '@/domain/errors';
import { getDb } from '@/server/db/database';
import { guardError, logRequestFailure } from '@/server/http/errors';
import { jsonFailure, requestFacts, requestIdFrom } from '@/server/http/respond';
import { guardRead } from '@/server/security/localGuard';
import { exportKnowledge } from '@/server/services/exportKnowledge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const requestId = requestIdFrom(request.headers.get('x-request-id'));
  try {
    const guard = guardRead(requestFacts(request));
    if (!guard.ok) throw guardError(guard.failure ?? 'origin');

    // `exportKnowledge` throws before returning when the bundle exceeds the
    // twenty-MiB budget, so there is no path that writes a truncated body.
    const outcome = exportKnowledge(getDb());

    // Serialized here, after the read transaction closed: formatting a large
    // library must not hold a read lock, and measuring the bytes is only
    // meaningful once the exact bytes exist.
    const body = new TextEncoder().encode(JSON.stringify(outcome.bundle, null, 2));

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        // Fixed `feini-brain-<UTC date>.json`; the title never reaches the path
        // and the name is safe to place in a header verbatim (R05).
        'Content-Disposition': `attachment; filename="${outcome.fileName}"`,
        'Content-Length': String(body.byteLength),
        // A backup is a point-in-time artifact; a cached copy would be a stale
        // backup that looks current.
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'x-request-id': requestId,
      },
    });
  } catch (error) {
    const safe = toSafeError(error);
    logRequestFailure({ requestId, route: 'export', error, safe });
    return jsonFailure(error, requestId);
  }
}
