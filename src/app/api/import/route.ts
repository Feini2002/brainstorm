/**
 * POST /api/import — commit a validated backup (T072).
 *
 * The request carries both the bundle and the `expectedBundleHash` the client
 * was shown at validation time. Requiring the hash makes the commit checkable:
 * the server re-derives the hash of what actually arrived and refuses if it
 * differs, so a client cannot validate one file and commit another (R01).
 *
 * Errors keep their own codes — `IMPORT_NONEMPTY` (409) is a different situation
 * from `IMPORT_INVALID` (422), and the UI's next action differs for each, so they
 * are not flattened into one "import failed".
 */
import { getDb } from '@/server/db/database';
import { createRouteHandler } from '@/server/http/routeHandler';
import { importConfirmSchema } from '@/domain/schemas/http';
import { importKnowledge } from '@/server/services/importKnowledge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = createRouteHandler(
  {
    route: 'import.commit',
    mutation: true,
    schema: importConfirmSchema,
    // A whole-library backup, so the generous import cap applies.
    bodyLimit: 'import',
  },
  ({ body }) => {
    return importKnowledge(getDb(), {
      bundle: body.bundle,
      expectedBundleHash: body.expectedBundleHash,
    });
  },
);
