/**
 * LLM connection draft rules (T027-R01…R06).
 *
 * Pure form logic, deliberately kept out of the component so it can be unit
 * tested without a DOM. Three concerns live here and nowhere else:
 *
 *   1. What a draft *is* — a config plus one of three explicit key intentions.
 *      There is no fourth state ("key unchanged but present") because that is
 *      exactly the ambiguity T027-R02/R03 forbid.
 *   2. Whether the draft may be submitted, and as what payload. `expectedRevision`
 *      is always carried (T027-R04) and a key is never sent on `keep`.
 *   3. Whether a key would be moved to a different origin (T027-R06). The server
 *      re-checks this; the client check exists so the user is asked *before* the
 *      secret leaves the machine, not after.
 *
 * Nothing here reads the saved key: the browser only ever knows
 * `apiKeyConfigured` (docs/03_contracts/05_settings_and_security.md §3).
 */
import {
  DEFAULT_LLM_CONFIG,
  STRUCTURED_MODES,
  TOKEN_FIELDS,
  type LlmConfig,
  type PublicLlmSettings,
  type StructuredMode,
  type TokenField,
} from './knowledge';
import { LIMITS } from './limits';

/** Key intention. A discriminated union so `apiKey` cannot exist on `keep`. */
export type KeyAction = 'keep' | 'replace' | 'delete';

export interface LlmConfigDraft {
  config: LlmConfig;
  keyAction: KeyAction;
  /** Only meaningful for `replace`; cleared after a successful save (T027-C01). */
  apiKey: string;
}

/* -------------------------------------------------------------------------- */
/* R01: the first adapter's real capability surface                           */
/* -------------------------------------------------------------------------- */

/** Only this adapter exists in the MVP; the field is not a vendor list. */
export const LLM_ADAPTERS = ['openai-compatible'] as const;

export const ADAPTER_LABELS: Record<(typeof LLM_ADAPTERS)[number], string> = {
  'openai-compatible': 'OpenAI 兼容接口',
};

/**
 * Both modes are just "ask for JSON" — one by instruction, one by the provider's
 * `response_format`. Neither is a guarantee, so the UI must not describe them as
 * validation; it says what the request does and lets the user choose.
 */
export const STRUCTURED_MODE_LABELS: Record<StructuredMode, string> = {
  prompt_json: '在提示词中要求 JSON（默认，兼容性最好）',
  json_object: '请求 response_format: json_object',
};

export const STRUCTURED_MODE_HINTS: Record<StructuredMode, string> = {
  prompt_json: '所有供应商都能收到这种请求；是否返回合法 JSON 由提示词约束。',
  json_object: '需要服务端支持该参数；不支持会直接报错，不会静默降级。',
};

export const TOKEN_FIELD_LABELS: Record<TokenField, string> = {
  none: '不发送输出长度参数',
  max_tokens: '使用 max_tokens',
  max_completion_tokens: '使用 max_completion_tokens',
};

export const TOKEN_FIELD_HINTS: Record<TokenField, string> = {
  none: '有些模型不接受任何长度参数，选它可以把请求压到最小。',
  max_tokens: '较老的 OpenAI 兼容服务使用这个字段名。',
  max_completion_tokens: '较新的 OpenAI 接口使用这个字段名，两者只发一个。',
};

/**
 * Model names free of configuration; the user copies the exact id.
 *
 * No vendor capabilities are inferred from these names (T027-R01): picking one
 * fills a text field, it does not switch behaviour.
 */
export const MODEL_SUGGESTIONS: readonly string[] = [
  'gpt-4o-mini',
  'gpt-4.1-mini',
  'deepseek-chat',
  'qwen-plus',
];

/* -------------------------------------------------------------------------- */
/* Draft construction                                                         */
/* -------------------------------------------------------------------------- */

/** A blank first-time draft. Used when the settings row does not exist yet. */
export function emptyDraft(): LlmConfigDraft {
  return { config: { ...DEFAULT_LLM_CONFIG }, keyAction: 'replace', apiKey: '' };
}

/**
 * Build the form state for the current saved settings.
 *
 * When a key is already stored the action defaults to `keep`, so opening the
 * page and pressing save can never silently drop or overwrite the credential
 * (T027-C02). With no stored key the only useful action is `replace`.
 */
