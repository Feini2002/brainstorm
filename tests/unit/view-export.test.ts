/**
 * T060 验收：脑图 Markdown 与 JSON 导出。
 *
 * 六个具名场景覆盖：中文编码完整、危险名称得到安全文件名、正文不含秘密、
 * 过期状态被写进文件、同一棵树导出两次只差导出时间、只提供已实现格式。
 *
 * 三条不在规格字面但同样真实的不变量也在这里钉住，因为它们都是"导出悄悄变成
 * 另一种东西"的路径：
 *
 *  - **Markdown 从 canonical 树编译**，不是回读缓存源码。构造一个 `content` 与
 *    任意缓存字符串不一致的输入即可区分两种实现。
 *  - **文件名完全不含标题**。测试故意传含路径分隔符、Windows 保留名与 Unicode
 *    反转字符的标题，断言产出与标题无关。
 *  - **JSON 字段集合是白名单**。逐键断言，而不是只检查"没有 Key"——后者在新增
 *    字段时会静默通过。
 */
import { describe, expect, it } from 'vitest';

import type { MindmapContent, ViewDTO } from '@/domain/knowledge';
import {
  VIEW_EXPORT_FORMATS,
  VIEW_EXPORT_SCHEMA_VERSION,
  buildViewExport,
  buildViewExportJson,
  buildViewMarkdown,
  exportContentType,
  exportFileName,
  isViewExportFormat,
  type BuildViewExportInput,
} from '@/domain/viewExport';

const EXPORTED_AT = '2026-09-15T04:30:00.000Z';

/** The key a leaked secret would show up under, whatever it chose to be called. */
const SECRET = 'sk-test-T060-000000000000000000';

function mindmapContent(overrides: Partial<MindmapContent> = {}): MindmapContent {
  return {
    title: '中文脑图标题',
    nodes: [
      {
        id: 'm1',
        parentId: null,
        label: '中文脑图标题',
        itemIds: ['11111111-1111-4111-8111-111111111111'],
        kind: 'group',
      },
      {
        id: 'm2',
        parentId: 'm1',
        label: '关于「测试」的分支：包含 *星号* 与 `反引号`',
        itemIds: ['11111111-1111-4111-8111-111111111111'],
        kind: 'note',
      },
    ],
    ...overrides,
  };
}

function view(overrides: Partial<ViewDTO & { kind: 'mindmap' }> = {}): ViewDTO & {
  kind: 'mindmap';
} {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    name: '导出用脑图',
    kind: 'mindmap',
    selection: { mode: 'explicit', itemIds: ['11111111-1111-4111-8111-111111111111'] },
    sourceSnapshot: {
      items: [{ id: '11111111-1111-4111-8111-111111111111', rawVersion: 2, revision: 5 }],
      relations: [],
    },
    contentHash: 'abc123',
    rendererVersion: 'mindmap-markmap-v1',
    promptVersion: 'mindmap-v1',
    runId: null,
    revision: 1,
    generatedAt: '2026-09-14T08:00:00.000Z',
    createdAt: '2026-09-14T08:00:00.000Z',
    updatedAt: '2026-09-14T08:00:00.000Z',
    isStale: false,
    missingSources: [],
    content: mindmapContent(),
    ...overrides,
  };
}

