/**
 * T022 / T023 人工关系与审核验收。
 *
 * 直接驱动关系服务层，覆盖规格里的六条方向规则与六条审核规则：
 * 自环拒绝、对称规范键、有向语义、人工升级 AI 建议、端点缺失、原文变化失效，
 * 以及拒绝墓碑不复活、人工边不走 AI 审核、revision 冲突、幂等审核、撤销拒绝。
 * 隔离数据库，不触碰用户 .data，也不调用任何模型。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import { normalizeEndpoints } from '@/domain/relation';
import { createCapture } from '@/server/services/items';
import { createManualRelation, queryRelations, removeRelation, reviewRelation } from '@/server/services/relations';
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

function manualInput(
  source: { id: string; revision: number },
  target: { id: string; revision: number },
  type: Parameters<typeof createManualRelation>[1]['type'] = 'related_to',
  reason = '',
) {
  return {
    sourceId: source.id,
    targetId: target.id,
    type,
    reason,
    sourceExpectedRevision: source.revision,
    targetExpectedRevision: target.revision,
  };
}

/** Insert an AI suggestion directly, the way the organize pipeline will. */
function insertSuggestion(
  sourceId: string,
  targetId: string,
  type: string,
  options: { reviewStatus?: 'suggested' | 'accepted' | 'rejected'; score?: number | null } = {},
): string {
  const endpoints = normalizeEndpoints(sourceId, targetId, type as never);
  const id = newId();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO relations (
       id, source_id, target_id, relation_type, origin, review_status, score, reason,
       evidence_json, source_raw_version, target_raw_version, run_id, revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'ai', ?, ?, '', '[]', 1, 1, NULL, 1, ?, ?)`,
  ).run(
    id,
    endpoints.sourceId,
    endpoints.targetId,
    type,
    options.reviewStatus ?? 'suggested',
    options.score === undefined ? 0.8 : options.score,
    now,
    now,
  );
  return id;
}

function relationCount(type?: string): number {
  const row = (type
    ? db.prepare('SELECT COUNT(*) AS n FROM relations WHERE relation_type = ?').get(type)
    : db.prepare('SELECT COUNT(*) AS n FROM relations').get()) as { n: number };
  return row.n;
}

describe('T022 人工关系', () => {
  it('T022-C01 自关联被拒绝且不入库', () => {
    const a = capture('自环测试');
    let raised: unknown = null;
    try {
      createManualRelation(db, manualInput(a, a));
    } catch (error) {
      raised = error;
    }
    expect((raised as AppError).code).toBe('VALIDATION');
    expect(relationCount()).toBe(0);
  });

  it('T022-C02 对称关系重放得到同一条规范边', () => {
    const a = capture('对称 A');
    const b = capture('对称 B');

    const first = createManualRelation(db, manualInput(a, b, 'similar_to'));
    const second = createManualRelation(db, manualInput(b, a, 'similar_to'));

    expect(first.created).toBe(true);
    // 反向提交命中同一规范键：视为重放，返回同一条边，不插平行边。
    expect(second.created).toBe(false);
    expect(second.relation.id).toBe(first.relation.id);
    expect(relationCount('similar_to')).toBe(1);
    expect(second.relation.revision).toBe(first.relation.revision);

    // 规范方向由 UUID 排序决定，与提交顺序无关。
    const endpoints = normalizeEndpoints(b.id, a.id, 'similar_to');
    const stored = db
      .prepare("SELECT source_id, target_id FROM relations WHERE relation_type = 'similar_to'")
      .get() as { source_id: string; target_id: string };
    expect(stored.source_id).toBe(endpoints.sourceId);
    expect(stored.target_id).toBe(endpoints.targetId);
  });

  it('T022-C02 反向提交同一条对称边命中同一规范键，不插平行边', () => {
    const a = capture('对称反向 A');
    const b = capture('对称反向 B');
    const first = createManualRelation(db, manualInput(a, b, 'related_to'));

    const second = createManualRelation(db, manualInput(b, a, 'related_to'));

    expect(second.created).toBe(false);
    expect(second.relation.id).toBe(first.relation.id);
    expect(relationCount('related_to')).toBe(1);
  });

  it('T022-C02 有向类型的反向提交是另一条边，方向语义不同', () => {
    const a = capture('有向反向 A');
    const b = capture('有向反向 B');
    createManualRelation(db, manualInput(a, b, 'depends_on'));

    // depends_on 不是对称关系，B 依赖 A 与 A 依赖 B 是两条不同的规范键。
    const reverse = createManualRelation(db, manualInput(b, a, 'depends_on'));

    expect(reverse.created).toBe(true);
    expect(relationCount('depends_on')).toBe(2);
  });

  it('T022-C03 有向关系保留源目标含义，不被排序改写', () => {
    const a = capture('依赖方');
    const b = capture('被依赖方');
    const result = createManualRelation(db, manualInput(a, b, 'depends_on'));

    expect(result.relation.sourceId).toBe(a.id);
    expect(result.relation.targetId).toBe(b.id);
    expect(result.relation.type).toBe('depends_on');
  });

  it('T022-R03 人工关系 score 为 null，reviewStatus 为 accepted', () => {
    const a = capture('人工 A');
    const b = capture('人工 B');
    const { relation } = createManualRelation(db, manualInput(a, b, 'supports'));

    expect(relation.origin).toBe('manual');
    expect(relation.reviewStatus).toBe('accepted');
    // 不能用 1.0 伪装成「百分百正确」。
    expect(relation.score).toBeNull();
  });

  it('T022-C04 人工确认把同键 AI 建议升级为原记录，不插平行边', () => {
    const a = capture('升级 A');
    const b = capture('升级 B');
    const suggestionId = insertSuggestion(a.id, b.id, 'supports', { score: 0.66 });

    const { relation, created } = createManualRelation(
      db,
      manualInput(a, b, 'supports', '我确认这条'),
    );

    expect(created).toBe(false);
    expect(relation.id).toBe(suggestionId);
    expect(relation.origin).toBe('manual');
    expect(relation.reviewStatus).toBe('accepted');
    expect(relation.score).toBeNull();
    expect(relation.reason).toBe('我确认这条');
    expect(relationCount('supports')).toBe(1);
  });

  it('T022-C05 端点已删除时拒绝创建，不留下悬空边', () => {
    const a = capture('存在的一方');
    const b = capture('将被删除的一方');
    db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(b.id);

    let raised: unknown = null;
    try {
      createManualRelation(db, manualInput(a, b));
    } catch (error) {
      raised = error;
    }
    expect((raised as AppError).code).toBe('NOT_FOUND');
    expect(relationCount()).toBe(0);
  });

  it('T022-C05 端点版本变化时返回冲突并保留原关系状态', () => {
    const a = capture('版本 A');
    const b = capture('版本 B');

    let raised: unknown = null;
    try {
      createManualRelation(db, {
        ...manualInput(a, b),
        targetExpectedRevision: b.revision + 5,
      });
    } catch (error) {
      raised = error;
    }
    expect((raised as AppError).code).toBe('REVISION_CONFLICT');
    expect(relationCount()).toBe(0);
  });

  it('T022-R02 理由超过三百码点被拒绝', () => {
    const a = capture('理由 A');
    const b = capture('理由 B');
    let raised: unknown = null;
    try {
      createManualRelation(db, manualInput(a, b, 'related_to', '字'.repeat(301)));
    } catch (error) {
      raised = error;
    }
    expect((raised as AppError).code).toBe('VALIDATION');
    expect(relationCount()).toBe(0);
  });

  it('T022-C06 端点原文变化后关系标为过期，不假装依据最新', () => {
    const a = capture('原文变化 A');
    const b = capture('原文变化 B');
    createManualRelation(db, manualInput(a, b, 'causes'));

    // 修改终点原文，rawVersion 前进。
    const item = db
      .prepare('SELECT revision, raw_version FROM knowledge_items WHERE id = ?')
      .get(b.id) as { revision: number; raw_version: number };
    db.prepare(
      'UPDATE knowledge_items SET raw_text = ?, raw_version = raw_version + 1, revision = revision + 1 WHERE id = ?',
    ).run('被改写后的原文', b.id);
    expect(item.raw_version).toBe(1);

    const active = queryRelations(db, { itemId: a.id });
    expect(active).toHaveLength(0);

    const withStale = queryRelations(db, { itemId: a.id, includeStale: true });
    expect(withStale).toHaveLength(1);
    expect(withStale[0]?.isStale).toBe(true);
  });

  it('T022-C06 重新确认后依据版本更新且重新可见', () => {
    const a = capture('重确认 A');
    const b = capture('重确认 B');
    const { relation } = createManualRelation(db, manualInput(a, b, 'causes'));

    db.prepare(
      'UPDATE knowledge_items SET raw_text = ?, raw_version = raw_version + 1, revision = revision + 1 WHERE id = ?',
    ).run('更新后的原文', b.id);

    const stale = queryRelations(db, { itemId: a.id, includeStale: true });
    expect(stale[0]?.isStale).toBe(true);

    const reconfirmed = reviewRelation(db, {
      id: relation.id,
      expectedRevision: stale[0]!.revision,
      action: 'reconfirm',
    });

    expect(reconfirmed.sourceRawVersion).toBe(1);
    expect(reconfirmed.targetRawVersion).toBe(2);
    expect(queryRelations(db, { itemId: a.id })).toHaveLength(1);
  });
});

describe('T023 关系审核', () => {
  it('T023-C01 拒绝后保留墓碑，重新整理同一关系不再作为建议出现', () => {
    const a = capture('拒绝 A');
    const b = capture('拒绝 B');
    const id = insertSuggestion(a.id, b.id, 'similar_to');

    const rejected = reviewRelation(db, { id, expectedRevision: 1, action: 'reject' });
    expect(rejected.reviewStatus).toBe('rejected');

    // 默认查询不返回被拒绝的边，但它仍在库里作为去重键。
    expect(queryRelations(db, {})).toHaveLength(0);
    expect(queryRelations(db, { includeRejected: true })).toHaveLength(1);
    expect(relationCount('similar_to')).toBe(1);
  });

  it('T023-C02 接受建议后仍为 origin=ai，评分不变', () => {
    const a = capture('接受 A');
    const b = capture('接受 B');
    const id = insertSuggestion(a.id, b.id, 'supports', { score: 0.42 });

    const accepted = reviewRelation(db, { id, expectedRevision: 1, action: 'accept' });

    expect(accepted.reviewStatus).toBe('accepted');
    expect(accepted.origin).toBe('ai');
    // 点击认可不等于把评分改成 1.0。
    expect(accepted.score).toBeCloseTo(0.42, 5);
  });

  it('T023-C03 人工边不接受 AI 审核动作，记录保持原状', () => {
    const a = capture('人工边 A');
    const b = capture('人工边 B');
    const { relation } = createManualRelation(db, manualInput(a, b, 'related_to'));

    let raised: unknown = null;
    try {
      reviewRelation(db, { id: relation.id, expectedRevision: relation.revision, action: 'reject' });
    } catch (error) {
      raised = error;
    }
    expect((raised as AppError).code).toBe('VALIDATION');

    const after = queryRelations(db, { itemId: a.id });
    expect(after).toHaveLength(1);
    expect(after[0]?.origin).toBe('manual');
    expect(after[0]?.reviewStatus).toBe('accepted');
  });

  it('T023-C04 旧 revision 审核返回冲突且不覆盖先前决定', () => {
    const a = capture('冲突 A');
    const b = capture('冲突 B');
    const id = insertSuggestion(a.id, b.id, 'related_to');

    reviewRelation(db, { id, expectedRevision: 1, action: 'accept' });

    let raised: unknown = null;
    try {
      reviewRelation(db, { id, expectedRevision: 1, action: 'reject' });
    } catch (error) {
      raised = error;
    }
    expect((raised as AppError).code).toBe('REVISION_CONFLICT');

    const row = db.prepare('SELECT review_status, revision FROM relations WHERE id = ?').get(id) as {
      review_status: string;
      revision: number;
    };
    expect(row.review_status).toBe('accepted');
    expect(row.revision).toBe(2);
  });

  it('T023-C05 重复相同决定不制造虚假修改', () => {
    const a = capture('幂等 A');
    const b = capture('幂等 B');
    const id = insertSuggestion(a.id, b.id, 'extends');

    const first = reviewRelation(db, { id, expectedRevision: 1, action: 'accept' });
    const once = db.prepare('SELECT revision FROM relations WHERE id = ?').get(id) as {
      revision: number;
    };

    // 用同一 revision 重放同一决定：状态没变，因此不应当作新修改返回 200 成功语义。
    let raised: unknown = null;
    try {
      reviewRelation(db, { id, expectedRevision: first.revision - 1, action: 'accept' });
    } catch (error) {
      raised = error;
    }
    expect((raised as AppError).code).toBe('REVISION_CONFLICT');

    const after = db.prepare('SELECT revision FROM relations WHERE id = ?').get(id) as {
      revision: number;
    };
    expect(after.revision).toBe(once.revision);
  });

  it('T023-C06 撤销拒绝恢复为待确认，不调用模型也不改评分', () => {
    const a = capture('撤销 A');
    const b = capture('撤销 B');
    const id = insertSuggestion(a.id, b.id, 'contradicts', { score: 0.55 });

    reviewRelation(db, { id, expectedRevision: 1, action: 'reject' });
    const restored = reviewRelation(db, { id, expectedRevision: 2, action: 'restoreSuggestion' });

    expect(restored.reviewStatus).toBe('suggested');
    expect(restored.origin).toBe('ai');
    expect(restored.score).toBeCloseTo(0.55, 5);
    // 撤销只是重新允许建议，不重新整理、不产生 Run。
    const runs = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
    expect(runs.n).toBe(0);
  });

  it('T023-C06 重新确认会丢掉不再逐字匹配的旧引文', () => {
    const a = capture('引文 A 原文');
    const b = capture('引文 B 原文');
    const id = newId();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO relations (
         id, source_id, target_id, relation_type, origin, review_status, score, reason,
         evidence_json, source_raw_version, target_raw_version, run_id, revision, created_at, updated_at
       ) VALUES (?, ?, ?, 'supports', 'ai', 'accepted', 0.7, '', ?, 1, 1, NULL, 1, ?, ?)`,
    ).run(
      id,
      normalizeEndpoints(a.id, b.id, 'supports').sourceId,
      normalizeEndpoints(a.id, b.id, 'supports').targetId,
      JSON.stringify([
        { itemId: a.id, rawVersion: 1, quote: '引文 A' },
        { itemId: b.id, rawVersion: 1, quote: '不再存在的句子' },
      ]),
      now,
      now,
    );

    const reconfirmed = reviewRelation(db, {
      id,
      expectedRevision: 1,
      action: 'reconfirm',
    });

    expect(reconfirmed.evidence).toHaveLength(1);
    expect(reconfirmed.evidence[0]?.quote).toBe('引文 A');
  });

  it('T023-R05 删除人工关系后不再出现在查询里，其他关系不受影响', () => {
    const a = capture('删除 A');
    const b = capture('删除 B');
    const c = capture('删除 C');
    const first = createManualRelation(db, manualInput(a, b, 'related_to')).relation;
    createManualRelation(db, manualInput(a, c, 'supports'));

    removeRelation(db, first.id, first.revision);

    expect(queryRelations(db, { itemId: a.id })).toHaveLength(1);
    expect(relationCount()).toBe(1);
  });
});
