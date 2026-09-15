/**
 * T041 验收用例｜模型用量、输入范围与错误诊断（纯领域层）
 *
 * 这一组测的是“诊断只在白名单内说话”。关键的负向要求是：观测不到的数据必须
 * 写未知，不能被看起来合理的默认值填上；摘要里不能出现 Key、原文或本地路径。
 *
 * 服务与路由层（真实 SQLite 行、真实读取、真实扫描）在
 * `tests/integration/run-diagnostics.test.ts`，那里才有数据库装置。
 *
 * 所有输入都是构造的最小 fixture；没有真实密钥，也不连任何外部服务。
 */
import { describe, expect, it } from 'vitest';

import { LIMITS } from '@/domain/limits';
import {
  RUN_ERROR_CATEGORIES,
  buildRunDiagnostics,
  classifyRunError,
  formatDuration,
  usageView,
  type RunDiagnostics,
  type RunDiagnosticsInput,
} from '@/domain/runDto';
import {
  diagnosticExportToJson,
  diagnosticExportToText,
  toDiagnosticExport,
} from '@/domain/runDiagnosticsExport';

/** An obvious non-credential marker; every produced artifact is scanned for it. */
const SECRET = 'sk-test-DIAGCANARY-0987654321fedcba';

/** Private note text; the export must never contain it. */
const PRIVATE_TEXT = '我的私人笔记：银行卡号 6222 0000 1111 2222。';

/**
 * The fixture is explicitly typed as the *input* type, not inferred from the
 * literal. `as const` would narrow `state` to `'succeeded'` and `attemptCount` to
 * `1`, so a case that legitimately wants a failure could not be expressed — and
 * the tests that must vary those fields would need casts, which would hide real
 * type errors in the fields under test.
 */
function input(overrides: Partial<RunDiagnosticsInput> = {}): RunDiagnosticsInput {
  return {
    runId: 'run-1',
    kind: 'organize',
    state: 'succeeded',
    promptVersion: 'organize-v1',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:12.500Z',
    attemptCount: 1,
    resultRef: 'item-1',
    subjectId: 'item-1',
    usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
    config: {
      model: 'gpt-4o-mini',
      baseUrlOrigin: 'https://api.example.com',
      structuredMode: 'prompt_json',
      tokenField: 'none',
    },
    candidateIds: ['c1', 'c2', 'c3'],
    error: null,
    ...overrides,
  };
}

function build(overrides: Partial<RunDiagnosticsInput> = {}): RunDiagnostics {
  return buildRunDiagnostics(input(overrides));
}

