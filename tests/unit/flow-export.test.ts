/**
 * T068 验收：流程 JSON 与 Mermaid 源码导出。
 *
 * 六个具名场景在这里覆盖：源码复用（从 AST 重新编译，行为确定）、假设保留
 * （推测标记与虚线在文件里仍然可辨）、秘密扫描（逐键白名单）、未实现格式
 * （服务器不产出 SVG）、恢复区别（文件自己说明它不是整库备份）、文件名安全。
 *
 * 三个不在规格字面、但同样真实的不变量也钉在这里，因为它们是"导出悄悄变成另
 * 一种东西"的实际路径：
 *
 *  - **Mermaid 从 canonical 内容编译**，不是回读某个缓存字符串。构造一个
 *    `content` 与任意字符串不一致的输入即可区分两种实现。
 *  - **导出文件只差导出时间**。同一份内容导出两次必须逐字相等（除时间行），
 *    否则"重新导出对比"就不是一个可用的检查。
 *  - **导出是纯函数**，不修改传入的视图对象。
 */
import { describe, expect, it } from 'vitest';

import type { FlowContent, ViewDTO } from '@/domain/knowledge';
import {
  FLOW_EXPORT_FORMATS,
  FLOW_EXPORT_SCHEMA_VERSION,
  FLOW_SERVER_EXPORT_FORMATS,
  buildFlowExport,
  buildFlowExportJson,
  buildFlowMermaid,
  flowExportContentType,
  flowExportFileName,
  isFlowExportFormat,
  isServerFlowExportFormat,
  type BuildFlowExportInput,
} from '@/domain/flowExport';
import { compileFlow } from '@/domain/compileFlow';
import { FLOW_COMPILER_VERSION } from '@/domain/compileFlow';

const EXPORTED_AT = '2026-09-15T04:30:00.000Z';
const ITEM_A = '11111111-1111-4111-8111-111111111111';
const ITEM_B = '22222222-2222-4222-8222-222222222222';
const RELATION = '33333333-3333-4333-8333-333333333333';

/** The key a leaked secret would show up under, whatever it chose to be called. */
const SECRET = 'sk-test-T068-000000000000000000';

function flowContent(overrides: Partial<FlowContent> = {}): FlowContent {
  return {
    title: '中文流程标题',
    direction: 'LR',
    nodes: [
      { id: 'f1', label: '缺水', itemIds: [ITEM_A] },
      { id: 'f2', label: '叶子发黄', itemIds: [ITEM_B] },
    ],
    edges: [
      {
        source: 'f1',
        target: 'f2',
        kind: 'hypothesis',
        label: '推测：缺水可能先于叶子发黄',
        itemIds: [ITEM_A, ITEM_B],
        relationIds: [],
      },
    ],
    ...overrides,
  };
}

function view(overrides: Partial<ViewDTO & { kind: 'flow' }> = {}): ViewDTO & { kind: 'flow' } {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    name: '导出用流程图',
    kind: 'flow',
    selection: { mode: 'explicit', itemIds: [ITEM_A, ITEM_B] },
    sourceSnapshot: {
      items: [
        { id: ITEM_A, rawVersion: 1, revision: 3 },
        { id: ITEM_B, rawVersion: 2, revision: 4 },
      ],
      relations: [],
    },
    contentHash: 'flowhash',
    rendererVersion: 'flow-mermaid-v1',
    promptVersion: 'flow-v1',
    runId: null,
    revision: 1,
    generatedAt: '2026-09-14T08:00:00.000Z',
    createdAt: '2026-09-14T08:00:00.000Z',
    updatedAt: '2026-09-14T08:00:00.000Z',
    isStale: false,
    missingSources: [],
    content: flowContent(),
    ...overrides,
  };
}

function input(overrides: Partial<BuildFlowExportInput> = {}): BuildFlowExportInput {
  return {
    view: view(),
    exportedAt: EXPORTED_AT,
    freshness: {
      isStale: false,
      changedItemCount: 0,
      changedRelationCount: 0,
      missingSourceCount: 0,
      reason: null,
    },
    ...overrides,
  };
}

