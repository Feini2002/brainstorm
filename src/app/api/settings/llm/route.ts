/**
 * /api/settings/llm — read and write model connection settings (T029).
 *
 * GET is a private read and returns the public projection only. PUT is a
 * mutation that carries `expectedRevision`, so concurrent windows conflict
 * instead of silently overwriting each other's destination.
 *
 * The key-transfer confirmation is re-checked here rather than trusted from the
 * browser (T027-R06): a client that skipped the checkbox must not be able to
 * move a stored credential to a new origin by calling the API directly.
 */
import type { PublicLlmSettings } from '@/domain/knowledge';
import { saveLlmSettingsSchema } from '@/domain/schemas/http';
import { AppError } from '@/domain/errors';
import { getDb } from '@/server/db/database';
import { createRouteHandler } from '@/server/http/routeHandler';
import { requiresKeyTransferConfirmation } from '@/server/llm/endpointPolicy';
import { publicSettings, readSettings, writeSettings } from '@/server/repositories/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/settings/llm — connection fields + apiKeyConfigured, nothing else. */
export const GET = createRouteHandler({ route: 'settings.llm.get' }, (): PublicLlmSettings =>
  publicSettings(getDb()),
);

/** PUT /api/settings/llm — atomic config + key write with optimistic concurrency. */
export const PUT = createRouteHandler(
  { route: 'settings.llm.put', mutation: true, schema: saveLlmSettingsSchema },
  ({ body }): PublicLlmSettings => {
    const db = getDb();
    const current = readSettings(db);

    if (
      body.keyAction === 'keep' &&
      requiresKeyTransferConfirmation(current.config.baseUrl, body.config.baseUrl) &&
      body.confirmKeyTransfer !== true
    ) {
      throw new AppError(
        'VALIDATION',
        '把已保存的 Key 用于新地址需要显式确认；也可以改为填写新的 Key',
        { confirmKeyTransfer: ['请确认把现有 Key 发送到新的服务器'] },
      );
    }

    writeSettings(db, {
      config: body.config,
      keyAction: body.keyAction,
      ...('apiKey' in body ? { apiKey: body.apiKey } : {}),
      expectedRevision: body.expectedRevision,
    });

    return publicSettings(db);
  },
);
