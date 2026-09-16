/**
 * T076-C02 验收：对称关系的端点与证据必须一起交换。
 *
 * `src/domain/evidence.ts` 在本任务之前**四个公共函数零单测**——`verifyEvidence`、
 * `normalizeRelationWithEvidence`、`meetsScoreFloor`、`describeRejection` 都只被
 * 服务层间接调用。所以这里不是复述既有断言，是补一块真空。
 *
 * C02 的要点是「排序只改 ID 会留下隐藏错误」：对称关系（`similar_to` / `contradicts`
 * / `related_to`）按 UUID 字符串顺序存端点，但**证据不是对称的**——每一段引用属于
 * 某一个具体条目。如果交换端点时忘了让各自的 `rawVersion` 跟着走，引用就会挂到
 * 错误的版本上，于是「编辑了 A」会让挂在 B 上的引用看起来过期或恰好相反。
 */
import { describe, expect, it } from 'vitest';

import {
  describeRejection,
  meetsScoreFloor,
  normalizeRelationWithEvidence,
  verifyEvidence,
  type EndpointVersions,
  type EvidenceRejection,
} from '@/domain/evidence';
import { LIMITS } from '@/domain/limits';
import { RELATION_TYPES, SYMMETRIC_RELATION_TYPES } from '@/domain/knowledge';
import type { Evidence } from '@/domain/knowledge';

const LOW = '11111111-1111-4111-8111-111111111111';
const HIGH = '99999999-9999-4999-8999-999999999999';

function endpoints(
  sourceId: string,
  targetId: string,
  sourceRawVersion = 1,
  targetRawVersion = 2,
): EndpointVersions {
  return { sourceId, targetId, sourceRawVersion, targetRawVersion };
}

function evidence(itemId: string, rawVersion: number, quote: string): Evidence {
  return { itemId, rawVersion, quote };
}

describe('T076-C02 对称交换：端点与证据版本一起走', () => {
  it('T076-C02 端点已按 id 升序时不动，也不标记 swapped', () => {
    const input = endpoints(LOW, HIGH, 3, 7);
    const quoted = [evidence(LOW, 3, '低 id 一侧的原文')];

    const result = normalizeRelationWithEvidence('similar_to', input, quoted);

    expect(result.swapped).toBe(false);
    expect(result.sourceId).toBe(LOW);
    expect(result.targetId).toBe(HIGH);
    expect(result.sourceRawVersion).toBe(3);
    expect(result.targetRawVersion).toBe(7);
    // 未交换时证据原样保留（是副本，不是同一个数组引用）。
    expect(result.evidence).toEqual(quoted);
    expect(result.evidence).not.toBe(quoted);
  });

  it('T076-C02 端点逆序时 id 与各自版本成对交换，不只是 id', () => {
    // 提交顺序是 (HIGH, LOW)，版本分别是 7 和 3。交换后 HIGH 的版本必须仍是 7、
    // LOW 的仍是 3。只换 id 不换版本是这个用例要抓的那个隐藏错误。
    const input = endpoints(HIGH, LOW, 7, 3);

    const result = normalizeRelationWithEvidence('similar_to', input, []);

    expect(result.swapped).toBe(true);
    expect(result.sourceId).toBe(LOW);
    expect(result.targetId).toBe(HIGH);
    expect(result.sourceRawVersion).toBe(3);
    expect(result.targetRawVersion).toBe(7);
  });

  it('T076-C02 版本号相同时交换仍然发生，不能靠版本相等来掩盖', () => {
    // 若实现用「版本是否相等」判断要不要交换，这里就会漏掉 id 顺序问题。
    const input = endpoints(HIGH, LOW, 5, 5);

    const result = normalizeRelationWithEvidence('related_to', input, []);

    expect(result.swapped).toBe(true);
    expect(result.sourceId).toBe(LOW);
    expect(result.targetId).toBe(HIGH);
  });

  it('T076-C02 交换后证据里的 rawVersion 仍对应它自己的 itemId', () => {
    // 关键不变量：证据的 rawVersion 由 itemId 决定，不随端点顺序移动。
    const input = endpoints(HIGH, LOW, 7, 3);
    const quoted = [
      evidence(HIGH, 7, '高 id 一侧的原文'),
      evidence(LOW, 3, '低 id 一侧的原文'),
    ];

    const result = normalizeRelationWithEvidence('contradicts', input, quoted);

    expect(result.swapped).toBe(true);
    const byItem = new Map(result.evidence.map((entry) => [entry.itemId, entry.rawVersion]));
    expect(byItem.get(HIGH)).toBe(7);
    expect(byItem.get(LOW)).toBe(3);
  });

  it('T076-C02 非对称关系不排序、不标记 swapped', () => {
    // `causes` / `depends_on` 等是有方向的：即使 id 逆序也必须原样保留，
    // 否则「A 导致 B」会被改写成「B 导致 A」。
    const directional = RELATION_TYPES.filter(
      (type) => !SYMMETRIC_RELATION_TYPES.includes(type),
    );
    expect(directional.length).toBeGreaterThan(0);

    for (const type of directional) {
      const input = endpoints(HIGH, LOW, 7, 3);
      const result = normalizeRelationWithEvidence(type, input, []);
      expect(result.swapped, `${type} 不应被判定为需要交换`).toBe(false);
      expect(result.sourceId, `${type} 的 sourceId 不应被改动`).toBe(HIGH);
      expect(result.targetId, `${type} 的 targetId 不应被改动`).toBe(LOW);
      expect(result.sourceRawVersion).toBe(7);
      expect(result.targetRawVersion).toBe(3);
    }
  });

  it('T076-C02 归一化是幂等的：第二次调用不再交换', () => {
    const first = normalizeRelationWithEvidence('similar_to', endpoints(HIGH, LOW, 7, 3), []);
    const second = normalizeRelationWithEvidence(
      'similar_to',
      {
        sourceId: first.sourceId,
        targetId: first.targetId,
        sourceRawVersion: first.sourceRawVersion,
        targetRawVersion: first.targetRawVersion,
      },
      first.evidence,
    );

    expect(second.swapped).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);
    expect(second.sourceRawVersion).toBe(first.sourceRawVersion);
  });
});