export function draftFromSettings(settings: PublicLlmSettings | null): LlmConfigDraft {
  if (!settings) return emptyDraft();
  return {
    config: { ...settings.config },
    keyAction: settings.apiKeyConfigured ? 'keep' : 'replace',
    apiKey: '',
  };
}

export function isFirstConfiguration(settings: PublicLlmSettings | null): boolean {
  return settings === null || settings.revision === 0;
}

export function isConfigured(settings: PublicLlmSettings | null): boolean {
  if (!settings) return false;
  return settings.config.baseUrl.trim().length > 0 && settings.config.model.trim().length > 0;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export interface DraftIssue {
  field: 'baseUrl' | 'model' | 'apiKey' | 'expectedRevision';
  message: string;
}

/**
 * Origin of a base URL, or null when it cannot be parsed.
 *
 * The client mirrors the server's origin notion for one purpose only — deciding
 * whether to ask about credential transfer. It is not an outbound policy
 * replacement: HTTPS, loopback and private-address rules stay on the server
 * (T028) and are never re-implemented here.
 */
export function draftOrigin(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl.trim());
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * A key would move to a different origin if kept.
 *
 * `delete` never transfers anything, and `replace` carries a value the user is
 * typing for that destination right now, so neither needs a confirmation.
 * Compare against the *saved* base URL, not the previous draft, because the
 * question is "does the stored secret change destination".
 */
export function isKeyTransfer(draft: LlmConfigDraft, settings: PublicLlmSettings | null): boolean {
  if (draft.keyAction !== 'keep') return false;
  if (!settings?.apiKeyConfigured) return false;
  const previous = draftOrigin(settings.config.baseUrl);
  const next = draftOrigin(draft.config.baseUrl);
  if (previous === null || next === null) return false;
  return previous !== next;
}

export function validateDraft(draft: LlmConfigDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const { config } = draft;

  if (config.baseUrl.trim().length === 0) {
    issues.push({ field: 'baseUrl', message: '请填写 Base URL' });
  }
  if (config.model.trim().length === 0) {
    issues.push({ field: 'model', message: '请填写模型名' });
  }
  if (draft.keyAction === 'replace') {
    if (draft.apiKey.length === 0) {
      issues.push({ field: 'apiKey', message: '替换 Key 时请填写新值' });
    } else if (/\r|\n/u.test(draft.apiKey)) {
      issues.push({ field: 'apiKey', message: 'API Key 不能包含换行' });
    } else if (new TextEncoder().encode(draft.apiKey).length > LIMITS.apiKeyBytes) {
      issues.push({ field: 'apiKey', message: `API Key 不能超过 ${LIMITS.apiKeyBytes} 字节` });
    }
  }

  return issues;
}

export function issueFor(issues: DraftIssue[], field: DraftIssue['field']): string | undefined {
  return issues.find((issue) => issue.field === field)?.message;
}

/**
 * Can the draft be submitted as-is?
 *
 * A pending key-transfer confirmation is not an "invalid field" — the draft is
 * well-formed, it just needs one more explicit decision — so callers render that
 * separately and keep the payload free of `confirmKeyTransfer: false`.
 */
export function canSubmit(draft: LlmConfigDraft): boolean {
  return validateDraft(draft).length === 0;
}

/* -------------------------------------------------------------------------- */
/* Save payload (T027-R03/R04)                                                 */
/* -------------------------------------------------------------------------- */

export interface SaveDraftContext {
  settings: PublicLlmSettings | null;
  /** True only after the user acknowledged the credential moving to a new host. */
  confirmKeyTransfer?: boolean;
}

export type SaveDraftResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; issues: DraftIssue[] }
  | { ok: false; needsKeyTransfer: true };

/**
 * Build the PUT body.
 *
 * `apiKey` appears only for `replace`; `keep` must not carry it at all rather
 * than send an empty string, because the server treats the two differently
 * (docs/03_contracts/05_settings_and_security.md §3).
 */
