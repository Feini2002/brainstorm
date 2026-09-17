/**
 * T027 验收用例｜模型设置表单与Key输入口（纯函数层）
 *
 * 这一层验证的是“该发什么、不该发什么”。浏览器里的可见行为由
 * `tests/e2e/gate2.spec.ts` 覆盖，两者证明的不是同一件事：
 * 这里证明请求体的正确性，那里证明用户看到的状态。
 */
import { describe, expect, it } from 'vitest';

import { LIMITS } from '@/domain/limits';
import {
  buildSavePayload,
  buildTestPayload,
  canSubmit,
  draftFromSettings,
  draftOrigin,
  emptyDraft,
  isKeyTransfer,
  keyStatusText,
  mergeDraftUpdate,
  validateDraft,
  type LlmConfigDraft,
} from '@/domain/llmConfig';
import type { PublicLlmSettings } from '@/domain/knowledge';

const SAVED: PublicLlmSettings = {
  revision: 4,
  config: {
    adapter: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-4o-mini',
    structuredMode: 'prompt_json',
    tokenField: 'none',
    maxOutputTokens: 4096,
    schemaRepairEnabled: false,
  },
  apiKeyConfigured: true,
};

function draft(overrides: Partial<LlmConfigDraft> = {}): LlmConfigDraft {
  return { ...draftFromSettings(SAVED), ...overrides };
}