describe('T076-C02 证据核验的拒绝路径', () => {
  const live = new Map<string, string>([
    [LOW, '甲条目原文里有这句话，可以逐字引用。'],
    [HIGH, '乙条目原文里是另一句完全不同的内容。'],
  ]);

  it('T076-C02 逐字命中的引用带上服务端版本，而不是模型给的版本', () => {
    const result = verifyEvidence(
      [{ itemId: LOW, quote: '甲条目原文里有这句话' }],
      live,
      endpoints(LOW, HIGH, 4, 9),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence).toEqual([
      { itemId: LOW, rawVersion: 4, quote: '甲条目原文里有这句话' },
    ]);
  });

  it('T076-C02 转述而非逐字命中的引用被拒', () => {
    const result = verifyEvidence(
      [{ itemId: LOW, quote: '甲条目原文里大概有这句话' }],
      live,
      endpoints(LOW, HIGH, 4, 9),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe('quote_not_found');
  });

  it('T076-C02 引用指向关系两端之外的条目被拒', () => {
    const outside = '55555555-5555-4555-8555-555555555555';
    const withOutside = new Map(live).set(outside, '两端之外的一条笔记原文。');

    const result = verifyEvidence(
      [{ itemId: outside, quote: '两端之外的一条笔记原文。' }],
      withOutside,
      endpoints(LOW, HIGH, 4, 9),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe('wrong_endpoint');
  });

  it('T076-C02 引用指向未发送的条目被拒（不是当成找不到文字）', () => {
    const result = verifyEvidence(
      [{ itemId: 'not-sent', quote: '任何内容' }],
      live,
      endpoints(LOW, HIGH, 4, 9),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe('unknown_item');
  });

  it('T076-C02 空引用与只有空白的引用都被拒，且失败分支不携带证据', () => {
    const empty = verifyEvidence([], live, endpoints(LOW, HIGH, 4, 9));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.rejection).toBe('quote_empty');

    const blank = verifyEvidence(
      [{ itemId: LOW, quote: '   \n  ' }],
      live,
      endpoints(LOW, HIGH, 4, 9),
    );
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.rejection).toBe('quote_empty');
    // 判别式结果的意义：失败分支上根本没有 evidence 字段可读。
    expect('evidence' in blank).toBe(false);
  });

  it('T076-C02 超过引用长度上限的引用被拒', () => {
    const tooLong = '标'.repeat(LIMITS.evidenceQuoteCodePoints + 1);
    const result = verifyEvidence(
      [{ itemId: LOW, quote: tooLong }],
      new Map([[LOW, tooLong]]),
      endpoints(LOW, HIGH, 4, 9),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe('quote_not_found');
  });

  it('T076-C02 恰好等于长度上限的引用被接受（边界包含）', () => {
    const atLimit = '标'.repeat(LIMITS.evidenceQuoteCodePoints);
    const result = verifyEvidence(
      [{ itemId: LOW, quote: atLimit }],
      new Map([[LOW, atLimit]]),
      endpoints(LOW, HIGH, 4, 9),
    );

    expect(result.ok).toBe(true);
  });
});

describe('T076-C02 分数门槛与拒绝理由', () => {
  it('T076-C02 分数门槛是包含边界的，null 直接不达标', () => {
    expect(meetsScoreFloor(null)).toBe(false);
    expect(meetsScoreFloor(LIMITS.relationScoreFloor)).toBe(true);
    expect(meetsScoreFloor(LIMITS.relationScoreFloor + 0.0001)).toBe(true);
    // 低于门槛是丢弃而不是降级，所以这一点必须严格。
    expect(meetsScoreFloor(LIMITS.relationScoreFloor - 0.0001)).toBe(false);
    expect(meetsScoreFloor(0)).toBe(false);
  });

  it('T076-C02 每个拒绝码都有可读中文理由，且互不相同', () => {
    const rejections: EvidenceRejection[] = [
      'quote_not_found',
      'quote_empty',
      'unknown_item',
      'wrong_endpoint',
    ];

    const texts = rejections.map((code) => describeRejection(code));
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(0);
      expect(text).toMatch(/[\u4e00-\u9fff]/u);
    }
    expect(new Set(texts).size, '不同拒绝码不应给出同一句话').toBe(rejections.length);
  });
});
