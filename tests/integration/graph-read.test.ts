/**
 * T043 / T051 验收：图谱读取范围与关系依据新鲜度。
 *
 * 驱动真实 SQLite（隔离目录）与服务层，覆盖六个具名场景：
 * 孤立知识、拒绝关系、端点过滤、人工评分、超限提示、过期边；
 * 另加一条针对标签筛选的真实回归 —— 标签成员关系存在 item_tags 表，
 * 不是 ItemDTO.tags（那是标签文本），用 UUID 去比标签文本永远为假，
 * 曾导致带标签筛选的图静默变空。
 *
 * 不调用任何模型，不触碰用户 .data。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { LIMITS } from '@/domain/limits';
import { normalizeEndpoints } from '@/domain/relation';
import type { RelationType } from '@/domain/knowledge';
import { getDatasetRevision } from '@/server/db/database';
import { getGraphData } from '@/server/services/getGraphData';
import { createCapture } from '@/server/services/items';
import { insertRelation } from '@/server/repositories/relations';
import { ensureTag, setItemTags } from '@/server/repositories/tags';
import { patchItem } from '@/server/services/items';
import type { ItemDTO } from '@/domain/knowledge';
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

function capture(rawText: string): ItemDTO {
  return createCapture(db, {
    captureRequestId: newId(),
    rawText,
    sourceType: 'other',
    sourceRef: null,
  }).item;
}

/** Current rawVersion of an item as stored, so a link can be recorded "fresh". */
function rawVersionOf(id: string): number {
  const row = db.prepare('SELECT raw_version FROM knowledge_items WHERE id = ?').get(id) as {
    raw_version: number;
  };
  return Number(row.raw_version);
}


interface LinkOptions {
  origin?: 'ai' | 'manual';
  reviewStatus?: 'suggested' | 'accepted' | 'rejected';
  score?: number | null;
}

/**
 * Insert a relation recorded against the endpoints' *current* raw texts.
 *
 * Endpoints are normalized first so the recorded versions line up with the row
 * that is actually written — a symmetric type can swap source and target, and
 * recording versions against the pre-swap order would make the edge look stale
 * immediately for no real reason.
 */
function link(a: ItemDTO, b: ItemDTO, type: RelationType, options: LinkOptions = {}): string {
  const endpoints = normalizeEndpoints(a.id, b.id, type);
  const id = newId();
  const now = new Date().toISOString();
  insertRelation(db, {
    id,
    sourceId: endpoints.sourceId,
    targetId: endpoints.targetId,
    type,
    origin: options.origin ?? 'ai',
    reviewStatus: options.reviewStatus ?? 'accepted',
    score: options.score === undefined ? (options.origin === 'manual' ? null : 0.9) : options.score,
    reason: '测试理由',
    evidence: [],
    sourceRawVersion: rawVersionOf(endpoints.sourceId),
    targetRawVersion: rawVersionOf(endpoints.targetId),
    runId: null,
    now,
  });
  return id;
}

function readGraph(filter = {}, itemIds?: string[]) {
  return getGraphData(
    db,
    { filter, ...(itemIds ? { itemIds } : {}) },
    getDatasetRevision(db),
  );
}

