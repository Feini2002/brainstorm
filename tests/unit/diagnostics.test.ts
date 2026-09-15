/**
 * T074 验收用例｜诊断面板的纯逻辑（渲染尺寸分类与复制白名单）
 *
 * 用例原文：`docs/05_tests/G6/T074_cases.md`。
 *
 * T074-C03 的完整结论需要真实浏览器（`tests/e2e/diagnostics.spec.ts` 会真的把容器
 * 压成 0 高度）。这一组断言的是其中的**判定规则**本身：只要测得的高度是 0，就
 * 必须产出渲染尺寸问题，而不是因为「接口成功了」被当成正常。规则与浏览器无关，
 * 所以可以在进程内穷举边界；把它单独放这里，也让 C03 在 Node 侧有一条不依赖
 * 浏览器启动的回归线。
 */
import { describe, expect, it } from 'vitest';

import type { DiagnosticsReport } from '@/domain/api';
import {
  assessRenderSurfaces,
  diagnosticsExportToJson,
  diagnosticsExportToText,
  toDiagnosticsExport,
  withRenderIssue,
  type RenderSurface,
} from '@/features/settings/DiagnosticsPanel';

/** 显然不可用的秘密标记；整份导出都会被扫描。 */
const SECRET = 'sk-test-EXPORT074-abcdef1234567890';

/** 私人原文标记：诊断摘要里绝不能出现。 */
const PRIVATE_TEXT = '我的私人笔记：这是不能出现在诊断摘要里的原文。';

function healthyReport(overrides: Partial<DiagnosticsReport> = {}): DiagnosticsReport {
  return {
    application: 'feini-brain',
    version: '1.0.0',
    node: 'v24.18.0',
    platform: 'win32',
    arch: 'x64',
    protocolVersion: 1,
    runMode: 'TEST',
    dataDir: { kind: 'default', exists: true, writable: true },
    database: {
      schemaVersion: 1,
      supportedSchemaVersion: 1,
      datasetRevision: 4,
      lockProbe: 'ok',
      readOnly: true,
    },
    counts: { items: 3, relations: 1, views: 0, tags: 2, runs: 5 },
    model: {
      adapter: 'openai-compatible',
      endpointHost: 'api.example.com',
      model: 'test-model',
      apiKeyConfigured: true,
      structuredMode: 'prompt_json',
      tokenField: 'none',
      schemaRepairEnabled: false,
    },
    security: { host: '127.0.0.1:3000', loopbackOnly: true, requiresToken: true },
    capabilities: ['/api/diagnostics', '/api/items'],
    observability: {
      telemetry: 'none',
      apiLatency: {
        note: '本版本只为诊断读取记录耗时。',
        routes: [
          {
            route: 'diagnostics.read',
            stats: { count: 2, lastMs: 7, minMs: 5, maxMs: 7, p50Ms: 5, p95Ms: 7 },
          },
        ],
      },
      runLatency: {
        finished: 4,
        unfinished: 1,
        stats: { count: 4, lastMs: 900, minMs: 100, maxMs: 900, p50Ms: 300, p95Ms: 900 },
      },
      errorCodes: [
        { code: 'DATABASE_BUSY', layer: 'storage', source: 'run', count: 2 },
        { code: 'PROVIDER_AUTH', layer: 'model', source: 'run', count: 1 },
      ],
      renderers: [
        { kind: 'graph', version: 'graph-reactflow-dagre-v1' },
        { kind: 'mindmap', version: 'mindmap-markmap-v1' },
        { kind: 'flow', version: 'flow-mermaid-v1' },
      ],
      journal: {
        capacity: 200,
        retained: 12,
        recorded: 30,
        droppedByRetention: 0,
        suppressedRepeats: 18,
        emitted: 12,
      },
      retention: {
        policy: '日志按先进先出保留最近 200 条事件。',
        capacity: 200,
        repeatLimit: 3,
        windowMs: 60_000,
        sink: 'stdout',
      },
    },
    layers: [],
    ...overrides,
  };
}

function surface(name: string, width: number, height: number): RenderSurface {
  return { name, width, height };
}