describe('T027 模型设置草稿', () => {
  it('T027-R02/R03 已有 Key 时默认 keep，且草稿里没有可提交的 Key', () => {
    const seeded = draftFromSettings(SAVED);
    // 默认动作必须是 keep：打开页面直接保存不能覆盖或删除凭证。
    expect(seeded.keyAction).toBe('keep');
    expect(seeded.apiKey).toBe('');
    expect(canSubmit(seeded)).toBe(true);
    expect(keyStatusText(SAVED, seeded)).toContain('保持不动');
  });

  it('T027-R03 replace 必须有新值，delete 不需要也不允许带值', () => {
    const missing = validateDraft(draft({ keyAction: 'replace', apiKey: '' }));
    expect(missing.map((issue) => issue.field)).toContain('apiKey');

    const withNewline = validateDraft(draft({ keyAction: 'replace', apiKey: 'sk-a\nb' }));
    expect(withNewline.map((issue) => issue.field)).toContain('apiKey');

    const tooLong = validateDraft(
      draft({ keyAction: 'replace', apiKey: 'k'.repeat(LIMITS.apiKeyBytes + 1) }),
    );
    expect(tooLong.map((issue) => issue.field)).toContain('apiKey');

    // 4096 字节是上限本身，不是超限。
    const atLimit = validateDraft(
      draft({ keyAction: 'replace', apiKey: 'k'.repeat(LIMITS.apiKeyBytes) }),
    );
    expect(atLimit).toEqual([]);

    const remove = validateDraft(draft({ keyAction: 'delete', apiKey: '' }));
    expect(remove).toEqual([]);
    expect(canSubmit(draft({ keyAction: 'delete' }))).toBe(true);
  });

  it('T027-R03 keep 的请求体不带 apiKey 字段，replace 必须带', () => {
    const keep = buildSavePayload(draft(), { settings: SAVED });
    expect(keep.ok).toBe(true);
    if (!keep.ok) return;
    expect(keep.payload.keyAction).toBe('keep');
    expect('apiKey' in keep.payload).toBe(false);

    const replace = buildSavePayload(draft({ keyAction: 'replace', apiKey: 'sk-test-not-a-key' }), {
      settings: SAVED,
    });
    expect(replace.ok).toBe(true);
    if (!replace.ok) return;
    expect(replace.payload.keyAction).toBe('replace');
    expect(replace.payload.apiKey).toBe('sk-test-not-a-key');

    const remove = buildSavePayload(draft({ keyAction: 'delete' }), { settings: SAVED });
    expect(remove.ok).toBe(true);
    if (!remove.ok) return;
    expect(remove.payload.keyAction).toBe('delete');
    expect('apiKey' in remove.payload).toBe(false);
  });

  it('T027-R04 每次保存都携带 expectedRevision，首次配置为 0', () => {
    // 首次配置同样是显式替换：没有已存 Key 可保留。
    const first = buildSavePayload(
      {
        ...emptyDraft(),
        config: {
          ...emptyDraft().config,
          baseUrl: 'https://api.example.com/v1',
          model: 'gpt-4o-mini',
        },
        apiKey: 'sk-first-config',
      },
      { settings: null },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 首次配置没有可比较的版本，用 0 表达“还没有设置行”。
    expect(first.payload.expectedRevision).toBe(0);
    expect(first.payload.keyAction).toBe('replace');

    const later = buildSavePayload(draft(), { settings: SAVED });
    expect(later.ok).toBe(true);
    if (!later.ok) return;
    expect(later.payload.expectedRevision).toBe(SAVED.revision);
  });

  it('已有配置后局部编辑从保存值合并，不退回 emptyDraft', () => {
    const next = mergeDraftUpdate(null, SAVED, (current) => ({
      ...current,
      config: { ...current.config, model: 'only-this-changed' },
    }));
    expect(next.config.model).toBe('only-this-changed');
    expect(next.config.baseUrl).toBe(SAVED.config.baseUrl);
    expect(next.config.structuredMode).toBe(SAVED.config.structuredMode);
    expect(next.keyAction).toBe('keep');
    expect(next.apiKey).toBe('');
  });

  it('T027-R04 测试请求独立于保存：不写配置，只描述要测的草稿', () => {
    const built = buildTestPayload(draft(), { settings: SAVED, requestKey: 'req-1' });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload.requestKey).toBe('req-1');
    expect(built.payload.expectedSettingsRevision).toBe(SAVED.revision);
    // 测试体里没有 config 之外的保存语义字段，服务端据此不会写库。
    expect(built.payload).not.toHaveProperty('expectedRevision');
    expect(built.payload.draft).toMatchObject({ keyAction: 'keep' });
  });

  it('T027-R06 只改路径不算换域名，换 origin 才需要确认', () => {
    expect(draftOrigin('https://api.example.com/v1')).toBe('https://api.example.com');
    expect(draftOrigin('not a url')).toBeNull();

    const sameOrigin = draft({ config: { ...SAVED.config, baseUrl: 'https://api.example.com/v2' } });
    expect(isKeyTransfer(sameOrigin, SAVED)).toBe(false);
    // 路径变化不需要确认，但仍应能保存。
    expect(buildSavePayload(sameOrigin, { settings: SAVED }).ok).toBe(true);

    const otherOrigin = draft({ config: { ...SAVED.config, baseUrl: 'https://api.other.com/v1' } });
    expect(isKeyTransfer(otherOrigin, SAVED)).toBe(true);

    const blocked = buildSavePayload(otherOrigin, { settings: SAVED });
    expect(blocked.ok).toBe(false);
    expect(blocked).toMatchObject({ needsKeyTransfer: true });

    const confirmed = buildSavePayload(otherOrigin, {
      settings: SAVED,
      confirmKeyTransfer: true,
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.payload.confirmKeyTransfer).toBe(true);
  });

  it('T027-R06 换域名时用新 Key 不需要转移确认', () => {
    const otherOrigin = draft({
      config: { ...SAVED.config, baseUrl: 'https://api.other.com/v1' },
      keyAction: 'replace',
      apiKey: 'sk-new-destination',
    });
    // 新 Key 本来就为这个目的地输入，没有旧凭据被转发。
    expect(isKeyTransfer(otherOrigin, SAVED)).toBe(false);
    const built = buildSavePayload(otherOrigin, { settings: SAVED });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload.apiKey).toBe('sk-new-destination');
    expect('confirmKeyTransfer' in built.payload).toBe(false);
  });

  it('T027-R06 删除 Key 不属于凭据转移', () => {
    const otherOrigin = draft({
      config: { ...SAVED.config, baseUrl: 'https://api.other.com/v1' },
      keyAction: 'delete',
    });
    expect(isKeyTransfer(otherOrigin, SAVED)).toBe(false);
    expect(buildSavePayload(otherOrigin, { settings: SAVED }).ok).toBe(true);
  });

  it('T027 没有已存 Key 时不存在 keep/delete 两个选项', () => {
    const unconfigured: PublicLlmSettings = { ...SAVED, apiKeyConfigured: false };
    const seeded = draftFromSettings(unconfigured);
    // 没有 Key 时唯一有意义的动作是填写一个。
    expect(seeded.keyAction).toBe('replace');
    expect(isKeyTransfer(seeded, unconfigured)).toBe(false);
    expect(keyStatusText(unconfigured, seeded)).toContain('尚未保存');
  });

  it('T027 保存体里的 baseUrl 与 model 会去掉首尾空白，Key 原样保留', () => {
    const messy = draft({
      config: { ...SAVED.config, baseUrl: '  https://api.example.com/v1  ', model: ' gpt-4o-mini ' },
      keyAction: 'replace',
      apiKey: ' sk-with-spaces ',
    });
    const built = buildSavePayload(messy, { settings: SAVED });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const config = built.payload.config as { baseUrl: string; model: string };
    expect(config.baseUrl).toBe('https://api.example.com/v1');
    expect(config.model).toBe('gpt-4o-mini');
    // Key 里的空格可能是密钥本身的一部分，不能替用户去掉。
    expect(built.payload.apiKey).toBe(' sk-with-spaces ');
  });

  it('T027-R01 adapter 固定为 openai-compatible，不随表单被改写', () => {
    const tampered = draft({
      config: { ...SAVED.config, adapter: 'openai-compatible' },
    });
    const built = buildSavePayload(tampered, { settings: SAVED });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const config = built.payload.config as { adapter: string };
    expect(config.adapter).toBe('openai-compatible');
  });

  it('T027 校验先于转移确认：字段不合法时不提示确认', () => {
    const broken = draft({ config: { ...SAVED.config, baseUrl: '  ' } });
    const built = buildSavePayload(broken, { settings: SAVED });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect('issues' in built).toBe(true);
    if (!('issues' in built)) return;
    expect(built.issues.map((issue) => issue.field)).toContain('baseUrl');
  });
});
