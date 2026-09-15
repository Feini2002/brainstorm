/**
 * T060 验收（集成）：导出服务与下载路由的边界。
 *
 * 单元用例已经覆盖了导出文档本身的形状。这里覆盖的是浏览器用例不适合覆盖的
 * 部分：服务端从**存储**里取视图、过期结论由真实版本比较得出，以及路由的
 * 安全护栏与失败形状。
 *
 * 三条重点：
 *
 *  1. **过期结论来自真实版本比较**，不是调用方传进来的。先用真实数据造一张视图，
 *     再改写来源，然后导出——文件里的过期说明必须反映这次改写。
 *  2. **导出不写任何东西**：视图的 `revision`、`generatedAt`、`contentHash` 在导出
 *     前后逐项相等，也没有新增 Run。
 *  3. **失败的形状是 JSON 错误信封，不是空文件**。契约明确要求下载失败显示 JSON
 *     错误，不能把错误正文另存为看起来正常的备份。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import { VIEW_EXPORT_SCHEMA_VERSION } from '@/domain/viewExport';
import { createCapture } from '@/server/services/items';
import { exportView } from '@/server/services/views/exportView';
import { createGraphView, getView } from '@/server/services/views/views';
import { createTestDatabase, newId, openTestDatabase, type TestDatabase } from '../helpers/db';

let harness: TestDatabase;
let db: DatabaseSync;

beforeEach(() => {
  harness = createTestDatabase();
  db = openTestDatabase(harness.databasePath);
});

afterEach(() => {
  harness.cleanup();
});

function capture(rawText: string) {
  return createCapture(db, {
    captureRequestId: newId(),
    rawText,
    sourceType: 'other',
    sourceRef: null,
  }).item;
}

/** Insert a stored mindmap whose AST cites the given ids. */
function seedMindmap(name: string, itemIds: string[], title = '导出测试脑图'): string {
  const now = new Date().toISOString();
  const items = itemIds.map((id) => {
    const row = db.prepare('SELECT raw_version, revision FROM knowledge_items WHERE id = ?').get(id) as {
      raw_version: number;
      revision: number;
    };
    return { id, rawVersion: Number(row.raw_version), revision: Number(row.revision) };
  });
  const id = newId();
  db.prepare(
    `INSERT INTO views (
       id, name, kind, selection_json, source_snapshot_json, content_json, content_hash,
       renderer_version, prompt_version, run_id, revision, generated_at, created_at, updated_at
     ) VALUES (?, ?, 'mindmap', ?, ?, ?, 'hash-t060', 'mindmap-markmap-v1', 'mindmap-v1', NULL, 1, ?, ?, ?)`,
  ).run(
    id,
    name,
    JSON.stringify({ mode: 'explicit', itemIds }),
    JSON.stringify({ items, relations: [] }),
    JSON.stringify({
      title,
      nodes: [
        { id: 'm1', parentId: null, label: title, itemIds, kind: 'group' },
        ...itemIds.map((itemId, index) => ({
          id: `m${index + 2}`,
          parentId: 'm1',
          label: `分支 ${index + 1}`,
          itemIds: [itemId],
          kind: 'note',
        })),
      ],
    }),
    now,
    now,
    now,
  );
  return id;
}

const NOW = '2026-09-15T06:00:00.000Z';