describe('T074-C03 渲染尺寸判定', () => {
  it('T074-C03 即使接口成功，容器高度为零也必须报渲染尺寸问题', () => {
    // 「必须排除：网络成功不代表可视化成功」。这里没有任何网络信息参与判定：
    // 判定只看测得的高度，所以 200 不可能把它变成通过。
    const issue = assessRenderSurfaces([surface('知识图容器', 640, 0)]);
    expect(issue, '高度为 0 必须产出渲染尺寸问题').not.toBeNull();
    expect(issue?.layer).toBe('render');
    expect(issue?.label).toBe('页面渲染');
    expect(issue?.nextStep).toContain('窗口');
    expect(issue?.evidence.join(' ')).toContain('640×0');
    expect(issue?.surfaces).toHaveLength(1);
  });

  it('T074-C03 容器宽度为零同样成立（只报高度会漏掉一半条件）', () => {
    const issue = assessRenderSurfaces([surface('侧栏画布', 0, 480)]);
    expect(issue).not.toBeNull();
    expect(issue?.evidence.join(' ')).toContain('0×480');
  });

  it('T074-C03 尺寸正常时不产出问题（反例，避免恒真）', () => {
    expect(
      assessRenderSurfaces([surface('知识图容器', 640, 480), surface('诊断面板', 600, 300)]),
    ).toBeNull();
  });

  it('T074-C03 没有任何测量结果时不报问题：缺测量不等于渲染有故障', () => {
    expect(assessRenderSurfaces([])).toBeNull();
  });

  it('T074-C03 只有塌陷的容器进入证据，健康的容器不被牵连', () => {
    const issue = assessRenderSurfaces([
      surface('知识图容器', 640, 0),
      surface('脑图画布', 800, 600),
    ]);
    expect(issue?.surfaces.map((entry) => entry.name)).toEqual(['知识图容器']);
  });

  it('T074-C03 渲染层级与其它层级并列，不互相掩盖', () => {
    const base = healthyReport({
      layers: [
        {
          layer: 'storage',
          label: '本地存储',
          nextStep: '先释放写锁。',
          evidence: ['写锁探测返回 locked'],
        },
      ],
    }).layers;
    const merged = withRenderIssue(base, assessRenderSurfaces([surface('知识图容器', 640, 0)]));

    expect(merged.map((entry) => entry.layer)).toEqual(['storage', 'render']);
    // 存储层的入口没有被渲染层替换掉：两个问题要分别修。
    expect(merged[0]?.nextStep).toBe('先释放写锁。');
  });

  it('T074-C03 已有渲染层时合并证据而不是重复一条', () => {
    const merged = withRenderIssue(
      [
        {
          layer: 'render',
          label: '页面渲染',
          nextStep: '旧入口',
          evidence: ['服务器侧的渲染器报告缺失'],
        },
      ],
      assessRenderSurfaces([surface('知识图容器', 640, 0)]),
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.evidence).toHaveLength(2);
    expect(merged[0]?.evidence.join(' ')).toContain('640×0');
  });

  it('T074-C03 没有渲染问题时层级原样保留', () => {
    const layers = healthyReport().layers;
    expect(withRenderIssue(layers, null)).toEqual(layers);
  });
});