describe('T043 图谱读取范围', () => {
  it('T043-C01 十条孤立知识返回十节点零边，且不视为失败', () => {
    const items = Array.from({ length: 10 }, (_, index) => capture(`孤立知识 ${index}`));

    const graph = readGraph();

    expect(graph.nodes).toHaveLength(10);
    expect(graph.edges).toHaveLength(0);
    expect(graph.scope.matchedNodeCount).toBe(10);
    expect(graph.scope.matchedEdgeCount).toBe(0);
    expect(graph.scope.truncated).toBe(false);
    // 零边不是错误：节点仍然完整，顺序稳定可复现。
    expect(graph.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(items.map((item) => item.id)),
    );
    expect(graph.nodes[0].degree).toBe(0);
  });

  it('T043-C02 默认不含 rejected 边，但两端节点保留', () => {
    const a = capture('拒绝关系的甲');
    const b = capture('拒绝关系的乙');
    const rejectedId = link(a, b, 'related_to', { reviewStatus: 'rejected' });
    const acceptedId = link(a, b, 'supports', { reviewStatus: 'accepted' });

    const graph = readGraph();

    const edgeIds = graph.edges.map((edge) => edge.id);
    expect(edgeIds).not.toContain(rejectedId);
    expect(edgeIds).toContain(acceptedId);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual([a.id, b.id].sort());
    // 拒绝在视图上生效：该边不出现在任何返回结构中。
    expect(graph.freshness.byRelationId[rejectedId]).toBeDefined();
  });

  it('T043-C03 标签筛选只保留一端时不返回该边', () => {
    const a = capture('端点过滤的甲');
    const b = capture('端点过滤的乙');
    link(a, b, 'related_to');

    const tagId = ensureTag(db, '只贴甲', new Date().toISOString());
    setItemTags(db, a.id, ['只贴甲'], new Date().toISOString());

    const graph = readGraph({ tagId });

    expect(graph.nodes.map((node) => node.id)).toEqual([a.id]);
    expect(graph.edges).toHaveLength(0);
    expect(graph.scope.matchedNodeCount).toBe(1);
  });

  it('T043-C03 回归：标签筛选返回真正的标签成员（UUID 不与标签文本比较）', () => {
    const tagged = capture('带标签的笔记');
    const other = capture('没有该标签的笔记');
    const now = new Date().toISOString();
    const tagId = ensureTag(db, '回归标签', now);
    setItemTags(db, tagged.id, ['回归标签'], now);

    const graph = readGraph({ tagId });

    // 修复前此处为 0：filter.tagId 与 ItemDTO.tags（标签文本）比较恒为假。
    expect(graph.nodes.map((node) => node.id)).toEqual([tagged.id]);
    expect(graph.nodes.map((node) => node.id)).not.toContain(other.id);
    expect(graph.nodes[0].tags).toEqual(['回归标签']);
  });

  it('T043-C04 最小评分只过滤 AI 边，人工 accepted 边不被误删', () => {
    const a = capture('人工评分的甲');
    const b = capture('人工评分的乙');
    const manualId = link(a, b, 'related_to', {
      origin: 'manual',
      reviewStatus: 'accepted',
      score: null,
    });
    const lowAiId = link(a, b, 'supports', { origin: 'ai', score: 0.2 });

    const graph = readGraph({ minimumScore: 0.8 });

    const edgeIds = graph.edges.map((edge) => edge.id);
    expect(edgeIds).toContain(manualId);
    expect(edgeIds).not.toContain(lowAiId);
    // null 不是零分：人工边的 score 必须原样保留为 null。
    const manual = graph.edges.find((edge) => edge.id === manualId);
    expect(manual?.score).toBeNull();
  });

  it('T043-C05 超过节点预算时给出真实总量与截断标记', () => {
    const over = LIMITS.graphNodes + 5;
    for (let index = 0; index < over; index += 1) capture(`超限节点 ${index}`);

    const graph = readGraph();

    expect(graph.scope.shownNodeCount).toBe(LIMITS.graphNodes);
    expect(graph.scope.matchedNodeCount).toBe(over);
    expect(graph.scope.truncated).toBe(true);
    // 不是"悄悄截断后称全量"：匹配总量大于实际显示量。
    expect(graph.scope.matchedNodeCount).toBeGreaterThan(graph.scope.shownNodeCount);
  });

  it('T043-C06 过期边默认不参与，可切换查看并标记为依据已变化', () => {
    const a = capture('过期依据的甲');
    const b = capture('过期依据的乙');
    const edgeId = link(a, b, 'related_to');

    // 修改一端原文：rawVersion 前移，记录的端点版本不再匹配。
    patchItem(db, {
      id: a.id,
      expectedRevision: a.revision,
      patch: { rawText: '过期依据的甲（已改写，语义可能变化）' },
    });

    const defaultGraph = readGraph();
    expect(defaultGraph.edges.map((edge) => edge.id)).not.toContain(edgeId);
    expect(defaultGraph.freshness.byRelationId[edgeId]).toBe('stale');
    expect(defaultGraph.freshness.notice).toContain('依据已变化');

    const withStale = readGraph({ includeStale: true });
    const staleEdge = withStale.edges.find((edge) => edge.id === edgeId);
    expect(staleEdge).toBeDefined();
    expect(staleEdge?.isStale).toBe(true);
  });

  it('T043-R06 响应携带 datasetRevision，且图层位置不来自 Item 字段', () => {
    capture('版本快照的笔记');
    const graph = readGraph();

    expect(graph.datasetRevision).toBe(getDatasetRevision(db));
    // GraphNode 只有展示字段，没有可写回 Item 的坐标；坐标只来自 View。
    expect(Object.keys(graph.nodes[0]).sort()).toEqual(
      [
        'degree',
        'hasSavedPosition',
        'id',
        'isStructured',
        'label',
        'rawVersion',
        'revision',
        'status',
        'summary',
        'tags',
        'type',
      ].sort(),
    );
    expect(graph.nodes[0].hasSavedPosition).toBe(false);
  });

  it('T043-R04 只显示建议时仍按审核状态过滤，不混入 accepted', () => {
    const a = capture('状态筛选的甲');
    const b = capture('状态筛选的乙');
    const suggestedId = link(a, b, 'related_to', { reviewStatus: 'suggested' });
    const acceptedId = link(a, b, 'supports', { reviewStatus: 'accepted' });

    const graph = readGraph({ reviewStatuses: ['suggested'] });

    const edgeIds = graph.edges.map((edge) => edge.id);
    expect(edgeIds).toEqual([suggestedId]);
    expect(edgeIds).not.toContain(acceptedId);
    // suggested 边带待确认标记，不能只靠颜色区分。
    expect(graph.edges[0].label).toContain('待确认');
  });

  it('T043-R05 显式选择范围之外的边与节点都不返回', () => {
    const a = capture('选择范围的甲');
    const b = capture('选择范围的乙');
    const c = capture('选择范围的丙');
    link(a, b, 'related_to');
    link(b, c, 'supports');

    const graph = readGraph({}, [a.id, b.id]);

    expect(graph.nodes.map((node) => node.id).sort()).toEqual([a.id, b.id].sort());
    expect(graph.scope.matchedEdgeCount).toBe(1);
    expect(graph.edges.every((edge) => edge.sourceId !== c.id && edge.targetId !== c.id)).toBe(true);
  });
});

