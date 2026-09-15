'use client';

/**
 * Model connection settings (T027).
 *
 * Three rules shape the whole component:
 *
 *  1. **Save and test are separate actions.** `test` sends the current draft to
 *     `/api/settings/llm/test` and persists nothing; `save` is the only thing
 *     that PUTs. Testing an unsaved draft is a supported, expected path
 *     (T027-C04), so the two buttons share no state beyond the draft itself.
 *  2. **The revision is a first-class value.** Every write carries the
 *     `expectedRevision` the page loaded, so two windows editing at once produce
 *     a 409 instead of silently retargeting later requests (T027-C06).
 *  3. **The key is never echoed.** The form holds a typed value only while the
 *     user chooses `replace`, and drops it the moment the save succeeds.
 */
import { useCallback, useMemo, useState } from 'react';

import type { PublicLlmSettings } from '@/domain/knowledge';
import { ApiClientError, apiRequest } from '@/features/shared/apiClient';
import {
  ADAPTER_LABELS,
  LLM_ADAPTERS,
  MODEL_SUGGESTIONS,
  STRUCTURED_MODES,
  STRUCTURED_MODE_HINTS,
  STRUCTURED_MODE_LABELS,
  TOKEN_FIELDS,
  TOKEN_FIELD_HINTS,
  TOKEN_FIELD_LABELS,
  buildSavePayload,
  buildTestPayload,
  canSubmit,
  draftFromSettings,
  emptyDraft,
  isFirstConfiguration,
  isKeyTransfer,
  issueFor,
  validateDraft,
  type KeyAction,
  type LlmConfigDraft,
} from '@/domain/llmConfig';
import { LIMITS } from '@/domain/limits';
import {
  Button,
  Field,
  InlineError,
  LoadingIndicator,
  SectionCard,
  Select,
  TextInput,
} from '@/components/ui/primitives';
import { useApiQuery } from '@/features/shared/useApiQuery';

import { KeyField } from './KeyField';
import { TestResult } from './TestResult';

/** Stable id source for one test attempt; the server uses it for dedup. */
function newRequestKey(): string {
  return crypto.randomUUID();
}

export interface LlmSettingsFormProps {
  /** Notified after any successful settings write so other pages can refresh. */
  onSaved?: (settings: PublicLlmSettings) => void;
  /** Bumped by the app shell when something else changed settings. */
  refreshToken?: number;
}

