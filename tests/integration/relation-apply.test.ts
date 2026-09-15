/**
 * T039 验收用例｜AI 关系证据、去重与拒绝保护
 *
 * 这一组的核心不是「关系写进去了」，而是**哪些关系没能写进去，以及为什么**。
 * 虚构目标、伪造引用、低分噪声都必须被拦下，而用户已经做出的决定（人工确认、
 * 已拒绝）不能被模型抢回去。
 *
 * 全部通过真实 SQLite 与真实仓储验证，模型输出用手写的结构化对象替代——
 * 应用层本来就不认识模型，它只认识 schema 校验后的数据。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { LIMITS } from '@/domain/limits';
import { withTransaction } from '@/server/db/database';
import { applyRelationSuggestions } from '@/server/services/applyRelationSuggestions';
import { createCapture, patchItem } from '@/server/services/items';
import { createManualRelation } from '@/server/services/createRelation';
import { reviewRelation } from '@/server/services/reviewRelation';
import { getItem } from '@/server/repositories/items';
import { bumpDatasetRevision } from '@/server/db/database';
import type { OrganizeOutputRelation } from '@/domain/schemas/organize';
import { createTestDatabase, openTestDatabase, newId, type TestDatabase } from '../helpers/db';

let test: TestDatabase;
let db: DatabaseSync;

beforeEach(() => {
  test = createTestDatabase();
  db = openTestDatabase(test.databasePath);
});

afterEach(() => {
  test.cleanup();
});

/**
 * A run row is required because relations carry `run_id`.
 *
 * Inserted as `succeeded` rather than `running`: relations are only written by a
 * run that committed, and a `running` row would occupy the single global
 * external-call slot (`idx_one_global_running`), which is exactly the index that
 * prevents two paid calls from overlapping.
 */
function seedRun(): string {
  const requestKey = newId();
  const runId = newId();
  db.prepare(
    `INSERT INTO ai_runs (
       id, request_key, request_hash, kind, subject_id, input_revision, input_hash,
       state, config_revision, config_snapshot_json, candidate_ids_json,
       result_ref, error_code, error_message, usage_json, prompt_version,
       attempt_count, started_at, deadline_at, finished_at
     ) VALUES (?, ?, 'hash', 'organize', NULL, 1, 'ih', 'succeeded', 1, '{}', '[]',
               NULL, NULL, NULL, NULL, 'organize-v1', 1, ?, ?, ?)`,
  ).run(
    runId,
    requestKey,
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:02:00.000Z',
    '2026-01-01T00:00:05.000Z',
  );
  return runId;
}

function seed(rawText: string) {
  return createCapture(db, {
    captureRequestId: newId(),
    rawText,
    sourceType: 'myself',
    sourceRef: null,
  }).item;
}

function suggestion(overrides: Partial<OrganizeOutputRelation>): OrganizeOutputRelation {
  return {
    targetId: newId(),
    type: 'similar_to',
    reason: '两条都谈到专注方法',
    score: 0.85,
    evidence: [],
    ...overrides,
  } as OrganizeOutputRelation;
}

function apply(input: {
  runId: string;
  targetId: string;
  candidateIds: string[];
  suggestions: OrganizeOutputRelation[];
}) {
  const target = getItem(db, input.targetId);
  return withTransaction(db, () =>
    applyRelationSuggestions({
      db,
      runId: input.runId,
      target: { id: target.id, rawText: target.rawText, rawVersion: target.rawVersion },
      candidates: input.candidateIds.map((id) => ({ id })),
      suggestions: input.suggestions,
      now: new Date().toISOString(),
    }),
  );
}

function relationRows() {
  return db
    .prepare(
      'SELECT id, source_id, target_id, relation_type, origin, review_status, score FROM relations',
    )
    .all() as {
    id: string;
    source_id: string;
    target_id: string;
    relation_type: string;
    origin: string;
    review_status: string;
    score: number | null;
  }[];
}