describe('T041 纯领域层', () => {
  it('T041-C01 用量缺失时明确未知，不用字数换算或默认值伪装', () => {
    // 多种“没观测到”的写法都必须落到同一个显式未知。
    for (const usage of [null, undefined, {}, { inputTokens: null }, 'unknown', 0.5, []]) {
      const view = usageView(usage);
      expect(view.reported).toBe(false);
      expect(view.inputTokens).toBeNull();
      expect(view.outputTokens).toBeNull();
      expect(view.totalTokens).toBeNull();
    }

    const diagnostics = build({ usage: null });
    expect(diagnostics.usage.reported).toBe(false);
    // 摘要里写的是“未知”，不是 0，也不是按字符数估出来的数字。
    const text = diagnosticExportToText(diagnostics);
    expect(text).toContain('未知');
    expect(text).not.toContain('按字数');
  });

  it('T041-C01 只认供应商返回的数字；非法值不被折算成整数', () => {
    const view = usageView({
      inputTokens: 120,
      outputTokens: -5, // 负值不是用量
      totalTokens: Number.POSITIVE_INFINITY, // 无穷不是用量
    });
    expect(view.inputTokens).toBe(120);
    expect(view.outputTokens).toBeNull();
    expect(view.totalTokens).toBeNull();
    // 有任何一个可用数值就算“报告过”；其余字段各自保持未知。
    expect(view.reported).toBe(true);

    // 非整数被截断而不是四舍五入成另一个数字。
    expect(usageView({ totalTokens: 99.8 }).totalTokens).toBe(99);
  });

  it('T041-R02 没有任何价格表参与：摘要不出现金额或推算费用', () => {
    const text = diagnosticExportToText(build());
    const json = diagnosticExportToJson(build());
    for (const artifact of [text, json]) {
      expect(artifact).not.toMatch(/USD|\$|费用|cost|price|计费金额/u);
    }
  });

  it('T041-C02 一次修复表现为两次服务商请求，修复次数由请求数派生', () => {
    const noRepair = build({ attemptCount: 1 });
    expect(noRepair.providerRequestCount).toBe(1);
    expect(noRepair.repairAttempts).toBe(0);

    const oneRepair = build({ attemptCount: 2 });
    expect(oneRepair.providerRequestCount).toBe(2);
    expect(oneRepair.repairAttempts).toBe(1);

    // 账本异常也不允许出现负的修复次数或多次修复的假象。
    expect(build({ attemptCount: 0 }).providerRequestCount).toBe(0);
    expect(build({ attemptCount: 0 }).repairAttempts).toBe(0);
    expect(build({ attemptCount: -3 }).providerRequestCount).toBe(0);
    expect(build({ attemptCount: 1.7 }).providerRequestCount).toBe(1);

    const text = diagnosticExportToText(oneRepair);
    expect(text).toContain('服务商请求次数：2');
    expect(text).toContain('格式修复次数：1');
  });

  it('T041-C03 429 归入限流，且诊断不推断账户余额', () => {
    expect(classifyRunError('PROVIDER_RATE_LIMIT')).toBe('rate_limit');

    const diagnostics = build({
      state: 'failed',
      error: {
        code: 'PROVIDER_RATE_LIMIT',
        message: '服务商返回 429：请求过于频繁，请稍后重试',
        retryable: true,
      },
    });
    expect(diagnostics.error?.categoryLabel).toBe('限流或配额');
    expect(diagnostics.error?.retryable).toBe(true);

    // 本地无法知道剩余额度，因此摘要里不出现任何数字化的余额或重试倒计时。
    const text = diagnosticExportToText(diagnostics);
    expect(text).not.toMatch(/剩余\s*\d|剩余额度\s*\d|balance\s*\d|quota\s*=\s*\d/u);
    expect(text).not.toMatch(/\d+\s*秒后重试/u);
  });

  it('T041-R05 错误分类覆盖约定的十个层级，未知码不硬塞进邻近分类', () => {
    expect([...RUN_ERROR_CATEGORIES].sort()).toEqual(
      [
        'auth',
        'configuration',
        'format',
        'local_conflict',
        'local_storage',
        'network',
        'rate_limit',
        'semantic',
        'truncated',
        'unknown',
      ].sort(),
    );

    expect(classifyRunError('MODEL_NOT_CONFIGURED')).toBe('configuration');
    expect(classifyRunError('ENDPOINT_REJECTED')).toBe('configuration');
    expect(classifyRunError('VALIDATION')).toBe('configuration');
    expect(classifyRunError('PROVIDER_AUTH')).toBe('auth');
    expect(classifyRunError('PROVIDER_RATE_LIMIT')).toBe('rate_limit');
    expect(classifyRunError('PROVIDER_TIMEOUT')).toBe('network');
    expect(classifyRunError('PROVIDER_NETWORK')).toBe('network');
    expect(classifyRunError('PROVIDER_UNAVAILABLE')).toBe('network');
    expect(classifyRunError('PROVIDER_TRUNCATED')).toBe('truncated');
    expect(classifyRunError('STRUCTURED_INVALID')).toBe('format');
    expect(classifyRunError('PROVIDER_REFUSAL')).toBe('format');
    expect(classifyRunError('EMPTY_MODEL_OUTPUT')).toBe('format');
    expect(classifyRunError('REVISION_CONFLICT')).toBe('local_conflict');
    expect(classifyRunError('RUN_BUSY')).toBe('local_conflict');
    expect(classifyRunError('DATABASE_BUSY')).toBe('local_storage');
    expect(classifyRunError('INTERNAL')).toBe('local_storage');
    // 未知与缺失都落到 unknown，而不是被猜成别的原因。
    expect(classifyRunError('SOMETHING_NEW')).toBe('unknown');
    expect(classifyRunError(null)).toBe('unknown');
    expect(classifyRunError(undefined)).toBe('unknown');
  });

  it('T041-C05 超时与中断都会提示“可能已到达服务商、无法承诺未计费”', () => {
    const timeout = build({
      state: 'failed',
      error: { code: 'PROVIDER_TIMEOUT', message: '等待模型超过时限', retryable: true },
    });
    expect(timeout.billingNote).toContain('可能');
    expect(timeout.billingNote).toContain('计费');
    expect(diagnosticExportToText(timeout)).toContain('计费说明');

    const interrupted = build({
      state: 'interrupted',
      error: { code: 'RUN_INTERRUPTED', message: '操作超过期限，已标记为中断', retryable: true },
    });
    expect(interrupted.billingNote).not.toBeNull();

    // 成功与“根本没发出去”的配置错误不需要这条免责说明。
    expect(build({ state: 'succeeded' }).billingNote).toBeNull();
    expect(
      build({
        state: 'failed',
        attemptCount: 0,
        error: { code: 'MODEL_NOT_CONFIGURED', message: '还没有配置模型', retryable: false },
      }).billingNote,
    ).toBeNull();

    // 从未发出请求的超时（预算在本地就已耗尽）也不该声称可能被计费：
    // 一次都没发出去的请求没有到达服务商的可能。
    expect(
      build({
        state: 'failed',
        attemptCount: 0,
        error: { code: 'PROVIDER_TIMEOUT', message: '没有剩余时间', retryable: true },
      }).billingNote,
    ).toBeNull();
  });

  it('T041-C06 候选数显示实际发送量，不是上限', () => {
    expect(build({ candidateIds: [] }).candidateCount).toBe(0);
    expect(build({ candidateIds: ['a', 'b', 'c'] }).candidateCount).toBe(3);

    // 契约上限是 40，但展示的是实际发送的 30——两者必须能同时被观察到。
    const thirty = build({ candidateIds: Array.from({ length: 30 }, (_, index) => `c${index}`) });
    expect(thirty.candidateCount).toBe(30);
    expect(thirty.candidateCount).not.toBe(LIMITS.candidateCount);
    expect(LIMITS.candidateCount).toBe(40);
    expect(diagnosticExportToText(thirty)).toContain('本次发送候选数：30');
  });

  it('T041-R01 展示模型、origin、提示词版本、操作类型与耗时', () => {
    const diagnostics = build();
    expect(diagnostics.model).toBe('gpt-4o-mini');
    expect(diagnostics.endpointOrigin).toBe('https://api.example.com');
    expect(diagnostics.promptVersion).toBe('organize-v1');
    expect(diagnostics.kind).toBe('organize');
    expect(diagnostics.durationMs).toBe(12_500);
    expect(formatDuration(diagnostics.durationMs)).toBe('12.5 秒');

    // 未结束的运行没有耗时，而不是 0。
    expect(build({ finishedAt: null }).durationMs).toBeNull();
    expect(formatDuration(null)).toBe('未知');
    // 结束早于开始的脏数据也不产出负数时长。
    expect(
      build({ startedAt: '2026-01-01T00:00:10.000Z', finishedAt: '2026-01-01T00:00:00.000Z' })
        .durationMs,
    ).toBeNull();
  });

  it('T041-C04 导出走白名单：字段集合固定，不含条目 ID 或候选列表', () => {
    const parsed = JSON.parse(diagnosticExportToJson(build())) as Record<string, unknown>;

    expect(Object.keys(parsed).sort()).toEqual(
      [
        'application',
        'billingNote',
        'candidateCount',
        'durationMs',
        'durationText',
        'endpointOrigin',
        'errorCategory',
        'errorCategoryLabel',
        'errorCode',
        'errorMessage',
        'errorRetryable',
        'finishedAt',
        'kind',
        'kindLabel',
        'model',
        'promptVersion',
        'providerRequestCount',
        'repairAttempts',
        'runId',
        'startedAt',
        'state',
        'structuredMode',
        'tokenField',
        'usage',
      ].sort(),
    );

    // 结构本身就不可能承载候选 ID 列表、条目 ID 或运行结果引用。
    for (const forbidden of ['candidateIds', 'subjectId', 'resultRef', 'apiKey', 'rawText']) {
      expect(parsed).not.toHaveProperty(forbidden);
    }
  });

  it('T041-C04 导出文本与 JSON 都不含秘密与原文标记', () => {
    const diagnostics = build();
    const artifacts = [diagnosticExportToJson(diagnostics), diagnosticExportToText(diagnostics)];
    for (const artifact of artifacts) {
      expect(artifact).not.toContain(SECRET);
      expect(artifact).not.toContain(PRIVATE_TEXT);
      expect(artifact).not.toContain('银行卡');
      expect(artifact).not.toContain('C:\\');
      expect(artifact).not.toContain('/home/');
      expect(artifact).not.toContain('X-Brain-Token');
    }
  });

  it('T041-R01 快照字段缺失时写“未记录”，不编造模型名或档位', () => {
    const diagnostics = buildRunDiagnostics(input({ config: {} }));
    expect(diagnostics.model).toBe('');
    expect(diagnostics.endpointOrigin).toBe('（未配置）');
    expect(diagnostics.structuredMode).toBe('');
    expect(diagnostics.tokenField).toBe('');
    const text = diagnosticExportToText(diagnostics);
    expect(text).toContain('（未记录）');
    expect(text).toContain('（未配置）');
  });

  it('T041-R03 DTO 保留候选 ID 供“回到来源”，导出只保留数量', () => {
    const diagnostics = build({ candidateIds: ['a', 'b', 'c'] });
    // DTO 保留 id：UI 需要它们把用户送回具体条目。
    expect(diagnostics.candidateIds).toEqual(['a', 'b', 'c']);
    // 导出的对象里只有数量：分享故障不需要分享引用了哪些私人条目。
    const exported = toDiagnosticExport(diagnostics);
    expect(exported.candidateCount).toBe(3);
    expect(exported).not.toHaveProperty('candidateIds');
  });

  it('T041 诊断是纯投影：输入对象不被改写', () => {
    const source = input({ candidateIds: ['x'] });
    const frozenCandidates = [...source.candidateIds];
    const diagnostics = buildRunDiagnostics(source);
    // 返回的数组是副本，调用方之后改动来源不会让 DTO 变样。
    diagnostics.candidateIds.push('y');
    expect([...source.candidateIds]).toEqual(frozenCandidates);
  });
});
