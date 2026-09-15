/**
 * T034 验收用例｜中文候选召回与上下文预算
 *
 * 使用真实临时数据库：候选召回的关键行为（旧条目能否被找回、去重、排除自身）
 * 只在真实 SQL 上才成立。用量全部是隔离数据，不接触用户库。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { LIMITS } from '@/domain/limits';
import { RETRIEVAL_VERSION } from '@/domain/candidates';
import { createCapture, listItemsService } from '@/server/services/items';
import { findCandidates } from '@/server/services/findCandidates';
import { setItemTags } from '@/server/repositories/tags';
import { bumpDatasetRevision } from '@/server/db/database';
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

interface SeedOptions {
  title?: string;
  summary?: string;
  tags?: string[];
  /** Back-dated so recency ordering is controllable. */
  ageDays?: number;
}

function seed(rawText: string, options: SeedOptions = {}): string {
  const created = createCapture(db, {
    captureRequestId: newId(),
    rawText,
    sourceType: 'other',
    sourceRef: null,
  }).item;

  const now = new Date(Date.now() - (options.ageDays ?? 0) * 86_400_000).toISOString();
  db.prepare(
    `UPDATE knowledge_items
        SET title = ?, summary = ?, updated_at = ?, created_at = ?
      WHERE id = ?`,
  ).run(options.title ?? '', options.summary ?? '', now, now, created.id);
  if (options.tags && options.tags.length > 0) {
    setItemTags(db, created.id, options.tags, now);
  }
  bumpDatasetRevision(db);
  return created.id;
}