describe('T039 AI 关系应用', () => {
  it('T039-C01 模型给出候选之外的 UUID 时该关系被拒绝，不入库', () => {
    const runId = seedRun();
    const target = seed('番茄工作法可能提高专注度。');
    const candidate = seed('一条真正的候选资料，讲专注力的练习。');

    const result = apply({
      runId,
      targetId: target.id,
      candidateIds: [candidate.id],
      suggestions: [
        suggestion({
          // 一个看起来合理但本次没有发送过的 id。
          targetId: newId(),
          evidence: [{ itemId: target.id, quote: '专注度' }],
        }),
      ],
    });

    // 模型看似合理的链接也可能根本不存在。
    expect(relationRows()).toHaveLength(0);
    expect(result.created).toHaveLength(0);
    expect(result.droppedReasons.join('')).toContain('候选');
  });

  it('T039-C02 quote 不是任一原文子串时拒绝该边，并说明证据不匹配', () => {
    const runId = seedRun();
    const target = seed('番茄工作法可能提高专注度，我还没试过。');
    const candidate = seed('关于时间块的笔记：把一天切成若干段。');

    const result = apply({
      runId,
      targetId: target.id,
      candidateIds: [candidate.id],
      suggestions: [
        suggestion({
          targetId: candidate.id,
          evidence: [
            { itemId: target.id, quote: '专注度' },
            // 改写过的「引用」：加了引号不代表真的引用过来源。
            { itemId: candidate.id, quote: '把一天切成固定时间段' },
          ],
        }),
      ],
    });

    expect(relationRows()).toHaveLength(0);
    expect(result.droppedReasons.join('')).toContain('逐字');
  });

  it('T039-C03 对称关系交换端点时，两个端点的 rawVersion 与证据仍对应正确条目', () => {
    const runId = seedRun();
    const target = seed('关于深度工作的记录：需要连续的时间块。');
    const candidate = seed('关于专注力的记录：减少上下文切换。');

    // 先推进候选的 rawVersion，制造两个端点版本不同的局面；这样才能看出
    // 「只交换 ID」的实现在哪里错配。
    const edited = patchItem(db, {
      id: candidate.id,
      expectedRevision: candidate.revision,
      patch: { rawText: '关于专注力的记录（第二版）：减少上下文切换与干扰。' },
    });
    expect(edited.rawVersion).toBe(2);
    expect(target.rawVersion).toBe(1);

    apply({
      runId,
      targetId: target.id,
      candidateIds: [edited.id],
      // similar_to 是对称的：仓储会按 id 字典序重排端点。
      suggestions: [
        suggestion({
          targetId: edited.id,
          type: 'similar_to',
          evidence: [
            { itemId: target.id, quote: '连续的时间块' },
            { itemId: edited.id, quote: '减少上下文切换' },
          ],
        }),
      ],
    });

    const rows = relationRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];

    // 存的版本必须跟着各自端点走，而不是随 ID 交换一起错位。
    const stored = db
      .prepare('SELECT source_raw_version, target_raw_version, evidence_json FROM relations')
      .get() as { source_raw_version: number; target_raw_version: number; evidence_json: string };
    const versionByItem = new Map([
      [target.id, 1],
      [edited.id, 2],
    ]);
    expect(stored.source_raw_version).toBe(versionByItem.get(row.source_id));
    expect(stored.target_raw_version).toBe(versionByItem.get(row.target_id));

    // 证据里的 itemId 与 rawVersion 也必须各自对应原文所属条目。
    const evidence = JSON.parse(stored.evidence_json) as {
      itemId: string;
      rawVersion: number;
      quote: string;
    }[];
    for (const entry of evidence) {
      expect(entry.rawVersion).toBe(versionByItem.get(entry.itemId));
    }
    expect(evidence).toHaveLength(2);
    // 两个端点各有一条证据，没有因为交换而重复或丢失一端。
    expect(new Set(evidence.map((entry) => entry.itemId)).size).toBe(2);
  });

  it('T039-C04 score 为 0.69 时关系不进入建议，但整理本身仍然成功', () => {
    const runId = seedRun();
    const target = seed('一条关于阅读方法的记录。');
    const candidate = seed('另一条关于阅读方法的记录，侧重点不同。');

    const result = apply({
      runId,
      targetId: target.id,
      candidateIds: [candidate.id],
      suggestions: [
        suggestion({
          targetId: candidate.id,
          // 刚好在 0.70 门槛之下。
          score: 0.69,
          evidence: [
            { itemId: target.id, quote: '阅读方法' },
            { itemId: candidate.id, quote: '阅读方法' },
          ],
        }),
      ],
    });

    // 少连线优于把所有相近内容连成网。
    expect(relationRows()).toHaveLength(0);
    expect(result.created).toHaveLength(0);
    // 这不是失败：返回值本身就是「整理成功、关系为空」。
    expect(result.droppedReasons).toHaveLength(1);
    expect(LIMITS.relationScoreFloor).toBe(0.7);
  });

  it('T039-C05 同一条边已人工确认时，模型的不同理由不覆盖也不降级', () => {
    const target = seed('我自己的判断：这个方案可行。');
    const candidate = seed('相关背景资料。');

    // 用户手动建立并确认了这条关系。
    const manual = createManualRelation(db, {
      sourceId: target.id,
      targetId: candidate.id,
      type: 'supports',
      reason: '我确认过这条依据',
      sourceExpectedRevision: target.revision,
      targetExpectedRevision: candidate.revision,
    });
    const manualRow = db
      .prepare('SELECT origin, review_status, reason, score FROM relations WHERE id = ?')
      .get(manual.relation.id) as {
      origin: string;
      review_status: string;
      reason: string;
      score: number | null;
    };
    expect(manualRow.origin).toBe('manual');
    expect(manualRow.review_status).toBe('accepted');
    expect(manualRow.score).toBeNull();

    const runId = seedRun();
    const result = apply({
      runId,
      targetId: target.id,
      candidateIds: [candidate.id],
      suggestions: [
        suggestion({
          targetId: candidate.id,
          // 同一条边、同样的类型，但模型给了另一个理由与分数。
          type: 'supports',
          reason: '模型认为这句话支持那份资料',
          score: 0.91,
          evidence: [
            { itemId: target.id, quote: '这个方案可行' },
            { itemId: candidate.id, quote: '相关背景资料' },
          ],
        }),
      ],
    });

    const after = db
      .prepare('SELECT origin, review_status, reason, score FROM relations WHERE id = ?')
      .get(manual.relation.id) as {
      origin: string;
      review_status: string;
      reason: string;
      score: number | null;
    };
    // 自动化不能抢回用户控制权：理由、审核状态、评分全部保持人工版本。
    expect(after.origin).toBe('manual');
    expect(after.review_status).toBe('accepted');
    expect(after.reason).toBe('我确认过这条依据');
    expect(after.score).toBeNull();
    expect(result.preserved).toContain(manual.relation.id);
    expect(result.created).toHaveLength(0);
    expect(relationRows()).toHaveLength(1);
  });

  it('T039-C06 所有关系都被过滤时，关系为空但有可读的诊断计数', () => {
    const runId = seedRun();
    const target = seed('一条记录，写明了一件事。');
    const candidate = seed('另一条记录。');

    const result = apply({
      runId,
      targetId: target.id,
      candidateIds: [candidate.id],
      suggestions: [
        // 低分。
        suggestion({
          targetId: candidate.id,
          score: 0.5,
          evidence: [{ itemId: target.id, quote: '一条记录' }],
        }),
        // 引用伪造。
        suggestion({
          targetId: candidate.id,
          type: 'extends',
          score: 0.9,
          evidence: [{ itemId: target.id, quote: '原文里没有这句话' }],
        }),
        // 指向自己。
        suggestion({
          targetId: target.id,
          score: 0.9,
          evidence: [{ itemId: target.id, quote: '一条记录' }],
        }),
      ],
    });

    // 验收不能强制模型至少造一条边：关系为空是合法结果。
    expect(relationRows()).toHaveLength(0);
    expect(result.created).toHaveLength(0);
    // 但用户要知道为什么是空的，而不是以为模型什么都没找到。
    expect(result.droppedReasons.length).toBe(3);
    expect(result.droppedReasons.join('')).toContain('阈值');
  });
});

