/**
 * /api/items/:id/organize — organize one item with the configured model (T036).
 *
 * The request stays open until the run reaches a terminal state (T036-R05). There
 * is no queue and no background completion: the response *is* the result, because
 * a page that returned early and finished later would be lying about durability.
 * A page may poll `/api/runs/{id}` while this is open, and the run row is the
 * single source of truth for what happened.
 *
 * `expectedRevision` is carried through to the commit transaction rather than
 * checked only here: the model call takes seconds, and the user may edit the item
 * in that window (T036-R03).
 */
import type { RunResult } from '@/domain/api';
import { organizeRequestSchema } from '@/domain/schemas/http';
import { getDb } from '@/server/db/database';
import { createDynamicRouteHandler } from '@/server/http/routeHandler';
import { callSnapshot } from '@/server/llm/types';
import { readApiKey, readSettings } from '@/server/repositories/settings';
import { organizeItem } from '@/server/services/organizeItem';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = createDynamicRouteHandler(
  { route: 'items.organize', mutation: true, schema: organizeRequestSchema },
  async ({ body, params }): Promise<RunResult> => {
    const db = getDb();
    const settings = readSettings(db);
    const apiKey = readApiKey(db);

    // Resolved here, in process, and handed to the service as a call snapshot: the
    // key lives only in this frame (docs/03_contracts/06_llm_pipeline.md §1).
    const config = callSnapshot(
      settings.config,
      apiKey ?? '',
    );

    const result = await organizeItem(db, {
      requestKey: body.requestKey,
      itemId: params.id,
      expectedRevision: body.expectedRevision,
      config,
      configRevision: settings.revision,
      schemaRepairEnabled: settings.config.schemaRepairEnabled,
    });

    return {
      runId: result.runId,
      itemId: result.itemId,
      state: result.state,
      warnings: result.warnings,
      resultMissing: result.state === 'succeeded' && result.item === null,
    };
  },
);
