'use client';

/**
 * API key input (T027-R02, T027-R03).
 *
 * The whole point of this component is what it *does not* do:
 *
 *   - It never renders a stored key. A saved secret is communicated by
 *     `apiKeyConfigured` and a status sentence, never by a value in the DOM
 *     (T027-C01「必须排除：成功后持续在DOM保留Key」).
 *   - It never puts a placeholder of asterisks in `value`. Asterisks would look
 *     like a real value and could be submitted as one (T027-R02), so the empty
 *     input carries only a hint, and the field is disabled unless the user is
 *     actually replacing the key.
 *   - It clears the typed value as soon as it is no longer needed: switching to
 *     `keep` (or away from the page) drops the plaintext from component state.
 *
 * The password field uses `autoComplete="new-password"` so a browser's own
 * password manager does not offer to remember an API key.
 */
import { Button, Field, TextInput } from '@/components/ui/primitives';
import type { KeyAction, LlmConfigDraft } from '@/domain/llmConfig';
import { KEY_STORAGE_NOTICE, keyStatusText } from '@/domain/llmConfig';
import type { PublicLlmSettings } from '@/domain/knowledge';

export interface KeyFieldProps {
  settings: PublicLlmSettings | null;
  draft: LlmConfigDraft;
  error?: string | undefined;
  disabled?: boolean;
  onKeyAction: (action: KeyAction) => void;
  onApiKey: (value: string) => void;
  /** Opens the inline explanation of local plaintext storage. */
  onShowNotice: () => void;
}

export function KeyField({
  settings,
  draft,
  error,
  disabled = false,
  onKeyAction,
  onApiKey,
  onShowNotice,
}: KeyFieldProps) {
  const configured = settings?.apiKeyConfigured ?? false;

  return (
    <div className="flex flex-col gap-3" data-testid="key-field">
      <Field
        label="API Key"
        htmlFor="llm-api-key"
        hint="只由本机服务在调用模型时使用，页面不会读回已保存的值。"
        {...(error ? { error } : {})}
      >
        <TextInput
          id="llm-api-key"
          data-testid="llm-api-key"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          // Never `disabled` while the user is replacing: a disabled password
          // field is what makes people think asterisks were submitted.
          disabled={disabled || draft.keyAction !== 'replace'}
          value={draft.apiKey}
          onChange={(event) => onApiKey(event.target.value)}
          placeholder={configured ? '输入新值以替换已保存的 Key' : '粘贴你的 API Key'}
        />
      </Field>

      <fieldset className="flex flex-col gap-2" disabled={disabled}>
        <legend className="text-sm font-medium text-[var(--ink)]">这个 Key 要怎么处理</legend>
        <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Key 处理方式">
          {!configured ? null : (
            <label className="flex items-center gap-2 text-sm text-[var(--ink)]">
              <input
                type="radio"
                name="key-action"
                data-testid="key-action-keep"
                value="keep"
                checked={draft.keyAction === 'keep'}
                onChange={() => onKeyAction('keep')}
              />
              保持不变
            </label>
          )}
          <label className="flex items-center gap-2 text-sm text-[var(--ink)]">
            <input
              type="radio"
              name="key-action"
              data-testid="key-action-replace"
              value="replace"
              checked={draft.keyAction === 'replace'}
              onChange={() => onKeyAction('replace')}
            />
            {configured ? '替换为新 Key' : '填写 Key'}
          </label>
          {!configured ? null : (
            <label className="flex items-center gap-2 text-sm text-[var(--ink)]">
              <input
                type="radio"
                name="key-action"
                data-testid="key-action-delete"
                value="delete"
                checked={draft.keyAction === 'delete'}
                onChange={() => onKeyAction('delete')}
              />
              删除已保存的 Key
            </label>
          )}
        </div>
        <p
          className="text-xs text-[var(--ink-muted)]"
          data-testid="key-status"
          role="status"
          aria-live="polite"
        >
          {keyStatusText(settings, draft)}
        </p>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" data-testid="key-notice-open" onClick={onShowNotice}>
          Key 存在哪里？
        </Button>
        <span className="text-xs text-[var(--ink-muted)]">
          仅本机服务调用 · 默认明文存储 · 不进入逻辑导出
        </span>
      </div>

      <ul
        className="flex list-disc flex-col gap-1 rounded-md border border-[var(--line)] bg-[var(--surface-raised)] p-3 pl-7 text-xs text-[var(--ink-muted)]"
        data-testid="key-notice"
      >
        {KEY_STORAGE_NOTICE.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
