/**
 * T044 适配器验收：领域图 → React Flow。
 *
 * 只测纯转换，不挂 React、不连数据库。每个断言对应规格里的一条：
 * ID 复用、只带展示字段、审核/过期样式、对称关系不画箭头、
 * 位置只来自 View、输入不被就地修改。
 */
import { describe, expect, it } from 'vitest';

import type { GraphData } from '@/domain/graph';
import { toFlowGraph, nodesNeedingLayout, NODE_WIDTH, NODE_HEIGHT } from '@/features/graph/graphAdapter';

function graphFixture(): GraphData {
  return {
    nodes: [
      {
        id: 'a',
        label: '甲',
        summary: '甲的摘要',
        type: 'idea',
        tags: ['标签'],
        status: 'raw',
        revision: 1,
        rawVersion: 1,
        isStructured: false,
        degree: 1,
      },
      {
        id: 'b',
        label: '乙',
        summary: '乙的摘要',
        type: 'idea',
        tags: [],
        status: 'raw',
        revision: 2,
        rawVersion: 3,
        isStructured: true,
        degree: 1,
      },
    ],
    edges: [
      {
        id: 'r1',
        sourceId: 'a',
        targetId: 'b',
        type: 'supports',
        origin: 'ai',
        reviewStatus: 'suggested',
        score: 0.82,
        reason: '甲给了乙依据',
        label: '甲为乙提供理由或例证',
        isStale: false,
        revision: 1,
        sourceRawVersion: 1,
        targetRawVersion: 3,
        evidence: [{ itemId: 'a', rawVersion: 1, quote: '甲给了乙依据' }],
      },
    ],
    datasetRevision: 7,
    scope: {
      matchedNodeCount: 2,
      shownNodeCount: 2,
      matchedEdgeCount: 1,
      shownEdgeCount: 1,
      suggestedEdgeCount: 1,
      truncated: false,
    },
  };
}

describe('T044 领域图到 React Flow 适配', () => {
  it('T044-C01 node.id 复用 Item.id，edge.id 复用 Relation.id', () => {
    const result = toFlowGraph({ graph: graphFixture() });
    expect(result.nodes.map((node) => node.id)).toEqual(['a', 'b']);
    expect(result.edges.map((edge) => edge.id)).toEqual(['r1']);
    expect(result.edges[0].source).toBe('a');
    expect(result.edges[0].target).toBe('b');
  });

  it('T044-R02 node.data 只带展示字段与来源 ID，不含 rawText 或完整 DTO', () => {
    const result = toFlowGraph({ graph: graphFixture() });
    const data = result.nodes[0].data;

    expect(data.itemId).toBe('a');
    expect(data.label).toBe('甲');
    // 原文、关键词、来源快照都不该进渲染层。
    const keys = Object.keys(data);
    expect(keys).not.toContain('rawText');
    expect(keys).not.toContain('capturedText');
    expect(keys).not.toContain('error');
    expect(keys).not.toContain('sourceRef');
  });

  it('T044-R03 suggested 边有文字标记，不只靠颜色', () => {
    const result = toFlowGraph({ graph: graphFixture() });
    const edge = result.edges[0];

    expect(edge.data?.badge).toBe('待确认');
    // 句子本身也带待确认标记，方便无障碍读出。
    expect(edge.data?.sentence).toBeTruthy();
  });

  it('T044-R04 有向关系有箭头，对称关系不画单向箭头', () => {
    const directed = toFlowGraph({ graph: graphFixture() });
    expect(directed.edges[0].markerEnd).toBeDefined();

    const symmetric = graphFixture();
    symmetric.edges[0].type = 'similar_to';
    const result = toFlowGraph({ graph: symmetric });
    expect(result.edges[0].markerEnd).toBeUndefined();
  });

  it('T044-R05 位置从 View.positions 读取，缺失时标记需布局且不调用模型', () => {
    const withoutPositions = toFlowGraph({ graph: graphFixture() });
    expect(withoutPositions.needsLayout).toBe(true);
    expect(withoutPositions.nodes[0].data.needsLayout).toBe(true);

    const withPositions = toFlowGraph({
      graph: graphFixture(),
      positions: { a: { x: 12, y: 34 }, b: { x: 56, y: 78 } },
    });
    expect(withPositions.needsLayout).toBe(false);
    expect(withPositions.nodes[0].position).toEqual({ x: 12, y: 34 });
    expect(withPositions.nodes[1].position).toEqual({ x: 56, y: 78 });
    expect(withPositions.nodes[0].data.needsLayout).toBe(false);
  });

  it('T044-R05 部分位置缺失时只有缺的那个节点需要布局', () => {
    const result = toFlowGraph({
      graph: graphFixture(),
      positions: { a: { x: 1, y: 1 } },
    });
    expect(result.needsLayout).toBe(true);
    expect(result.nodes[0].data.needsLayout).toBe(false);
    expect(result.nodes[1].data.needsLayout).toBe(true);
    expect(nodesNeedingLayout({ a: { x: 1, y: 1 } }, ['a', 'b'])).toEqual(['b']);
  });

  it('T044-R05 非有限坐标视为未保存，不作为可复用位置', () => {
    const result = toFlowGraph({
      graph: graphFixture(),
      positions: { a: { x: Number.NaN, y: 0 } },
    });
    expect(result.nodes[0].data.needsLayout).toBe(true);
  });

  it('T044-R06 转换不修改输入对象，返回全新对象', () => {
    const graph = graphFixture();
    const snapshot = JSON.stringify(graph);
    const result = toFlowGraph({ graph, positions: { a: { x: 5, y: 5 } } });

    expect(JSON.stringify(graph)).toBe(snapshot);
    expect(result.nodes[0]).not.toBe(graph.nodes[0]);
    // 拖动改的是返回对象的 position，不能穿透到领域 DTO。
    result.nodes[0].position.x = 999;
    expect(graph.nodes[0]).not.toHaveProperty('position');
    expect(JSON.stringify(graph)).toBe(snapshot);
  });

  it('T044-R06 节点带有约定宽高，供布局在测量前使用', () => {
    const result = toFlowGraph({ graph: graphFixture() });
    expect(result.nodes[0].width).toBe(NODE_WIDTH);
    expect(result.nodes[0].height).toBe(NODE_HEIGHT);
  });

  it('T044 过期关系按读取时新鲜度标注，不重复计算', () => {
    const result = toFlowGraph({
      graph: graphFixture(),
      freshness: { r1: 'stale' },
    });
    expect(result.edges[0].data?.freshness).toBe('stale');
    expect(result.edges[0].data?.badge).toBe('依据已变化');
  });

  it('T044 默认新鲜度来自边的 isStale，不假定 Service 一定传入', () => {
    const graph = graphFixture();
    graph.edges[0].isStale = true;
    const result = toFlowGraph({ graph });
    expect(result.edges[0].data?.freshness).toBe('stale');
  });

  it('T048-R02 评分说明写明是关联评分而不是正确率', async () => {
    const { describeScore, SCORE_LABEL } = await import('@/features/graph/badges');
    expect(describeScore('ai', 0.82)).toContain(SCORE_LABEL);
    expect(describeScore('ai', 0.82)).toContain('不是正确率');
    expect(describeScore('manual', null)).toContain('没有模型评分');
  });
});