export function buildSavePayload(
  draft: LlmConfigDraft,
  context: SaveDraftContext,
): SaveDraftResult {
  const issues = validateDraft(draft);
  if (issues.length > 0) return { ok: false, issues };

  if (isKeyTransfer(draft, context.settings) && context.confirmKeyTransfer !== true) {
    return { ok: false, needsKeyTransfer: true };
  }

  const payload: Record<string, unknown> = {
    // `expectedRevision` is always present: a settings write without a CAS guard
    // could silently retarget every later paid request (T027-R04/R06).
    expectedRevision: context.settings?.revision ?? 0,
    config: normalizedConfig(draft.config),
  };

  switch (draft.keyAction) {
    case 'replace':
      payload.keyAction = 'replace';
      payload.apiKey = draft.apiKey;
      break;
    case 'delete':
      payload.keyAction = 'delete';
      break;
    case 'keep':
    default:
      payload.keyAction = 'keep';
      if (context.confirmKeyTransfer === true && isKeyTransfer(draft, context.settings)) {
        payload.confirmKeyTransfer = true;
      }
      break;
  }

  return { ok: true, payload };
}

/** Trim the free-text fields; never touch the key. */
export function normalizedConfig(config: LlmConfig): LlmConfig {
  return {
    ...config,
    adapter: 'openai-compatible',
    baseUrl: config.baseUrl.trim(),
    model: config.model.trim(),
  };
}

/* -------------------------------------------------------------------------- */
/* Test payload (T027-R04)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build the connection-test body.
 *
 * A test is a separate action: it never writes settings, and the draft it tests
 * is sent as-is, which is exactly why an unsaved draft can be tried without
 * changing what later runs will use (T027-C04).
 */
export function buildTestPayload(
  draft: LlmConfigDraft,
  context: SaveDraftContext & { requestKey: string },
): SaveDraftResult {
  const issues = validateDraft(draft);
  if (issues.length > 0) return { ok: false, issues };

  if (isKeyTransfer(draft, context.settings) && context.confirmKeyTransfer !== true) {
    return { ok: false, needsKeyTransfer: true };
  }

  const payload: Record<string, unknown> = {
    requestKey: context.requestKey,
    expectedSettingsRevision: context.settings?.revision ?? 0,
    draft: {
      keyAction: draft.keyAction,
      config: normalizedConfig(draft.config),
      ...(draft.keyAction === 'replace' ? { apiKey: draft.apiKey } : {}),
      ...(draft.keyAction === 'keep' &&
      context.confirmKeyTransfer === true &&
      isKeyTransfer(draft, context.settings)
        ? { confirmKeyTransfer: true }
        : {}),
    },
  };

  return { ok: true, payload };
}

/* -------------------------------------------------------------------------- */
/* Secret disclosure copy (T027-R05)                                          */
/* -------------------------------------------------------------------------- */

/**
 * What the user must be told before entering a key.
 *
 * Deliberately concrete and honest: it states the storage location, that it is
 * plaintext, that it is excluded from logical exports, and that encryption is
 * *not* claimed. It must not be softened into "加密保存" (T027-R05).
 */
export const KEY_STORAGE_NOTICE = [
  'Key 只保存在本机数据库的 secrets 表，不会被发送到模型服务以外的任何地方。',
  '默认以明文存储。本版不声称加密安全：能读到这台电脑文件的人就能读到它。',
  '逻辑导出（备份 Bundle）不包含 Key；完整数据库文件会包含。',
  '清空 Key 与删除知识库是两件独立的事，删 Key 之后仍可继续离线记录。',
] as const;

/** Short status line for the key field, so the state is never ambiguous. */
export function keyStatusText(
  settings: PublicLlmSettings | null,
  draft: LlmConfigDraft,
): string {
  if (!settings?.apiKeyConfigured) return '尚未保存 Key';
  switch (draft.keyAction) {
    case 'delete':
      return '保存后会删除已存 Key，之后需要重新填写才能使用模型';
    case 'replace':
      return '已存 Key 将在保存后被这个新值替换';
    case 'keep':
    default:
      return '已有保存的 Key，保持不动';
  }
}

export { STRUCTURED_MODES, TOKEN_FIELDS };
export type { LlmConfig, PublicLlmSettings, StructuredMode, TokenField };