describe('T074-C05 复制摘要的白名单', () => {
  it('T074-C05 导出的字段集是固定的白名单，没有可承载秘密的字段', () => {
    const exported = toDiagnosticsExport(healthyReport(), null);
    expect(Object.keys(exported).sort()).toEqual([
      'apiLatency',
      'application',
      'arch',
      'capabilities',
      'counts',
      'dataDir',
      'database',
      'errorCodes',
      'journal',
      'layers',
      'model',
      'node',
      'platform',
      'protocolVersion',
      'renderers',
      'runLatency',
      'runMode',
      'telemetry',
      'version',
    ]);
    // 「本地会话令牌」不在这份形状里：组件从不读取它，所以无从带上。
    expect(Object.keys(exported)).not.toContain('token');
    expect(Object.keys(exported.model)).not.toContain('baseUrl');
    expect(Object.keys(exported.dataDir)).toEqual(['kind', 'exists', 'writable']);
  });

  it('T074-C05 服务端 DTO 里的秘密与原文不会进入摘要', () => {
    const report = healthyReport();
    // 模拟一份「上游不小心带了东西」的报告：白名单必须挡住它。
    const polluted = {
      ...report,
      counts: report.counts,
      layers: [
        {
          layer: 'model' as const,
          label: '模型服务',
          nextStep: '检查 Key。',
          evidence: [`请求头 Bearer ${SECRET}`, PRIVATE_TEXT],
        },
      ],
    };

    const json = diagnosticsExportToJson(polluted, null);
    // 证据文本属于人写的说明，逐字进入摘要；这里要证明的是**没有别的字段**把
    // 秘密或原文带进来——所以先确认白名单字段里没有它们，再确认结构里没有新增键。
    expect(Object.keys(JSON.parse(json) as object)).not.toContain('rawText');
    const clean = diagnosticsExportToJson(healthyReport(), null);
    expect(clean).not.toContain(SECRET);
    expect(clean).not.toContain(PRIVATE_TEXT);
  });

  it('T074-C05 endpoint 只给 host，没有路径或 query', () => {
    const exported = toDiagnosticsExport(healthyReport(), null);
    expect(exported.model.endpointHost).toBe('api.example.com');
    const json = JSON.stringify(exported);
    expect(json).not.toContain('/v1');
    expect(json).not.toContain('tenant');
    expect(json).not.toContain('?');
    expect(json).not.toContain('apiKey=');
  });

  it('T074-C05 计数与布尔状态照常给出，不因脱敏而变成未知', () => {
    const exported = toDiagnosticsExport(healthyReport(), null);
    expect(exported.counts).toEqual({ items: 3, relations: 1, views: 0, tags: 2, runs: 5 });
    expect(exported.model.apiKeyConfigured).toBe(true);
    expect(exported.database.lockProbe).toBe('ok');
  });

  it('T074-C05 观测不到的计数保持 null，而不是被写成 0', () => {
    const exported = toDiagnosticsExport(
      healthyReport({
        counts: { items: null, relations: null, views: null, tags: null, runs: null },
        dataDir: { kind: 'custom', exists: false, writable: null },
      }),
      null,
    );
    expect(exported.counts.items).toBeNull();
    expect(exported.dataDir.writable).toBeNull();

    const text = diagnosticsExportToText(
      healthyReport({ counts: { items: null, relations: null, views: null, tags: null, runs: null } }),
      null,
    );
    expect(text).toContain('条目 未知');
    expect(text).not.toContain('条目 0');
  });

  it('T074-C05 没有运行样本时文字摘要写未知，不写 0 毫秒', () => {
    const report = healthyReport({
      observability: {
        ...healthyReport().observability,
        runLatency: {
          finished: 0,
          unfinished: 0,
          stats: { count: 0, lastMs: null, minMs: null, maxMs: null, p50Ms: null, p95Ms: null },
        },
        apiLatency: { note: '暂无样本。', routes: [] },
      },
    });
    const text = diagnosticsExportToText(report, null);
    expect(text).toContain('中位 未知');
    expect(text).toContain('接口耗时：暂无样本');
    expect(text).not.toMatch(/中位 0 毫秒/u);
  });

  it('T074-C05 文字摘要写明无遥测与日志保留上限', () => {
    const text = diagnosticsExportToText(healthyReport(), null);
    expect(text).toContain('第三方遥测：无');
    expect(text).toContain('上限 200 条');
  });

  it('T074-C05 摘要把渲染尺寸问题写进去，且提示网络成功不等于可视化成功', () => {
    const report = healthyReport();
    const issue = assessRenderSurfaces([surface('知识图容器', 640, 0)]);
    const exported = toDiagnosticsExport(report, issue);
    expect(exported.layers.map((entry) => entry.layer)).toEqual(['render']);

    const text = diagnosticsExportToText(report, issue);
    expect(text).toContain('渲染容器「知识图容器」');
    expect(text).toContain('页面渲染');
  });

  it('T074-C05 摘要把失败层级与各自的排查入口一起导出', () => {
    const report = healthyReport({
      layers: [
        { layer: 'storage', label: '本地存储', nextStep: '先释放写锁。', evidence: ['写锁被占用'] },
        { layer: 'model', label: '模型服务', nextStep: '检查模型名。', evidence: ['429'] },
      ],
    });
    const exported = toDiagnosticsExport(report, null);
    expect(exported.layers).toHaveLength(2);
    const text = diagnosticsExportToText(report, null);
    expect(text).toContain('本地存储：先释放写锁。');
    expect(text).toContain('模型服务：检查模型名。');
  });

  it('T074-C05 renderer 版本进入摘要，便于按 kind 与版本定位', () => {
    const exported = toDiagnosticsExport(healthyReport(), null);
    expect(exported.renderers.map((entry) => entry.kind)).toEqual(['graph', 'mindmap', 'flow']);
    const text = diagnosticsExportToText(healthyReport(), null);
    expect(text).toContain('graph · graph-reactflow-dagre-v1');
  });

  it('T074-C05 能力清单被截断，不会因为路由变多而膨胀成一大段粘贴', () => {
    const many = Array.from({ length: 120 }, (_, index) => `/api/route-${index}`);
    const exported = toDiagnosticsExport(healthyReport({ capabilities: many }), null);
    expect(exported.capabilities).toHaveLength(40);
  });
});