describe('T068 流程导出', () => {
  it('T068-C01 源码复用：Mermaid 由编译器从 canonical 内容生成，不来自缓存字符串', () => {
    // 视图对象上根本没有"已编译源码"字段可以用；如果实现改为回读某个缓存，
    // 这一条会因为拿到空内容而失败。
    const built = input({
      view: view({
        content: flowContent({
          title: '树里的真实标题',
          nodes: [
            { id: 'f1', label: '真实节点', itemIds: [ITEM_A] },
          ],
          edges: [],
        }),
      }),
    });
    const mermaid = buildFlowMermaid(built);

    // 编译器的输出原样出现在文件里。
    const compiled = compileFlow(built.view.content);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(mermaid).toContain(compiled.compiled.source);
    // 从树里编译出来的标签出现，而不是其它字符串。
    expect(mermaid).toContain('真实节点');
    expect(mermaid.split('\n').at(-2)).toBe('  N0["真实节点"]');

    // 确定性：同一份输入导出两次逐字相等。
    expect(buildFlowMermaid(input())).toBe(buildFlowMermaid(input()));
    // 只有导出版本号被写进文件，版本常量是权威来源。
    expect(mermaid).toContain(FLOW_COMPILER_VERSION);
  });

  it('T068-C02 假设保留：推测边的标记与虚线在 Mermaid 文本里仍然可辨', () => {
    const mermaid = buildFlowMermaid(input());

    // 虚线箭头 + 「推测：」前缀，两者都在文件里 —— 颜色和样式在文本导出中丢失，
    // 所以文字必须自己承载不确定性。
    expect(mermaid).toContain('-.->');
    expect(mermaid).toContain('推测');
    expect(mermaid).not.toContain('-->|"因果');

    // 结构化导出也把推测单列出来，消费者不必自己从 kind 推。
    const parsed = JSON.parse(buildFlowExportJson(input())) as {
      hypotheses: { source: string; target: string; label: string }[];
    };
    expect(parsed.hypotheses).toHaveLength(1);
    expect(parsed.hypotheses[0]).toEqual({
      source: 'f1',
      target: 'f2',
      label: '推测：缺水可能先于叶子发黄',
    });

    // 头部用注释说明有几条推测，且是 Mermaid 注释而不是 Markdown 标题。
    expect(mermaid).toContain('%% 图中有 1 条虚线边是模型标注的推测');
    expect(mermaid.startsWith('%%')).toBe(true);
  });

  it('T068-C02 没有推测时头部如实说明，不留下一个含糊的空白', () => {
    const built = input({
      view: view({
        content: flowContent({
          edges: [
            {
              source: 'f1',
              target: 'f2',
              kind: 'sequence',
              label: '顺序：先甲后乙',
              itemIds: [ITEM_A],
              relationIds: [],
            },
          ],
        }),
      }),
    });
    const mermaid = buildFlowMermaid(built);
    expect(mermaid).toContain('%% 图中没有推测连接。');
    expect(mermaid).not.toContain('-.->');
    const parsed = JSON.parse(buildFlowExportJson(built)) as { hypotheses: unknown[] };
    expect(parsed.hypotheses).toEqual([]);
  });

  it('T068-C04 秘密扫描：两种导出都不含 Key、Authorization 或配置字段', () => {
    const built = input();
    const mermaid = buildFlowMermaid(built);
    const json = buildFlowExportJson(built);

    for (const text of [mermaid, json]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toMatch(/sk-[A-Za-z0-9-]{8,}/u);
      expect(text).not.toMatch(/authorization/iu);
      expect(text).not.toMatch(/bearer\s/iu);
      expect(text).not.toContain('baseUrl');
      expect(text).not.toContain('apiKey');
      expect(text).not.toContain('messages');
    }

    // 逐键白名单：新增字段会让这条失败，而不是静默通过。
    expect(Object.keys(JSON.parse(json)).sort()).toEqual(
      [
        'application',
        'citedRelations',
        'compilerVersion',
        'content',
        'contentHash',
        'exportedAt',
        'freshness',
        'generatedAt',
        'hypotheses',
        'kind',
        'name',
        'promptVersion',
        'restoreScope',
        'schemaVersion',
        'sourceSnapshot',
        'viewId',
      ].sort(),
    );
  });

  it('T068-C03/R03 JSON 含 schemaVersion、kind、sourceSnapshot、content 与关系版本', () => {
    const built = input({
      view: view({
        sourceSnapshot: {
          items: [
            { id: ITEM_A, rawVersion: 1, revision: 3 },
            { id: ITEM_B, rawVersion: 2, revision: 4 },
          ],
          relations: [{ id: RELATION, revision: 7 }],
        },
        content: flowContent({
          edges: [
            {
              source: 'f1',
              target: 'f2',
              kind: 'dependency',
              label: '依赖：乙需要甲先完成',
              itemIds: [ITEM_A, ITEM_B],
              relationIds: [RELATION],
            },
          ],
        }),
      }),
    });
    const parsed = JSON.parse(buildFlowExportJson(built)) as Record<string, unknown>;

    expect(parsed.schemaVersion).toBe(FLOW_EXPORT_SCHEMA_VERSION);
    expect(parsed.kind).toBe('flow');
    expect(parsed.content).toEqual(built.view.content);
    expect(parsed.sourceSnapshot).toEqual(built.view.sourceSnapshot);
    // 引用的关系连同快照里的版本一起出现，导入方才能核对依据。
    expect(parsed.citedRelations).toEqual([{ id: RELATION, revision: 7 }]);
    // 运行请求不导出；promptVersion 是版本标记，不是请求内容。
    expect(parsed).not.toHaveProperty('runId');
    expect(parsed).not.toHaveProperty('selection');
    expect(parsed).not.toHaveProperty('request');
    // Mermaid 文本里也带上了这条关系的版本。
    expect(buildFlowMermaid(built)).toContain(`relation ${RELATION} revision 7`);
  });

  it('T068-C05 未实现格式：SVG 只在浏览器侧产出，服务器格式表里没有它', () => {
    // 客户端可用格式包含 SVG，因为有真实的净化产物。
    expect([...FLOW_EXPORT_FORMATS]).toEqual(['json', 'mermaid', 'svg']);
    expect(isFlowExportFormat('svg')).toBe(true);
    expect(isFlowExportFormat('png')).toBe(false);
    expect(isFlowExportFormat('pdf')).toBe(false);
    expect(isFlowExportFormat('')).toBe(false);

    // 服务器只认两种：SVG 必须来自已净化的渲染结果（T068-R04）。
    expect([...FLOW_SERVER_EXPORT_FORMATS]).toEqual(['json', 'mermaid']);
    expect(isServerFlowExportFormat('json')).toBe(true);
    expect(isServerFlowExportFormat('mermaid')).toBe(true);
    expect(isServerFlowExportFormat('svg')).toBe(false);
    expect(isServerFlowExportFormat('markdown')).toBe(false);

    expect(flowExportContentType('mermaid')).toContain('text/plain');
    expect(flowExportContentType('json')).toContain('application/json');
    expect(flowExportContentType('svg')).toContain('image/svg+xml');
  });

  it('T068-C06 恢复区别：文件自己说明它不是整库备份', () => {
    const parsed = JSON.parse(buildFlowExportJson(input())) as {
      restoreScope: { kind: string; isFullBackup: boolean; note: string };
    };
    expect(parsed.restoreScope.kind).toBe('single-view');
    expect(parsed.restoreScope.isFullBackup).toBe(false);
    // 说明里点出它不含原文，并指向整库导出。
    expect(parsed.restoreScope.note).toContain('不含原文');
    expect(parsed.restoreScope.note).toContain('/api/export');

    // Mermaid 文本同样写清楚来源数量，读者能判断材料范围。
    expect(buildFlowMermaid(input())).toContain('%% 来源：2 条笔记，0 条关系');
  });

  it('T068-R05 文件名只由前缀、视图 id 与日期构成，与标题无关', () => {
    const hostile = '..\\..\\Windows/System32/CON:<>|?*\u202Egnp.exe';
    const built = input({ view: view({ name: hostile }) });

    for (const format of FLOW_EXPORT_FORMATS) {
      const name = flowExportFileName({
        format,
        viewId: built.view.id,
        exportedAt: built.exportedAt,
      });
      expect(name).not.toMatch(/[\\/:*?"<>|]/u);
      expect(name).not.toContain('..');
      expect(name).not.toContain('\u202E');
      const extension = format === 'mermaid' ? 'mmd' : format === 'svg' ? 'svg' : 'json';
      expect(name).toBe(`feini-flow-${built.view.id}-2026-09-15.${extension}`);
    }

    // 标题仍然保留在文件内容里，所以可读性没有损失（比较解析后的值，因为 JSON
    // 字符串里反斜杠与引号会被转义）。
    const parsed = JSON.parse(buildFlowExportJson(built)) as { name: string };
    expect(parsed.name).toBe(hostile);
  });

  it('T068-C01 过期来源被写进两种文件，且不影响导出可读', () => {
    const stale = input({
      freshness: {
        isStale: true,
        changedItemCount: 1,
        changedRelationCount: 0,
        missingSourceCount: 0,
        reason: '1 条笔记已修改',
      },
    });
    const mermaid = buildFlowMermaid(stale);

    // 生成时间与导出时间都要在，且两者不同。
    expect(mermaid).toContain('2026-09-14T08:00:00.000Z');
    expect(mermaid).toContain(EXPORTED_AT);
    expect(mermaid).toContain('依据可能已过期');
    expect(mermaid).toContain('1 条笔记已修改');
    expect(mermaid).toContain('不代表知识库的最新状态');
    // 正文照常完整。
    expect(mermaid).toContain('flowchart LR');

    expect(
      (JSON.parse(buildFlowExportJson(stale)) as { freshness: unknown }).freshness,
    ).toEqual({
      isStale: true,
      changedItemCount: 1,
      changedRelationCount: 0,
      missingSourceCount: 0,
      reason: '1 条笔记已修改',
    });
  });

  it('T068 两次导出只差导出时间', () => {
    const first = buildFlowMermaid(input({ exportedAt: '2026-09-15T04:30:00.000Z' }));
    const second = buildFlowMermaid(input({ exportedAt: '2026-09-16T09:00:00.000Z' }));

    expect(first).not.toBe(second);
    const normalize = (text: string) => text.replace(/^%% 导出时间：.*$/mu, '%% 导出时间：（略）');
    expect(normalize(first)).toBe(normalize(second));

    const jsonFirst = JSON.parse(buildFlowExportJson(input())) as Record<string, unknown>;
    const jsonSecond = JSON.parse(
      buildFlowExportJson(input({ exportedAt: '2026-09-16T09:00:00.000Z' })),
    ) as Record<string, unknown>;
    expect(jsonFirst.content).toEqual(jsonSecond.content);
    expect(jsonFirst.contentHash).toEqual(jsonSecond.contentHash);
    expect(jsonFirst.generatedAt).toBe(jsonSecond.generatedAt);
  });

  it('T068 导出是纯函数：不修改传入的视图对象', () => {
    const source = view();
    const snapshot = JSON.parse(JSON.stringify(source)) as unknown;
    buildFlowMermaid(input({ view: source }));
    buildFlowExportJson(input({ view: source }));
    buildFlowExport(input({ view: source }));
    expect(source).toEqual(snapshot);
  });

  it('T068 内容无法编译时抛错，不产出空图', () => {
    // 悬空端点：编译器拒绝，导出必须跟着拒绝而不是写一个空流程图。
    const broken = input({
      view: view({
        content: flowContent({
          edges: [
            {
              source: 'f1',
              target: 'ghost',
              kind: 'sequence',
              label: '顺序：到不存在的一步',
              itemIds: [ITEM_A],
              relationIds: [],
            },
          ],
        }),
      }),
    });
    expect(() => buildFlowMermaid(broken)).toThrow(/无法编译/u);
    // JSON 导出仍然可用：结构化内容本身是历史记录，不因无法画图而消失。
    expect(() => buildFlowExportJson(broken)).not.toThrow();
  });
});