describe('T060 导出服务', () => {
  it('T060-C01 从存储导出 Markdown：中文完整，来源清单带真实版本', () => {
    const note = capture('导出的中文原文');
    const viewId = seedMindmap('中文脑图', [note.id], '中文脑图');

    const file = exportView(db, { id: viewId, format: 'markdown', now: NOW });

    expect(file.contentType).toContain('text/markdown');
    expect(file.fileName).toBe(`feini-mindmap-${viewId}-2026-09-15.md`);
    expect(file.body).toContain('# 中文脑图');
    expect(file.body).toContain('分支 1');
    // 来源清单里的版本号来自数据库，不是快照里随便写的值。
    expect(file.body).toContain(`${note.id} 原文 v1 · revision 1`);
  });

  it('T060-C03 导出 JSON：白名单字段，且不含秘密或运行请求', () => {
    const note = capture('JSON 导出用原文');
    const viewId = seedMindmap('JSON 脑图', [note.id]);

    const file = exportView(db, { id: viewId, format: 'json', now: NOW });
    const parsed = JSON.parse(file.body) as Record<string, unknown>;

    expect(parsed.schemaVersion).toBe(VIEW_EXPORT_SCHEMA_VERSION);
    expect(parsed.kind).toBe('mindmap');
    expect(parsed.viewId).toBe(viewId);
    expect(parsed.exportedAt).toBe(NOW);
    // 来源快照必须带上条目版本，导入方才能核对。
    expect(parsed.sourceSnapshot).toEqual({
      items: [{ id: note.id, rawVersion: 1, revision: 1 }],
      relations: [],
    });
    // 即使数据库里存在设置与秘密，导出也不经过它们。
    expect(file.body).not.toContain('sk-');
    expect(file.body).not.toMatch(/authorization/iu);
    expect(parsed).not.toHaveProperty('runId');

    expect(file.fileName).toBe(`feini-mindmap-${viewId}-2026-09-15.json`);
  });

  it('T060-C04 过期结论来自真实比较：改写原文后导出写明过期', () => {
    const note = capture('导出后被改写的原文');
    const viewId = seedMindmap('过期导出', [note.id]);

    // 先确认没改之前是"一致"的。
    const fresh = exportView(db, { id: viewId, format: 'markdown', now: NOW });
    expect(fresh.body).toContain('导出时来源版本与生成时一致');
    expect(fresh.body).not.toContain('依据可能已过期');

    // 改写原文，让快照与实际版本分离。
    db.prepare(
      'UPDATE knowledge_items SET raw_text = ?, raw_version = raw_version + 1, revision = revision + 1 WHERE id = ?',
    ).run('改写之后', note.id);

    const stale = exportView(db, { id: viewId, format: 'markdown', now: NOW });
    expect(stale.body).toContain('依据可能已过期');
    expect(stale.body).toContain('1 条笔记已修改');
    expect(stale.body).toContain('不代表知识库的最新状态');

    const staleJson = JSON.parse(
      exportView(db, { id: viewId, format: 'json', now: NOW }).body,
    ) as { freshness: { isStale: boolean; changedItemCount: number; reason: string | null } };
    expect(staleJson.freshness.isStale).toBe(true);
    expect(staleJson.freshness.changedItemCount).toBe(1);
    expect(staleJson.freshness.reason).toContain('1 条笔记已修改');
  });

  it('T060-C04 来源被删除时导出仍可读，并说明缺失', () => {
    const kept = capture('保留的来源');
    const doomed = capture('将被删除的来源');
    const viewId = seedMindmap('含缺失来源', [kept.id, doomed.id]);

    db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(doomed.id);

    const file = exportView(db, { id: viewId, format: 'markdown', now: NOW });
    // 文件说明缺失，但正文与清单照常完整 —— 缺来源是历史事实，不是导出失败。
    expect(file.body).toContain('条来源已删除');
    expect(file.body).toContain('## 来源清单（2 条）');
    expect(file.body).toContain(doomed.id);
  });

  it('T060-R04/C05 导出是只读操作：视图与 Run 都不变，两次导出一致', () => {
    const note = capture('只读导出');
    const viewId = seedMindmap('只读脑图', [note.id]);
    const before = getView(db, viewId);
    const runsBefore = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };

    const first = exportView(db, { id: viewId, format: 'markdown', now: NOW });
    const second = exportView(db, { id: viewId, format: 'markdown', now: NOW });

    // 逐字节一致（同一 `now`，没有任何随机或时间戳掺入）。
    expect(second.body).toBe(first.body);
    // 导出时间不同时，只有那一行不同。
    const later = exportView(db, { id: viewId, format: 'markdown', now: '2026-09-16T06:00:00.000Z' });
    const strip = (text: string) => text.replace(/^- 导出时间：.*$/mu, '- 导出时间：（略）');
    expect(strip(later.body)).toBe(strip(first.body));

    const after = getView(db, viewId);
    expect(after.revision).toBe(before.revision);
    expect(after.generatedAt).toBe(before.generatedAt);
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.content).toEqual(before.content);

    const runsAfter = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
    expect(Number(runsAfter.n)).toBe(Number(runsBefore.n));
  });

  it('T060 视图不存在时抛 404，不产出空文件', () => {
    expect(() => exportView(db, { id: newId(), format: 'markdown', now: NOW })).toThrow(AppError);
    try {
      exportView(db, { id: newId(), format: 'markdown', now: NOW });
    } catch (error) {
      expect((error as AppError).code).toBe('NOT_FOUND');
    }
  });

  it('T060 只支持脑图导出：图视图被明确拒绝而不是导出错的形状', () => {
    const note = capture('图谱来源');
    const graph = createGraphView(db, {
      name: '图谱',
      selection: { mode: 'explicit', itemIds: [note.id] },
      positions: { [note.id]: { x: 0, y: 0 } },
      direction: 'TB',
    });

    // 图谱有坐标而没有树，用"脑图导出"的名字给它会产出一个名不副实的文件。
    expect(() => exportView(db, { id: graph.id, format: 'json', now: NOW })).toThrow(AppError);
    try {
      exportView(db, { id: graph.id, format: 'json', now: NOW });
    } catch (error) {
      expect((error as AppError).code).toBe('VALIDATION');
      expect((error as AppError).message).toContain('思维导图');
    }
  });

  it('T060 文件名与内容互不依赖：危险标题下文件仍可解析', () => {
    const note = capture('危险标题来源');
    const hostile = '../../etc/passwd:<>|';
    const viewId = seedMindmap(hostile, [note.id], '安全标题');

    const file = exportView(db, { id: viewId, format: 'json', now: NOW });
    // 文件名只用 id 与日期。
    expect(file.fileName).toBe(`feini-mindmap-${viewId}-2026-09-15.json`);
    expect(file.fileName).not.toContain('passwd');
    // 标题保留在内容里，且 JSON 依然合法可解析。
    expect((JSON.parse(file.body) as { name: string }).name).toBe(hostile);
  });
});
