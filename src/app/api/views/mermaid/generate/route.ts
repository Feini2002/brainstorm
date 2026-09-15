/**
 * /api/views/mermaid/generate — generate a flow view from a selection (T063).
 *
 * The path says "mermaid" and the request carries no Mermaid: that is deliberate,
 * and it is the point of the endpoint. The client sends which records to look at,
 * the question it is asking, and which way the diagram should run; the *server*
 * builds the prompt, validates the answer and compiles the syntax. There is no
 * field on this body through which a caller could supply a diagram, a style, a
 * click handler or a Mermaid directive — `flowGenerationRequestSchema` is strict,
 * so an added key is a 400 rather than an honoured instruction (T062-R03, T063-R06).
 *
 * The request stays open until the run reaches a terminal state, exactly like
 * organize and mindmap: there is no queue and no background completion, so the
 * response *is* the outcome. A page may poll `/api/runs/{id}` while this is open.
 */
import type { RunResult } from '@/domain/api';
import { flowGenerationRequestSchema } from '@/domain/schemas/http';
import { getDb } from '@/server/db/database';
import { createRouteHandler } from '@/server/http/routeHandler';
import { callSnapshot } from '@/server/llm/types';
import { readApiKey, readSettings } from '@/server/repositories/settings';
import { generateFlow } from '@/server/services/generateFlow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = createRouteHandler(
  { route: 'views.mermaid.generate', mutation: true, schema: flowGenerationRequestSchema },
  async ({ body }): Promise<RunResult> => {
    const db = getDb();
    const settings = readSettings(db);
    const apiKey = readApiKey(db);

    // The key is resolved here, in process, and handed to the service as a call
    // snapshot, so it exists only in this frame (docs/03_contracts/06 §1).
    const config = callSnapshot(settings.config, apiKey ?? '');

    const result = await generateFlow(db, {
      requestKey: body.requestKey,
      selection: { mode: 'explicit', itemIds: body.selection.itemIds },
      intent: body.intent,
      direction: body.direction,
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
