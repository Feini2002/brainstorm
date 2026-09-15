/**
 * POST /api/settings/llm/test — test the current draft without saving it (T032).
 *
 * Three things happen here and nowhere else:
 *   - the key is resolved from the request when the action is `replace`, or from
 *     the stored secret when it is `keep`, with the same cross-origin transfer
 *     rule the save path uses (T032-R03);
 *   - a real run row is registered so the test occupies the single global
 *     external-call slot and its attempt count is auditable (T032-R05);
 *   - nothing is written to settings or items (T032-R04).
 */
import { AppError } from '@/domain/errors';
import type { LlmConfig, StructuredMode } from '@/domain/knowledge';
import { testLlmDraftSchema } from '@/domain/schemas/http';
import { getDb } from '@/server/db/database';
import { createRouteHandler } from '@/server/http/routeHandler';
import { requiresKeyTransferConfirmation } from '@/server/llm/endpointPolicy';
import { readApiKey, readSettings } from '@/server/repositories/settings';
import { runConnectionTest } from '@/server/services/testConnection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = createRouteHandler(
  { route: 'settings.llm.test', mutation: true, schema: testLlmDraftSchema },
  async ({ body }): Promise<{
    runId: string;
    connected: boolean;
    latencyMs: number;
    replyAccepted: boolean;
    message: string;
  }> => {
    const db = getDb();
    const stored = readSettings(db);

    /**
     * The draft must be tested against the settings revision it was built from.
     * Without this check, a test could quietly use a key the user already
     * replaced in the meantime (docs/03_contracts/04_api_contract.md §4).
     */
    if (stored.revision !== body.expectedSettingsRevision) {
      throw new AppError(
        'REVISION_CONFLICT',
        '设置已被其他窗口改过，请先重新载入再测试，避免用到过期的 Key',
      );
    }

    const draftConfig = body.draft.config;
    const config: LlmConfig = {
      adapter: draftConfig.adapter,
      baseUrl: draftConfig.baseUrl,
      model: draftConfig.model,
      structuredMode: draftConfig.structuredMode as StructuredMode,
      tokenField: draftConfig.tokenField,
      maxOutputTokens: draftConfig.maxOutputTokens,
      // A test never repairs: exactly one request may be charged (T032-R05).
      schemaRepairEnabled: false,
    };

    let apiKey: string;
    if (body.draft.keyAction === 'replace') {
      apiKey = body.draft.apiKey;
    } else {
      const storedKey = readApiKey(db);
      if (storedKey === null) {
        throw new AppError(
          'MODEL_NOT_CONFIGURED',
          '还没有保存 API Key。请选择「替换为新 Key」并填写，或先去保存一次配置',
          { apiKey: ['缺少可用的 API Key'] },
        );
      }
      // Keeping the stored secret for a different origin needs an explicit
      // confirmation, exactly as the save path requires (T032-R03).
      if (
        requiresKeyTransferConfirmation(stored.config.baseUrl, config.baseUrl) &&
        body.draft.keyAction === 'keep' &&
        body.draft.confirmKeyTransfer !== true
      ) {
        throw new AppError(
          'VALIDATION',
          '把已保存的 Key 用于新地址需要显式确认；也可以改为填写新的 Key',
          { confirmKeyTransfer: ['请确认把现有 Key 发送到新的服务器'] },
        );
      }
      apiKey = storedKey;
    }

    const result = await runConnectionTest(db, {
      requestKey: body.requestKey,
      config,
      apiKey,
      configRevision: stored.revision,
    });

    return {
      runId: result.runId,
      connected: result.connected,
      latencyMs: result.latencyMs,
      replyAccepted: result.replyAccepted,
      message: result.message,
    };
  },
);
