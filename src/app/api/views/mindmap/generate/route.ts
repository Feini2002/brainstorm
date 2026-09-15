/**
 * /api/views/mindmap/generate — generate a mindmap from a selection (T055).
 *
 * The request stays open until the run reaches a terminal state, exactly like
 * organize: there is no queue and no background completion, so the response *is*
 * the outcome. A page may poll `/api/runs/{id}` while this is open.
 *
 * The body carries only the selection, an optional intent and an optional name.
 * It deliberately cannot carry note text: the server re-reads the material from
 * the database, which is what makes the saved view's provenance trustworthy
 * (T054-R01, docs/03_contracts/04 §4).
 */
import type { RunResult } from '@/domain/api';
import { generationRequestSchema } from '@/domain/schemas/http';
import { getDb } from '@/server/db/database';
import { createRouteHandler } from '@/server/http/routeHandler';
import { callSnapshot } from '@/server/llm/types';
import { readApiKey, readSettings } from '@/server/repositories/settings';
import { generateMindmap } from '@/server/services/generateMindmap';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = createRouteHandler(
  { route: 'views.mindmap.generate', mutation: true, schema: generationRequestSchema },
  async ({ body }): Promise<RunResult> => {
    const db = getDb();
    const settings = readSettings(db);
    const apiKey = readApiKey(db);

    // The key is resolved here, in process, and handed to the service as a call
    // snapshot, so it exists only in this frame (docs/03_contracts/06 §1).
    const config = callSnapshot(settings.config, apiKey ?? '');

    const result = await generateMindmap(db, {
      requestKey: body.requestKey,
      selection: { mode: 'explicit', itemIds: body.selection.itemIds },
      ...(body.intent !== undefined ? { intent: body.intent } : {}),
      config,
      configRevision: settings.revision,
      schemaRepairEnabled: settings.config.schemaRepairEnabled,
    });

    return {
      runId: result.runId,
      ...(result.viewId !== null ? { viewId: result.viewId } : {}),
      state: result.state,
      warnings: result.warnings,
      // A replay whose View was since deleted must say so rather than imply the
      // projection still exists (docs/03_contracts/04 §4).
      ...(result.replayed && result.state === 'succeeded' && result.view === null
        ? { resultMissing: true }
        : {}),
    };
  },
);
