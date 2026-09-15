/**
 * POST /api/import/validate — dry-run a backup file (T071).
 *
 * `bodyLimit: 'import'` is what makes T071-C05 real: the twenty-MiB cap is
 * enforced *while reading the stream*, before the whole body is buffered, so an
 * oversized upload is refused without first allocating it. `readJsonBody`
 * checks `Content-Length` when present and then counts bytes as they arrive, so
 * a chunked upload that lies about its size is still stopped.
 *
 * Returns the validation report even when the bundle is invalid — a 200 with
 * `valid: false` is the contract shape, because "your file has a problem" is a
 * successful answer to "would this restore?". A malformed *request* (not a
 * bundle, oversized) is still a 4xx.
 */
import { getDb } from '@/server/db/database';
import { createRouteHandler } from '@/server/http/routeHandler';
import { importValidateSchema } from '@/domain/schemas/http';
import { validateImport } from '@/server/services/validateImport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = createRouteHandler(
  {
    route: 'import.validate',
    mutation: true,
    schema: importValidateSchema,
    // The body is a whole-library backup, so the generous import cap applies
    // rather than the 64 KiB default for ordinary JSON requests.
    bodyLimit: 'import',
  },
  ({ body }) => {
    // `mutation: true` would normally mean a write; here it selects the stricter
    // origin+token guard, which is correct for a route that reads a user's file
    // contents. The handler itself performs no writes (R05).
    return validateImport(getDb(), body.bundle);
  },
);