interface TestOutcome {
  connected: boolean;
  replyAccepted: boolean;
  latencyMs: number;
  message: string;
  /** Model reported by the provider, when it answered. */
  model?: string;
}
export function LlmSettingsForm({ onSaved, refreshToken = 0 }: LlmSettingsFormProps) {
  const state = useApiQuery<PublicLlmSettings>('/api/settings/llm', { version: refreshToken });
  const settings = state.data;

  const [userDraft, setUserDraft] = useState<LlmConfigDraft | null>(null);
  const [confirmedTransfer, setConfirmedTransfer] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState<ApiClientError | null>(null);
  const [conflict, setConflict] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);

  /**
   * The draft is *derived*, not copied into state by an effect.
   *
   * `userDraft` holds user edits only. Until the user touches something the form
   * shows the server state directly, so a background refresh is reflected and no
   * effect has to write state synchronously (which cascades renders). A
   * successful save clears `userDraft`, which is what makes the form fall back
   * to the freshly returned server values — including clearing the typed key.
   */
  const draft = useMemo(
    () => userDraft ?? draftFromSettings(settings),
    [settings, userDraft],
  );
  const issues = useMemo(() => validateDraft(draft), [draft]);
  const transfer = isKeyTransfer(draft, settings);
  const submittable = canSubmit(draft) && (!transfer || confirmedTransfer);

  const patchConfig = useCallback((patch: Partial<LlmConfigDraft['config']>) => {
    setUserDraft((existing) => {
      const base = existing ?? emptyDraft();
      return { ...base, config: { ...base.config, ...patch } };
    });
    // Any config change invalidates a previous test result and a previous
    // transfer confirmation: both were about a different destination.
    setOutcome(null);
    setConfirmedTransfer(false);
    setSavedNotice(null);
  }, []);

  /**
   * Change the key intention.
   *
   * Leaving `replace` drops whatever was typed. Keeping a plaintext key in
   * component state while the action is `keep` would be a leak with no purpose
   * (T027-R03), and clearing here is what makes "empty means unchanged"
   * unambiguous (T027-C02/R03).
   */
  const changeKeyAction = useCallback((action: KeyAction) => {
    setUserDraft((existing) => {
      const base = existing ?? emptyDraft();
      return { ...base, keyAction: action, apiKey: action === 'replace' ? base.apiKey : '' };
    });
    setOutcome(null);
    setSavedNotice(null);
    if (action !== 'delete') setConfirmedTransfer(false);
  }, []);

  const submit = useCallback(async () => {
    if (saving) return;
    const built = buildSavePayload(draft, {
      settings,
      confirmKeyTransfer: confirmedTransfer,
    });
    if (!built.ok) {
      if ('needsKeyTransfer' in built) setConfirmedTransfer(false);
      return;
    }
    setSaving(true);
    setSaveError(null);
    setConflict(false);
    setSavedNotice(null);
    try {
      const saved = await apiRequest<PublicLlmSettings>('/api/settings/llm', {
        method: 'PUT',
        body: built.payload,
      });
      // Clear the typed key the instant it is stored; the DOM must not keep it
      // (T027-C01). The reload brings back `apiKeyConfigured` and the new
      // revision, which is what the next write must be based on.
      setUserDraft(draftFromSettings(saved));
      setConfirmedTransfer(false);
      setOutcome(null);
      setSavedNotice(
        draft.keyAction === 'delete'
          ? '已删除保存的 Key。知识库不受影响，模型功能会在需要时提示未配置。'
          : '已保存。下面的配置与 Key 状态来自服务端返回的结果。',
      );
      onSaved?.(saved);
      state.setData(saved);
    } catch (caught) {
      if (caught instanceof ApiClientError) {
        setSaveError(caught);
        // The draft is deliberately left untouched on every failure, including
        // 409: losing typed text or an unsaved key to a conflict would be worse
        // than the conflict itself (T027-C06).
        if (caught.code === 'REVISION_CONFLICT') setConflict(true);
      } else {
        setSaveError(
          new ApiClientError({ code: 'INTERNAL', message: '保存失败', retryable: true }),
        );
      }
    } finally {
      setSaving(false);
    }
  }, [confirmedTransfer, draft, onSaved, saving, settings, state]);

  const runTest = useCallback(async () => {
    if (testing) return;
    const built = buildTestPayload(draft, {
      settings,
      confirmKeyTransfer: confirmedTransfer,
      requestKey: newRequestKey(),
    });
    if (!built.ok) {
      if ('needsKeyTransfer' in built) setConfirmedTransfer(false);
      return;
    }
    setTesting(true);
    setOutcome(null);
    try {
      const result = await apiRequest<{
        connected: boolean;
        replyAccepted: boolean;
        latencyMs: number;
        message?: string | null;
      }>('/api/settings/llm/test', { method: 'POST', body: built.payload });
      setOutcome({
        connected: result.connected,
        replyAccepted: result.replyAccepted,
        latencyMs: result.latencyMs,
        model: draft.config.model,
        message: result.message ?? '服务端没有返回说明。',
      });
    } catch (caught) {
      setOutcome({
        // A thrown error means we never got a valid completion: both states fail,
        // and the message explains which configuration item to fix first.
        connected: false,
        replyAccepted: false,
        latencyMs: 0,
        message:
          caught instanceof ApiClientError
            ? `连接失败：${caught.message}`
            : '连接失败：本地服务没有返回结果',
      });
    } finally {
      setTesting(false);
    }
  }, [confirmedTransfer, draft, settings, testing]);

  // A derived draft is never null once a read has resolved; `settings === null`
  // is the documented "no settings row yet" state, not a loading state.
  if (state.loading && settings === null) {
    return <LoadingIndicator label="正在读取模型设置" />;
  }

  if (state.error && settings === null) {
    return (
      <InlineError message={state.error.message}>
        <Button variant="secondary" onClick={state.reload}>
          重新读取
        </Button>
      </InlineError>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {conflict ? (
        <InlineError
          message="这个连接配置已被另一个窗口改过，你看到的是旧版本。你的输入还在下面，没有丢失。"
        >
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              data-testid="settings-reload"
              onClick={() => {
                state.reload();
                setConflict(false);
              }}
            >
              载入服务端最新配置
            </Button>
            <Button
              variant="ghost"
              data-testid="settings-keep-draft"
              onClick={() => {
                // Re-reading refreshes `settings` (and therefore
                // `expectedRevision`) without touching the draft: `userDraft`
                // still holds the user's edits, so nothing typed is lost and no
                // fake save success is reported.
                state.reload();
                setConflict(false);
              }}
            >
              保留我的输入并重试
            </Button>
          </div>
        </InlineError>
      ) : null}

      {saveError && !conflict ? (
        <InlineError
          message={
            saveError.retryable
              ? `${saveError.message}。设置没有改动，可以重试。`
              : `设置没有保存：${saveError.message}`
          }
        />
      ) : null}

      <SectionCard
        title="连接配置"
        description="首版只支持 OpenAI 兼容的聊天补全接口。模型能力不由供应商名字推断，请按服务商文档填写。"
      >
        <div className="grid gap-3">
          <Field label="接口类型" htmlFor="llm-adapter">
            <Select
              id="llm-adapter"
              data-testid="llm-adapter"
              value={draft.config.adapter}
              onChange={() => {
                /* Only one adapter exists; the control documents that fact. */
              }}
            >
              {LLM_ADAPTERS.map((value) => (
                <option key={value} value={value}>
                  {ADAPTER_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Base URL"
            htmlFor="llm-base-url"
            hint="填写基础地址，不要包含 /chat/completions；只接受 HTTPS 公网地址。"
            {...(issueFor(issues, 'baseUrl') ? { error: issueFor(issues, 'baseUrl')! } : {})}
          >
            <TextInput
              id="llm-base-url"
              data-testid="llm-base-url"
              value={draft.config.baseUrl}
              onChange={(event) => patchConfig({ baseUrl: event.target.value })}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
            />
          </Field>

          <Field
            label="模型名"
            htmlFor="llm-model"
            hint="按服务商文档填写准确的模型 ID，例如 gpt-4o-mini。"
            {...(issueFor(issues, 'model') ? { error: issueFor(issues, 'model')! } : {})}
          >
            <TextInput
              id="llm-model"
              data-testid="llm-model"
              list="llm-model-suggestions"
              value={draft.config.model}
              onChange={(event) => patchConfig({ model: event.target.value })}
              placeholder="gpt-4o-mini"
              spellCheck={false}
            />
          </Field>
          <datalist id="llm-model-suggestions">
            {MODEL_SUGGESTIONS.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>

          <Field
            label="结构化输出方式"
            htmlFor="llm-structured-mode"
            hint={STRUCTURED_MODE_HINTS[draft.config.structuredMode]}
          >
            <Select
              id="llm-structured-mode"
              data-testid="llm-structured-mode"
              value={draft.config.structuredMode}
              onChange={(event) =>
                patchConfig({
                  structuredMode: event.target.value as LlmConfigDraft['config']['structuredMode'],
                })
              }
            >
              {STRUCTURED_MODES.map((value) => (
                <option key={value} value={value}>
                  {STRUCTURED_MODE_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="输出长度参数"
            htmlFor="llm-token-field"
            hint={TOKEN_FIELD_HINTS[draft.config.tokenField]}
          >
            <Select
              id="llm-token-field"
              data-testid="llm-token-field"
              value={draft.config.tokenField}
              onChange={(event) =>
                patchConfig({
                  tokenField: event.target.value as LlmConfigDraft['config']['tokenField'],
                })
              }
            >
              {TOKEN_FIELDS.map((value) => (
                <option key={value} value={value}>
                  {TOKEN_FIELD_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="最多输出 token 数"
            htmlFor="llm-max-output"
            hint={`1 到 ${LIMITS.maxOutputTokens}，仅在选择了长度参数时发送。`}
          >
            <TextInput
              id="llm-max-output"
              data-testid="llm-max-output"
              type="number"
              min={1}
              max={LIMITS.maxOutputTokens}
              value={draft.config.maxOutputTokens}
              onChange={(event) =>
                patchConfig({ maxOutputTokens: Number.parseInt(event.target.value, 10) || 1 })
              }
            />
          </Field>

          <label className="flex items-start gap-2 text-sm text-[var(--ink)]">
            <input
              type="checkbox"
              data-testid="llm-schema-repair"
              className="mt-0.5"
              checked={draft.config.schemaRepairEnabled}
              onChange={(event) => patchConfig({ schemaRepairEnabled: event.target.checked })}
            />
            <span>
              允许一次格式修复
              <span className="block text-xs text-[var(--ink-muted)]">
                首次返回的不是合法 JSON 时，再请求一次，并把错误提示给模型。总共最多两次付费请求。
              </span>
            </span>
          </label>
        </div>
      </SectionCard>

      <SectionCard
        title="API Key"
        description={
          isFirstConfiguration(settings)
            ? '首次配置需要填写 Key。'
            : '已保存的 Key 只以状态显示，页面不会读回它的值。'
        }
      >
        <KeyField
          settings={settings}
          draft={draft}
          {...(issueFor(issues, 'apiKey') ? { error: issueFor(issues, 'apiKey')! } : {})}
          disabled={saving}
          onKeyAction={changeKeyAction}
          onApiKey={(value) => {
            setUserDraft((existing) => ({ ...(existing ?? emptyDraft()), apiKey: value }));
            setOutcome(null);
          }}
          onShowNotice={() => setOutcome(null)}
        />
      </SectionCard>

      {transfer ? (
        <div
          className="flex flex-col gap-2 rounded-md border border-[var(--warn)] bg-[var(--surface-raised)] p-3 text-sm"
          data-testid="key-transfer-notice"
          role="alert"
        >
          <p>
            保存的 Key 将被发送到新的地址 <code>{draft.config.baseUrl.trim()}</code>。
            这是另一个服务器，请确认你确实要这样做。
          </p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              data-testid="key-transfer-confirm"
              checked={confirmedTransfer}
              onChange={(event) => setConfirmedTransfer(event.target.checked)}
            />
            我确认把现有 Key 用于这个新地址
          </label>
          <p className="text-xs text-[var(--ink-muted)]">
            如果不确认，也可以选择「替换为新 Key」或把地址改回原样。
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          data-testid="settings-save"
          disabled={!submittable || saving}
          onClick={() => void submit()}
        >
          {saving ? '保存中…' : '保存配置'}
        </Button>
        <Button
          variant="secondary"
          data-testid="settings-test"
          disabled={!submittable || testing}
          onClick={() => void runTest()}
        >
          {testing ? '测试中…' : '测试当前草稿'}
        </Button>
        <span className="text-xs text-[var(--ink-muted)]">
          测试不会写入配置；它用下面填写的内容直接请求一次。
        </span>
      </div>

      <p className="text-xs text-[var(--ink-muted)]" data-testid="settings-revision">
        当前配置版本：revision {settings?.revision ?? 0}
        {settings?.apiKeyConfigured ? ' · 已保存 Key' : ' · 未保存 Key'}
      </p>

      {savedNotice ? (
        <div
          role="status"
          data-testid="settings-saved"
          className="rounded-md border border-[var(--line)] bg-[var(--surface-raised)] p-3 text-sm text-[var(--ink)]"
        >
          {savedNotice}
        </div>
      ) : null}

      {outcome ? <TestResult value={{ ...outcome, running: testing }} /> : null}
    </div>
  );
}
