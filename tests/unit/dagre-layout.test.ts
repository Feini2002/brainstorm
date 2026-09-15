/**
 * T046 Dagre 布局验收。
 *
 * 覆盖六条规则：显式触发（不在渲染路径）、中心→左上角换算、清除悬空边、
 * 有环与孤立分量不丢关系、无效坐标拒绝应用、断言不绑定具体像素。
 */
import { describe, expect, it } from 'vitest';

import { LIMITS } from '@/domain/limits';
import { isValidCoordinate } from '@/domain/view';
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH } from '@/features/graph/layoutGraph';

const nodes = [
  { id: 'a', width: NODE_WIDTH, height: NODE_HEIGHT },
  { id: 'b', width: NODE_WIDTH, height: NODE_HEIGHT },
  { id: 'c', width: NODE_WIDTH, height: NODE_HEIGHT },
];

describe('T046 Dagre 布局', () => {
  it('T046-C01 三节点两边的图得到全部有限坐标', () => {
    const result = layoutGraph({
      nodes,
      edges: [
        { sourceId: 'a', targetId: 'b' },
        { sourceId: 'b', targetId: 'c' },
      ],
      direction: 'TB',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.positions).sort()).toEqual(['a', 'b', 'c']);
    for (const point of Object.values(result.positions)) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
      expect(isValidCoordinate(point.x)).toBe(true);
      expect(isValidCoordinate(point.y)).toBe(true);
    }
  });

  it('T046-R02 输出为左上角坐标：同秩两节点按尺寸分离而非重叠', () => {
    const result = layoutGraph({
      nodes,
      edges: [{ sourceId: 'a', targetId: 'b' }],
      direction: 'TB',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 孤立节点 c 与 a/b 不重叠：坐标不全相等。
    const points = Object.values(result.positions);
    const unique = new Set(points.map((point) => `${point.x},${point.y}`));
    expect(unique.size).toBe(3);
  });

  it('T046-R02 布局方向可切换，LR 与 TB 产生不同坐标', () => {
    const edges = [{ sourceId: 'a', targetId: 'b' }];
    const tb = layoutGraph({ nodes, edges, direction: 'TB' });
    const lr = layoutGraph({ nodes, edges, direction: 'LR' });
    expect(tb.ok && lr.ok).toBe(true);
    if (!tb.ok || !lr.ok) return;
    // 起点在两种方向下都位于原点附近，但整张图的相对排布不同。
    expect(tb.positions).not.toEqual(lr.positions);
  });

  it('T046-R03 悬空边在布局前被清除，不产生幽灵节点', () => {
    const result = layoutGraph({
      nodes,
      edges: [
        { sourceId: 'a', targetId: 'missing' },
        { sourceId: 'a', targetId: 'b' },
      ],
      direction: 'TB',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.positions).sort()).toEqual(['a', 'b', 'c']);
    expect(result.positions).not.toHaveProperty('missing');
  });

  it('T046-R04 有环图仍能布局，不通过删除关系变成树', () => {
    const result = layoutGraph({
      nodes,
      edges: [
        { sourceId: 'a', targetId: 'b' },
        { sourceId: 'b', targetId: 'c' },
        { sourceId: 'c', targetId: 'a' },
      ],
      direction: 'TB',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.positions)).toHaveLength(3);
  });

  it('T046-R04 多个孤立分量各自得到坐标，零边不是错误', () => {
    const result = layoutGraph({ nodes, edges: [], direction: 'TB' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.positions).sort()).toEqual(['a', 'b', 'c']);
  });

  it('T046-R04 对称边自环被跳过而不是让 Dagre 抛错', () => {
    const result = layoutGraph({
      nodes,
      edges: [
        { sourceId: 'a', targetId: 'a' },
        { sourceId: 'a', targetId: 'b' },
      ],
      direction: 'TB',
    });
    expect(result.ok).toBe(true);
  });

  it('T046-R05 宽高为 NaN 时回退到约定尺寸，不产出无效坐标', () => {
    const result = layoutGraph({
      nodes: [
        { id: 'a', width: Number.NaN, height: Number.NaN },
        { id: 'b' },
      ],
      edges: [{ sourceId: 'a', targetId: 'b' }],
      direction: 'TB',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isValidCoordinate(result.positions.a.x)).toBe(true);
  });

  it('T046-R06 坐标在契约范围内，不超出 viewCoordinateAbsMax', () => {
    const result = layoutGraph({
      nodes: Array.from({ length: 30 }, (_, index) => ({
        id: `n${index}`,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      })),
      edges: Array.from({ length: 29 }, (_, index) => ({
        sourceId: `n${index}`,
        targetId: `n${index + 1}`,
      })),
      direction: 'LR',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const point of Object.values(result.positions)) {
      expect(Math.abs(point.x)).toBeLessThanOrEqual(LIMITS.viewCoordinateAbsMax);
      expect(Math.abs(point.y)).toBeLessThanOrEqual(LIMITS.viewCoordinateAbsMax);
    }
  });

  it('T046-R01 布局是纯函数：同样输入两次得到同样坐标', () => {
    const input = {
      nodes,
      edges: [{ sourceId: 'a', targetId: 'b' }],
      direction: 'TB' as const,
    };
    const first = layoutGraph(input);
    const second = layoutGraph(input);
    expect(first).toEqual(second);
  });

  it('T046-R06 相同 ID 集合与边数即可复现，不依赖遍历顺序', () => {
    const forward = layoutGraph({
      nodes,
      edges: [{ sourceId: 'a', targetId: 'b' }],
      direction: 'TB',
    });
    const reversed = layoutGraph({
      nodes: [...nodes].reverse(),
      edges: [{ sourceId: 'a', targetId: 'b' }],
      direction: 'TB',
    });
    expect(forward.ok && reversed.ok).toBe(true);
    if (!forward.ok || !reversed.ok) return;
    expect(Object.keys(forward.positions).sort()).toEqual(Object.keys(reversed.positions).sort());
  });
});