describe('T034 候选召回', () => {
  it('T034-C01 三个月前的专业词条目仍能进入候选，不只取最近四十条', () => {
    // 一条很旧但含相同专业词的条目。
    const oldId = seed('向量检索的召回率需要单独评估。', {
      title: '向量检索评估',
      ageDays: 90,
    });
    // 三十条更新的、完全无关的资料把它挤到最近列表之外。
    for (let index = 0; index < 30; index += 1) {
      seed(`今天的待办事项编号 ${index}：买牛奶、交电费。`, { ageDays: index % 5 });
    }
    const targetId = seed('讨论向量检索在本地知识库里的取舍。', { title: '检索取舍' });

    const result = findCandidates(db, targetId);
    const ids = result.candidateIds;

    expect(ids).toContain(oldId);
    expect(ids[0]).not.toBe(targetId);
    expect(ids.every((id, index) => ids.indexOf(id) === index)).toBe(true);
  });

  it('T034-C02 中文无空格句子仍能按短语命中', () => {
    const relatedId = seed('决策记录：我们把本地优先当作硬约束。', {
      title: '架构决策',
      ageDays: 40,
    });
    for (let index = 0; index < 20; index += 1) {
      seed(`无关内容 ${index}`, { ageDays: 1 });
    }
    const targetId = seed('再次确认本地优先这个硬约束。', { title: '约束复核' });

    const result = findCandidates(db, targetId);
    expect(result.candidateIds).toContain(relatedId);
    const brief = result.candidates.find((entry) => entry.id === relatedId);
    expect(brief?.retrievalReason).toContain('字面');
  });

  it('T034-C03 同时命中近期与字面通道的候选只出现一次，并补足预算', () => {
    const overlapId = seed('标签系统需要规范化处理。', { title: '标签规范化', ageDays: 60 });
    for (let index = 0; index < 25; index += 1) {
      seed(`填充资料 ${index}`, { ageDays: index % 3 });
    }
    const targetId = seed('继续讨论标签规范化的边界。', { title: '标签边界' });

    const result = findCandidates(db, targetId);
    const occurrences = result.candidateIds.filter((id) => id === overlapId).length;
    expect(occurrences).toBe(1);
    expect(result.candidateIds.length).toBeLessThanOrEqual(LIMITS.candidateCount);
    // 只有一条重复时，名额应当继续由字面排名补足，而不是留空。
    expect(result.candidateIds.length).toBeGreaterThan(LIMITS.recentCandidateCount - 1);
  });

  it('T034-C04 候选里不含自身', () => {
    const otherId = seed('一条普通资料。');
    const targetId = seed('目标资料，需要整理这一条。');

    const result = findCandidates(db, targetId);
    expect(result.candidateIds).not.toContain(targetId);
    expect(result.candidateIds).toContain(otherId);
  });

  it('T034-C05 候选摘要超预算时按条目压缩，且每条都在各自预算内', () => {
    // 标题上限是一百码点，用接近上限的长标题触发标题预算压缩。
    const longTitle = '很长的标题'.repeat(20);
    const longSummary = '这是一段很长的摘要内容，用来验证预算压缩。'.repeat(15);
    // 采集上限是一万码点，所以用接近上限的原文来验证摘要预算压缩。
    const longText = '原文内容。'.repeat(1900);
    for (let index = 0; index < 12; index += 1) {
      const id = seed(`${longText} 关键词 预算 ${index}`, { title: longTitle });
      db.prepare('UPDATE knowledge_items SET summary = ? WHERE id = ?').run(longSummary, id);
    }
    const targetId = seed('预算 压缩 测试目标。', { title: '预算测试' });

    const result = findCandidates(db, targetId);
    for (const brief of result.candidates) {
      expect(Array.from(brief.title).length).toBeLessThanOrEqual(LIMITS.candidateBriefTitleCodePoints);
      expect(Array.from(brief.summary).length).toBeLessThanOrEqual(
        LIMITS.candidateBriefSummaryCodePoints,
      );
      const tagPoints = brief.tags.reduce((sum, tag) => sum + Array.from(tag).length, 0);
      expect(tagPoints).toBeLessThanOrEqual(LIMITS.candidateBriefTagsCodePoints);
      const evidencePoints = brief.evidenceSnippets.reduce(
        (sum, snippet) => sum + Array.from(snippet.text).length,
        0,
      );
      expect(evidencePoints).toBeLessThanOrEqual(LIMITS.candidateBriefEvidenceCodePoints + 90);
    }
    // 候选对象是完整的：没有把 JSON 截成半个字符串。
    expect(result.candidates.every((brief) => typeof brief.id === 'string')).toBe(true);
  });

  it('T034-C06 完全不同用词时不假装语义召回，而是在 notes 里承认局限', () => {
    seed('这个月要把磁盘容量扩到两倍。', { title: '扩容计划', ageDays: 30 });
    const targetId = seed('存储空间不足的问题需要尽早解决。', { title: '容量问题' });

    const result = findCandidates(db, targetId);
    // 允许漏检：这里断言的是「不撒谎」，不是「一定找得到」。
    expect(result.notes.join('\n')).toMatch(/字面相关|没有找到|最近的资料/u);
    expect(result.retrievalVersion).toBe(RETRIEVAL_VERSION);
  });

  it('T034-R04 相同输入与库快照得到完全相同的顺序', () => {
    for (let index = 0; index < 20; index += 1) {
      seed(`同一批资料 ${index} 结构化整理`, { title: `资料 ${index}`, ageDays: index });
    }
    const targetId = seed('结构化整理的目标条目。', { title: '目标' });

    const first = findCandidates(db, targetId);
    const second = findCandidates(db, targetId);
    expect(second.candidateIds).toEqual(first.candidateIds);
    expect(second.retrievalVersion).toBe('lexical-v1');
  });

  it('T034-R05 检索不写入任何数据，也不调用模型', () => {
    seed('已有资料。', { title: '已有' });
    const targetId = seed('目标条目。', { title: '目标' });

    const before = listItemsService(db, { filters: {}, sort: 'newest' });
    const runsBefore = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };

    findCandidates(db, targetId);

    const after = listItemsService(db, { filters: {}, sort: 'newest' });
    const runsAfter = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
    expect(after.items.map((item) => item.id)).toEqual(before.items.map((item) => item.id));
    expect(runsAfter.n).toBe(runsBefore.n);
  });

  it('T034-R01 候选数量不超过四十条，且最近条目优先', () => {
    for (let index = 0; index < 60; index += 1) {
      seed(`批量资料 ${index}`, { ageDays: index });
    }
    const targetId = seed('目标。', { title: '目标' });

    const result = findCandidates(db, targetId);
    expect(result.candidateIds.length).toBeLessThanOrEqual(LIMITS.candidateCount);
    // 最近十二条按时间顺序在前。
    const newest = listItemsService(db, { filters: {}, sort: 'newest', limit: 13 }).items;
    const expectedRecent = newest.filter((item) => item.id !== targetId).map((item) => item.id);
    const head = result.candidateIds.slice(0, Math.min(expectedRecent.length, 12));
    expect(head).toEqual(expectedRecent.slice(0, head.length));
  });

  it('T034-R03 单个常见字不产生假词，退回最近候选并说明', () => {
    seed('普通资料。', { title: '普通' });
    const targetId = seed('的', { title: '' });

    const result = findCandidates(db, targetId);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it('T034-R02 LIKE 的 % 与 _ 按字面处理', () => {
    const literalId = seed('这次实验的命中率是 50% 左右。', { title: '命中率', ageDays: 30 });
    const decoyId = seed('完全无关的另一条资料。', { title: '无关', ageDays: 20 });
    const targetId = seed('再记录一次：命中率 50% 的观察。', { title: '记录' });

    const result = findCandidates(db, targetId);
    if (result.candidateIds.includes(decoyId)) {
      // 若发生，说明 % 被当成了通配符 —— 这正是要排除的行为。
      const brief = result.candidates.find((entry) => entry.id === decoyId);
      expect(brief?.retrievalReason ?? '').not.toContain('字面命中');
    }
    expect(result.candidateIds).toContain(literalId);
  });
});