describe('T051 关系依据新鲜度', () => {
  it('T051-C01 只改标题不使关系依据失效（比较 rawVersion 而非时间戳）', () => {
    const a = capture('只改标题的甲');
    const b = capture('只改标题的乙');
    const edgeId = link(a, b, 'related_to');

    patchItem(db, {
      id: a.id,
      expectedRevision: a.revision,
      patch: { title: '换了新标题' },
    });

    const graph = readGraph();

    expect(graph.freshness.byRelationId[edgeId]).toBe('fresh');
    expect(graph.freshness.staleCount).toBe(0);
    expect(graph.freshness.notice).toBeNull();
    expect(graph.edges.map((edge) => edge.id)).toContain(edgeId);
  });

  it('T051-R04 人工边同样显示原文版本变化', () => {
    const a = capture('人工过期的甲');
    const b = capture('人工过期的乙');
    const manualId = link(a, b, 'related_to', { origin: 'manual', score: null });

    patchItem(db, {
      id: b.id,
      expectedRevision: b.revision,
      patch: { rawText: '人工过期的乙（已改写）' },
    });

    const graph = readGraph({ includeStale: true });

    expect(graph.freshness.byRelationId[manualId]).toBe('stale');
    expect(graph.freshness.staleCount).toBe(1);
  });

  it('T051-R05 删除端点只影响相关边，其它节点与边保留', () => {
    const a = capture('删除影响的甲');
    const b = capture('删除影响的乙');
    const c = capture('保留的丙');
    const doomedId = link(a, b, 'related_to');
    const survivingId = link(b, c, 'related_to');

    db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(c.id === survivingId ? a.id : a.id);

    const graph = readGraph();

    expect(graph.nodes.map((node) => node.id).sort()).toEqual([b.id, c.id].sort());
    expect(graph.edges.map((edge) => edge.id)).toEqual([survivingId]);
    // 端点缺失与"原文变化"是两种不同状态，必须能区分。
    expect(graph.freshness.byRelationId[doomedId]).toBeUndefined();
  });

  it('T051-R06 新鲜度是读取时派生：库中不存在 stale 布尔列', () => {
    const columns = db.prepare('PRAGMA table_info(relations)').all() as { name: string }[];
    const names = columns.map((column) => column.name);
    expect(names).not.toContain('is_stale');
    expect(names).not.toContain('stale');
    expect(names).toContain('source_raw_version');
    expect(names).toContain('target_raw_version');
  });
});