describe('T039 规则落点', () => {
  it('T039-R01 引用本次没有发送的条目时按未知条目拒绝', () => {
    const runId = seedRun();
    const target = seed('目标原文，包含可引用片段。');
    const candidate = seed('候选原文。');
    const stranger = seed('一个既不是目标也不是候选的条目。');

    const result = apply({
      runId,
      targetId: target.id,
      candidateIds: [candidate.id],
      suggestions: [
        suggestion({
          targetId: candidate.id,
          evidence: [
            { itemId: target.id, quote: '可引用片段' },
            // 这条资料确实存在于库里，但本次没有被发送。
            { itemId: stranger.id, quote: '既不是目标' },
          ],
        }),
      ],
    });

    expect(relationRows()).toHaveLength(0);
    expect(result.droppedReasons.join('')).toContain('没有发送');
  });

  it('T039-R03 同一批返回里的重复 (targetId, type) 只写入一条', () => {
    const runId = seedRun();
    const target = seed('重复建议的测试目标。');
    const candidate = seed('重复建议的测试候选。');

    const result = apply({
      runId,
      targetId: target.id,
      candidateIds: [candidate.id],
      suggestions: [
        suggestion({
          targetId: candidate.id,
          type: 'related_to',
          evidence: [
            { itemId: target.id, quote: '测试目标' },
            { itemId: candidate.id, quote: '测试候选' },
          ],
        }),
        suggestion({
          targetId: candidate.id,
          type: 'related_to',
          evidence: [
            { itemId: target.id, quote: '重复建议' },
            { itemId: candidate.id, quote: '重复建议' },
          ],
        }),
      ],
    });

    expect(relationRows()).toHaveLength(1);
    expect(result.created).toHaveLength(1);
    expect(result.droppedReasons.join('')).toContain('重复');
  });

  it('T039-R05 仍为 suggested 的同一对关系就地刷新，不插平行边', () => {
    const runId = seedRun();
    const target = seed('第一次整理的目标。');
    const candidate = seed('第一次整理的候选，关于时间管理。');

    const first = apply({
      runId,
      targetId: target.id,
      candidateIds: [candidate.id],
      suggestions: [
        suggestion({
          targetId: candidate.id,
          type: 'related_to',
          reason: '第一次的理由',
          score: 0.75,
          evidence: [
            { itemId: target.id, quote: '第一次整理' },
            { itemId: candidate.id, quote: '第一次整理' },
          ],
        }),
      ],
    });
    expect(first.created).toHaveLength(1);

    const second = apply({
      runId,
      targetId: target.id,
      candidateIds: [candidate.id],
      suggestions: [
        suggestion({
          targetId: candidate.id,
          type: 'related_to',
          reason: '第二次修订过的理由',
          score: 0.88,
          evidence: [
            { itemId: target.id, quote: '整理的目标' },
            { itemId: candidate.id, quote: '时间管理' },
          ],
        }),
      ],
    });

    // 一个规范键最多一行：刷新而不是累积。
    const rows = relationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.created[0]);
    expect(rows[0].score).toBeCloseTo(0.88);
    expect(second.updated).toEqual([first.created[0]]);
    expect(second.created).toHaveLength(0);

    const reason = db
      .prepare('SELECT reason FROM relations WHERE id = ?')
      .get(first.created[0]) as { reason: string };
    expect(reason.reason).toBe('第二次修订过的理由');
  });

  it('T039-R05 已拒绝的同一对关系不会被下一次整理复活', () => {
    const target = seed('目标：一条我暂时不想建立关系的记录。');
    const candidate = seed('候选：内容确实相近。');

    const runId = seedRun();
    const first = apply({
      runId,
      targetId: target.id,
      candidateIds: [candidate.id],
      suggestions: [
        suggestion({
          targetId: candidate.id,
          type: 'related_to',
          score: 0.82,
          evidence: [
            { itemId: target.id, quote: '不想建立关系' },
            { itemId: candidate.id, quote: '内容确实相近' },
          ],
        }),
      ],
    });
    expect(first.created).toHaveLength(1);

    // 用户明确拒绝这条 AI 建议。
    const relationId = first.created[0];
    const revision = (db.prepare('SELECT revision FROM relations WHERE id = ?').get(relationId) as {
      revision: number;
    }).revision;
    reviewRelation(db, { id: relationId, expectedRevision: revision, action: 'reject' });

    const rejected = db
      .prepare('SELECT review_status FROM relations WHERE id = ?')
      .get(relationId) as { review_status: string };
    expect(rejected.review_status).toBe('rejected');

    // 下一次整理又提出同一条边，而且给的理由更「像样」。
    const result = apply({
      runId: seedRun(),
      targetId: target.id,
      candidateIds: [candidate.id],
      suggestions: [
        suggestion({
          targetId: candidate.id,
          type: 'related_to',
          reason: '这一次解释得更充分',
          score: 0.95,
          evidence: [
            { itemId: target.id, quote: '不想建立关系' },
            { itemId: candidate.id, quote: '内容确实相近' },
          ],
        }),
      ],
    });

    // 拒绝要被记住：既不能改写状态，也不能插一条新的平行边。
    const after = db
      .prepare('SELECT review_status, reason FROM relations WHERE id = ?')
      .get(relationId) as { review_status: string; reason: string };
    expect(after.review_status).toBe('rejected');
    expect(after.reason).not.toBe('这一次解释得更充分');
    expect(relationRows()).toHaveLength(1);
    expect(result.preservedRejected).toBe(1);
    expect(result.created).toHaveLength(0);
  });

  it('T039-R01 候选在应用阶段已被删除时，只丢弃涉及它的关系', () => {
    const runId = seedRun();
    const target = seed('目标原文，讲的是时间块方法。');
    const candidate = seed('候选原文，讲的是番茄钟。');

    // 模型在飞的时候用户删掉了候选。
    db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(candidate.id);
    bumpDatasetRevision(db);

    const result = apply({
      runId,
      targetId: target.id,
      candidateIds: [candidate.id],
      suggestions: [
        suggestion({
          targetId: candidate.id,
          evidence: [
            { itemId: target.id, quote: '时间块方法' },
            { itemId: candidate.id, quote: '番茄钟' },
          ],
        }),
      ],
    });

    expect(relationRows()).toHaveLength(0);
    expect(result.droppedReasons.join('')).toContain('删除');
  });

  it('T039-R02 空引用列表不通过：没有引用就不是有依据的关系', () => {
    const runId = seedRun();
    const target = seed('目标原文。');
    const candidate = seed('候选原文。');

    const result = apply({
      runId,
      targetId: target.id,
      candidateIds: [candidate.id],
      // schema 要求至少一条引用，这里绕过 schema 直接验证应用层也拒绝。
      suggestions: [suggestion({ targetId: candidate.id, evidence: [] })],
    });

    expect(relationRows()).toHaveLength(0);
    expect(result.droppedReasons.join('')).toContain('引用');
  });

  it('T039-R05 人工关系端点方向不被对称化改写语义', () => {
    const runId = seedRun();
    const source = seed('较早的材料：分层架构的思路。');
    const target = seed('后一条材料：基于分层思路提出的事件溯源。');

    // extends 是有向的：A 延伸 B，不能因为 id 大小被交换。
    apply({
      runId,
      targetId: source.id,
      candidateIds: [target.id],
      suggestions: [
        suggestion({
          targetId: target.id,
          type: 'extends',
          evidence: [
            { itemId: source.id, quote: '分层架构' },
            { itemId: target.id, quote: '事件溯源' },
          ],
        }),
      ],
    });

    const row = relationRows()[0];
    expect(row.relation_type).toBe('extends');
    // 方向保持：source 是被整理的条目，target 是它延伸的对象。
    expect(row.source_id).toBe(source.id);
    expect(row.target_id).toBe(target.id);
  });
});