function input(overrides: Partial<BuildViewExportInput> = {}): BuildViewExportInput {
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

describe('T060 脑图导出', () => {
  it('T060-C01 中文编码：UTF-8 完整，标签未被转义破坏', () => {
    const markdown = buildViewMarkdown(input());

    // 中文原样出现，且能被 re-encode/decode 往返。
    expect(markdown).toContain('中文脑图标题');
    expect(markdown).toContain('关于「测试」的分支');
    const roundTripped = new TextDecoder('utf-8', { fatal: true }).decode(
      new TextEncoder().encode(markdown),
    );
    expect(roundTripped).toBe(markdown);
    // 没有乱码替换字符。
    expect(markdown).not.toContain('\uFFFD');

    // Markdown 保留字符被转义，因此正文不会被"星号"变成斜体。
    expect(markdown).toContain('\\*星号\\*');
    expect(markdown).toContain('\\`反引号\\`');

    // JSON 同样保住中文。
    const json = buildViewExportJson(input());
    expect(JSON.parse(json).content.title).toBe('中文脑图标题');
  });

  it('T060-C02 危险名称：文件名与标题无关，且不含路径分隔符', () => {
    const hostile = '..\\..\\Windows\\System32/CON:<>|?*\u202Egnp.exe';
    const built = input({ view: view({ name: hostile }) });

    for (const format of VIEW_EXPORT_FORMATS) {
      const name = exportFileName({
        format,
        viewId: built.view.id,
        exportedAt: built.exportedAt,
      });
      // 不含任何路径或系统非法字符。
      expect(name).not.toMatch(/[\\/:*?"<>|]/u);
      expect(name).not.toContain('..');
      // 不含反转字符（可用于伪装扩展名）。
      expect(name).not.toContain('\u202E');
      // 完全不含标题的任何片段 —— 这是"标题不进入路径"最强的形式。
      expect(name).toBe(`feini-mindmap-${built.view.id}-2026-09-15.${format === 'markdown' ? 'md' : 'json'}`);
    }

    // 标题仍然保留在文件**内容**里，所以可读性没有损失。
    expect(buildViewMarkdown(built)).toContain(hostile);
  });

  it('T060-C02 空白与超长标题同样不影响文件名', () => {
    const weird = `  ${'长'.repeat(300)}  `;
    const name = exportFileName({
      format: 'markdown',
      viewId: view().id,
      exportedAt: EXPORTED_AT,
    });
    expect(name).toBe(`feini-mindmap-${view().id}-2026-09-15.md`);
    // 用怪标题导出也不抛错。
    expect(() => buildViewMarkdown(input({ view: view({ name: weird }) }))).not.toThrow();
  });

  it('T060-C03 秘密检查：正文中不出现 Key 或 Authorization 标记', () => {
    // 视图上根本没有承载 Key 的字段，但用两个入口一起验证：一个"看起来像"
    // 泄漏的实现会出现在 JSON 里，另一个会出现在运行请求里。
    const built = input({ view: view({ runId: null }) });
    const json = buildViewExportJson(built);
    const markdown = buildViewMarkdown(built);

    for (const text of [json, markdown]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toMatch(/sk-[A-Za-z0-9-]{8,}/u);
      expect(text).not.toMatch(/authorization/iu);
      expect(text).not.toMatch(/bearer\s/iu);
      expect(text).not.toContain('baseUrl');
      expect(text).not.toContain('apiKey');
    }

    // 逐键白名单：新增字段会让这条失败，而不是静默通过。
    expect(Object.keys(JSON.parse(json)).sort()).toEqual(
      [
        'application',
        'compilerVersion',
        'content',
        'contentHash',
        'exportedAt',
        'freshness',
        'generatedAt',
        'kind',
        'name',
        'promptVersion',
        'schemaVersion',
        'sourceSnapshot',
        'viewId',
      ].sort(),
    );
  });

  it('T060-R02 JSON 保留 schemaVersion / kind / sourceSnapshot / content，且不含运行请求', () => {
    const parsed = JSON.parse(buildViewExportJson(input())) as Record<string, unknown>;

    expect(parsed.schemaVersion).toBe(VIEW_EXPORT_SCHEMA_VERSION);
    expect(parsed.kind).toBe('mindmap');
    expect(parsed.content).toEqual(mindmapContent());
    // 来源版本必须带上，否则导入方无法核对这份导出基于哪一版材料。
    expect(parsed.sourceSnapshot).toEqual({
      items: [{ id: '11111111-1111-4111-8111-111111111111', rawVersion: 2, revision: 5 }],
      relations: [],
    });
    // 运行与提示词**请求**不导出；promptVersion 是版本标记，不是请求内容。
    expect(parsed).not.toHaveProperty('runId');
    expect(parsed).not.toHaveProperty('selection');
    expect(parsed).not.toHaveProperty('messages');
    expect(parsed).not.toHaveProperty('request');
  });

  it('T060-C04 过期标记：文件说明生成时间与过期状态', () => {
    const stale = input({
      freshness: {
        isStale: true,
        changedItemCount: 1,
        changedRelationCount: 0,
        missingSourceCount: 0,
        reason: '1 条笔记已修改',
      },
    });
    const markdown = buildViewMarkdown(stale);

    // 生成时间与导出时间都要在，且两者不同 —— 只写一个会让读者以为文件是刚生成的。
    expect(markdown).toContain('2026-09-14T08:00:00.000Z');
    expect(markdown).toContain(EXPORTED_AT);
    // 明确写出过期，而不是留白让读者以为是"最新整理"。
    expect(markdown).toContain('依据可能已过期');
    expect(markdown).toContain('1 条笔记已修改');
    expect(markdown).toContain('不代表知识库的最新状态');

    // 结构化字段同样带上，供机器判断。
    expect((JSON.parse(buildViewExportJson(stale)) as { freshness: unknown }).freshness).toEqual({
      isStale: true,
      changedItemCount: 1,
      changedRelationCount: 0,
      missingSourceCount: 0,
      reason: '1 条笔记已修改',
    });
  });

  it('T060-C04 来源缺失也被说明，且不影响"这份导出仍然可读"', () => {
    const missing = input({
      freshness: {
        isStale: false,
        changedItemCount: 0,
        changedRelationCount: 0,
        missingSourceCount: 2,
        reason: '2 条来源已删除',
      },
    });
    const markdown = buildViewMarkdown(missing);
    expect(markdown).toContain('2 条来源已删除');
    // 缺来源是历史事实，不是导出失败：正文照常完整。
    expect(markdown).toContain('中文脑图标题');
    expect(markdown).toContain('## 来源清单（1 条）');
  });

  it('T060-C05 可重复编译：两次导出只差导出时间', () => {
    const first = buildViewMarkdown(input({ exportedAt: '2026-09-15T04:30:00.000Z' }));
    const second = buildViewMarkdown(input({ exportedAt: '2026-09-16T09:00:00.000Z' }));

    expect(first).not.toBe(second);
    // 差异只在导出时间那一行：把两行都替换掉后必须逐字相等。
    const normalize = (text: string) => text.replace(/^- 导出时间：.*$/mu, '- 导出时间：（略）');
    expect(normalize(first)).toBe(normalize(second));

    // 同一次调用的两份输出也必须一致（没有掺时间戳或随机数）。
    expect(buildViewMarkdown(input())).toBe(buildViewMarkdown(input()));

    const jsonFirst = JSON.parse(buildViewExportJson(input())) as Record<string, unknown>;
    const jsonSecond = JSON.parse(
      buildViewExportJson(input({ exportedAt: '2026-09-16T09:00:00.000Z' })),
    ) as Record<string, unknown>;
    expect(jsonFirst.content).toEqual(jsonSecond.content);
    expect(jsonFirst.contentHash).toEqual(jsonSecond.contentHash);
    // 内容与生成时间不受导出时间影响。
    expect(jsonFirst.generatedAt).toBe(jsonSecond.generatedAt);
  });

  it('T060-R01 Markdown 从 canonical 树编译，不回读可能被污染的缓存', () => {
    // 树里是"编译后的正确答案"，而视图对象上没有任何"已编译源码"字段可用。
    // 如果实现改为读取缓存字符串，这一条会失败。
    const built = input({
      view: view({
        content: mindmapContent({
          title: '树里的真实标题',
          nodes: [
            {
              id: 'm1',
              parentId: null,
              label: '树里的真实标题',
              itemIds: ['11111111-1111-4111-8111-111111111111'],
              kind: 'group',
            },
          ],
        }),
      }),
    });
    const markdown = buildViewMarkdown(built);
    // 从树编译出的标题出现，且带 `# ` 标题与 Markdown 正文结构。
    expect(markdown).toContain('树里的真实标题');
    expect(markdown.split('\n')[0]).toBe('# 树里的真实标题');
  });

  it('T060-C06 无额外格式：只承认已实现的两种，拒绝 pdf 等', () => {
    expect([...VIEW_EXPORT_FORMATS]).toEqual(['markdown', 'json']);
    expect(isViewExportFormat('markdown')).toBe(true);
    expect(isViewExportFormat('json')).toBe(true);
    // 未实现的格式必须是明确的"不认识"，而不是悄悄退回某个默认值。
    expect(isViewExportFormat('pdf')).toBe(false);
    expect(isViewExportFormat('svg')).toBe(false);
    expect(isViewExportFormat('png')).toBe(false);
    expect(isViewExportFormat('')).toBe(false);

    expect(exportContentType('markdown')).toContain('text/markdown');
    expect(exportContentType('json')).toContain('application/json');
  });

  it('T060 导出是纯函数：不修改传入的视图对象', () => {
    const source = view();
    const snapshot = JSON.parse(JSON.stringify(source)) as unknown;
    buildViewMarkdown(input({ view: source }));
    buildViewExportJson(input({ view: source }));
    // 深比较：导出不应把 exportedAt 之类写回视图。
    expect(source).toEqual(snapshot);
  });

  it('T060 来源清单列出每个来源的版本，空来源如实说明', () => {
    const withSources = buildViewMarkdown(input());
    expect(withSources).toContain('## 来源清单（1 条）');
    expect(withSources).toContain('11111111-1111-4111-8111-111111111111');
    expect(withSources).toContain('原文 v2 · revision 5');

    const empty = buildViewMarkdown(
      input({
        view: view({ sourceSnapshot: { items: [], relations: [] } }),
      }),
    );
    expect(empty).toContain('## 来源清单（0 条）');
    // 空来源不静默省略整段，否则读者无法区分"没有来源"和"忘了写"。
    expect(empty).toContain('（没有记录来源。）');
  });

  it('T060 buildViewExport 只使用白名单字段，不整体展开视图对象', () => {
    const exported = buildViewExport(input());
    expect(Object.keys(exported).sort()).toEqual(
      [
        'application',
        'compilerVersion',
        'content',
        'contentHash',
        'exportedAt',
        'freshness',
        'generatedAt',
        'kind',
        'name',
        'promptVersion',
        'schemaVersion',
        'sourceSnapshot',
        'viewId',
      ].sort(),
    );
    // 运行标识、选择描述与时间戳族里的内部字段都不在导出里。
    expect(exported).not.toHaveProperty('runId');
    expect(exported).not.toHaveProperty('selection');
    expect(exported).not.toHaveProperty('revision');
    expect(exported).not.toHaveProperty('isStale');
  });
});
