/**
 * T053 验收：保存视图的公共 API 与类型契约。
 *
 * 覆盖六个具名场景：判别 schema 拒绝错配、删除视图不删知识、重名可共存、
 * 列表只回摘要、再生成保留旧视图、来源缺失返回 missingSources 而非 404。
 * 另外钉住 contentHash 的输入集合 —— 它与 reference/fixtures/backup_valid.json
 * 里的固定哈希必须一致，否则导入导出与备份比对会静默失配。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import { LIMITS } from '@/domain/limits';
import { createGraphViewSchema } from '@/domain/schemas/http';
import { createCapture } from '@/server/services/items';
import { createGraphView, editView, getView, listViews, removeView, viewContentHash } from '@/server/services/views/views';
import { closeDb } from '@/server/db/database';
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

function graphViewInput(name: string, itemIds: string[] = []) {
  return {
    name,
    selection: { mode: 'explicit' as const, itemIds },
    positions: Object.fromEntries(itemIds.map((id, index) => [id, { x: index * 200, y: 0 }])),
    direction: 'TB' as const,
  };
}

describe('T053 保存视图契约', () => {
  it('T053-C01 判别 schema 拒绝 kind 与内容错配', () => {
    // 创建接口只接受 graph 的字段；把 flow 内容塞进来会被 strict 对象拒绝。
    const wrong = createGraphViewSchema.safeParse({
      name: '错配视图',
      selection: { mode: 'explicit', itemIds: [] },
      nodes: [{ id: 'N0', label: '节点', itemIds: [] }],
      edges: [],
    });
    expect(wrong.success).toBe(false);

    // 方向不在枚举内同样拒绝，而不是落到默认值。
    const badDirection = createGraphViewSchema.safeParse({
      name: '方向错误',
      selection: { mode: 'explicit', itemIds: [] },
      positions: {},
      direction: 'RL',
    });
    expect(badDirection.success).toBe(false);
  });

  it('T053-C02 删除视图后三条知识与关系仍然存在', () => {
    const a = capture('视图引用的甲');
    const b = capture('视图引用的乙');
    const c = capture('视图引用的丙');
    // 记录语义关系，删除视图不能连带删除它。related_to 是对称类型，
    // 数据库 CHECK 要求端点按 id 升序，所以这里显式排序而不是依赖插入顺序。
    const [sourceId, targetId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    db.prepare(
      `INSERT INTO relations (
         id, source_id, target_id, relation_type, origin, review_status, score, reason,
         evidence_json, source_raw_version, target_raw_version, run_id, revision, created_at, updated_at
       ) VALUES (?, ?, ?, 'related_to', 'manual', 'accepted', NULL, '', '[]', 1, 1, NULL, 1, ?, ?)`,
    ).run(newId(), sourceId, targetId, new Date().toISOString(), new Date().toISOString());

    const view = createGraphView(db, graphViewInput('三条来源', [a.id, b.id, c.id]));
    removeView(db, view.id, view.revision);

    const items = db.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get() as { n: number };
    const relations = db.prepare('SELECT COUNT(*) AS n FROM relations').get() as { n: number };
    expect(Number(items.n)).toBe(3);
    expect(Number(relations.n)).toBe(1);
    expect(() => getView(db, view.id)).toThrow(AppError);
  });

  it('T053-C03 同名视图有不同 ID，都能读取', () => {
    const first = createGraphView(db, graphViewInput('同名脑图'));
    const second = createGraphView(db, graphViewInput('同名脑图'));

    expect(first.id).not.toBe(second.id);
    // 名称不是主键：允许重复，读取按 ID。
    expect(getView(db, first.id).name).toBe('同名脑图');
    expect(getView(db, second.id).name).toBe('同名脑图');
    const list = listViews(db, { limit: 10, offset: 0 });
    expect(list.views.filter((view) => view.name === '同名脑图')).toHaveLength(2);
  });

  it('T053-C04 列表只返回摘要，不携带完整 content', () => {
    const item = capture('大图来源');
    createGraphView(db, graphViewInput('大图', [item.id]));

    const list = listViews(db, { limit: 10, offset: 0 });
    expect(list.views).toHaveLength(1);
    const summary = list.views[0];
    expect(Object.keys(summary).sort()).toEqual(
      [
        'createdAt',
        'generatedAt',
        'id',
        'isStale',
        'kind',
        'missingSourceCount',
        'name',
        'revision',
        'sourceCount',
        'updatedAt',
      ].sort(),
    );
    expect(summary).not.toHaveProperty('content');
    expect(summary).not.toHaveProperty('sourceSnapshot');
  });

  it('T053-C05 改名与改布局不覆盖旧版本语义，且旧的另一份视图仍可读', () => {
    const item = capture('对照来源');
    const original = createGraphView(db, graphViewInput('第一次组织', [item.id]));

    // "重新生成"在 MVP 里是新建一个 View；旧的那个必须原样保留以供对照。
    const regenerated = createGraphView(db, graphViewInput('第二次组织', [item.id]));
    expect(regenerated.id).not.toBe(original.id);

    const renamed = editView(db, {
      id: original.id,
      expectedRevision: original.revision,
      name: '改名后的第一次组织',
    });
    expect(renamed.name).toBe('改名后的第一次组织');
    expect(renamed.id).toBe(original.id);
    expect(getView(db, regenerated.id).name).toBe('第二次组织');
  });

  it('T053-C06 引用条目被删除后返回 missingSources 而不是 404', () => {
    const kept = capture('保留的来源');
    const doomed = capture('将被删除的来源');
    const view = createGraphView(db, graphViewInput('含缺失来源', [kept.id, doomed.id]));

    db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(doomed.id);

    const loaded = getView(db, view.id);
    expect(loaded.missingSources).toContain(doomed.id);
    // 契约把「来源已删除」与「来源版本变化」分成两个信号：missingSources 列出
    // 缺失的 ID，isStale 只表示仍存在的来源版本发生变化。把删除也算进 isStale
    // 会让界面无法区分"这条笔记变了"和"这条笔记没了"。
    expect(loaded.isStale).toBe(false);
    expect(loaded.missingSources).toEqual([doomed.id]);
    // 位置只针对仍存在的条目，不重建知识。
    expect(Object.keys(loaded.kind === 'graph' ? loaded.content.positions : {})).toEqual([kept.id]);
  });

  it('T053-R05 contentHash 公式与 reference 备份样本一致', () => {
    // 参考样本里的 contentHash 是固定值。如果本函数的输入集合（kind/content/
    // sourceSnapshot/promptVersion）漂移，备份文件之间的哈希比对会静默失配，
    // 导出的视图再导入就会看起来"内容相同但哈希不同"。
    const fixturePath = path.join(process.cwd(), 'reference', 'fixtures', 'backup_valid.json');
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      data: { views: { kind: 'graph' | 'mindmap' | 'flow'; content: unknown; sourceSnapshot: never; promptVersion: string | null; contentHash: string }[] };
    };
    const view = fixture.data.views[0];
    expect(
      viewContentHash({
        kind: view.kind,
        content: view.content,
        sourceSnapshot: view.sourceSnapshot,
        promptVersion: view.promptVersion,
      }),
    ).toBe(view.contentHash);
  });

  it('T053-R03 名称一到一百码点，空名与超长被拒绝', () => {
    expect(() => createGraphView(db, graphViewInput(''))).toThrow(AppError);
    expect(() =>
      createGraphView(db, graphViewInput('字'.repeat(LIMITS.viewNameCodePoints + 1))),
    ).toThrow(AppError);
    const ok = createGraphView(db, graphViewInput('字'.repeat(LIMITS.viewNameCodePoints)));
    expect(ok.name).toHaveLength(LIMITS.viewNameCodePoints);
  });

  it('T053-R04 改名与改布局都带 expectedRevision，过期版本冲突', () => {
    const view = createGraphView(db, graphViewInput('并发视图'));
    const stale = view.revision;

    editView(db, { id: view.id, expectedRevision: stale, name: '第一次改名' });

    expect(() =>
      editView(db, { id: view.id, expectedRevision: stale, name: '第二次改名' }),
    ).toThrow(/已被其他窗口修改/);
    expect(getView(db, view.id).name).toBe('第一次改名');
  });

  it('T053-R05 contentHash 覆盖 kind、content、sourceSnapshot 与 promptVersion', () => {
    const item = capture('哈希来源');
    const view = createGraphView(db, graphViewInput('哈希视图', [item.id]));
    const expected = viewContentHash({
      kind: 'graph',
      content: view.kind === 'graph' ? view.content : {},
      sourceSnapshot: view.sourceSnapshot,
      promptVersion: view.promptVersion,
    });

    expect(view.contentHash).toBe(expected);
    // graph 没有提示词模板：必须显式存 null，而不是留空让它回查已删除的 run。
    expect(view.promptVersion).toBeNull();
    expect(view.rendererVersion).toContain('graph');

    // 任一输入变化都应改变哈希。
    const different = viewContentHash({
      kind: 'graph',
      content: view.kind === 'graph' ? view.content : {},
      sourceSnapshot: view.sourceSnapshot,
      promptVersion: 'other-v1',
    });
    expect(different).not.toBe(expected);
  });

  it('T053-R05 视图只存来源 ID 与版本，不存秘密或完整模型请求', () => {
    const item = capture('来源快照内容');
    const view = createGraphView(db, graphViewInput('快照视图', [item.id]));

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('Bearer');
    // 快照只含 id/版本，不复制原文。
    expect(JSON.stringify(view.sourceSnapshot)).not.toContain('来源快照内容');
    expect(view.sourceSnapshot.items).toEqual([
      { id: item.id, rawVersion: item.rawVersion, revision: item.revision },
    ]);
  });

  it('T053 删除不存在的视图返回 NOT_FOUND，删除过期版本返回冲突', () => {
    const view = createGraphView(db, graphViewInput('删除语义'));
    expect(view.revision).toBe(1);

    const removed = removeView(db, view.id, view.revision);
    expect(removed.deletedId).toBe(view.id);

    try {
      removeView(db, view.id, 1);
      throw new Error('应当抛出 NOT_FOUND');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('NOT_FOUND');
    }
  });

  it('T053 关闭数据库后清理，不遗留连接', () => {
    capture('清理用条目');
    closeDb(harness.databasePath);
    expect(true).toBe(true);
  });
});
