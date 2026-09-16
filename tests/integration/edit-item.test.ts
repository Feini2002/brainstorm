/**
 * T019 验收：人工编辑、版本冲突与字段保护。
 *
 * 用例规格：docs/05_tests/G1/T019_cases.md。审计结论是 `editItem.ts` 无直接测试，
 * 现有 409 断言挂在 T022/T038 名下；这里补上带 T019 标签的直接断言：
 * 原文修订推进 rawVersion、CAS 冲突返回 409、人工锁定字段不被整理覆盖、
 * 无变化保存不虚增版本、系统字段越权被 schema 拒绝、解除保护不触发模型调用。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import type { ItemDTO } from '@/domain/knowledge';
import { closeDb, getDatasetRevision } from '@/server/db/database';
import { createCapture, patchItem } from '@/server/services/items';
import { applyOrganizeMetadata } from '@/server/services/applyOrganizeMetadata';
import { findTagByNormalized } from '@/server/repositories/tags';
import { nowIso } from '@/server/repositories/shared';
import { createTestDatabase, newId, openTestDatabase, type TestDatabase } from '../helpers/db';
import { callRoute } from './helpers/http';

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

function storedRow(id: string): {
  raw_version: number;
  revision: number;
  title: string;
  summary: string;
  structured_base_raw_version: number | null;
  manual_fields_json: string;
  captured_text: string;
  updated_at: string;
} {
  return db
    .prepare(
      `SELECT raw_version, revision, title, summary, structured_base_raw_version,
              manual_fields_json, captured_text, updated_at
         FROM knowledge_items WHERE id = ?`,
    )
    .get(id) as never;
}

/** A model-shaped organize payload; only the fields a run may write. */
function organized(overrides: Record<string, unknown> = {}) {
  return {
    title: '模型给的标题',
    summary: '模型给的摘要',
    type: 'idea' as const,
    tags: ['模型标签'],
    keywords: ['模型关键词'],
    importance: 4,
    relations: [],
    ...overrides,
  };
}

describe('T019 原文修订与版本', () => {
  it('T019-C01 修改原文错字：rawVersion +1、revision 增加、旧摘要保留但标记过期', () => {
    const item = capture('原文里有一个错子，需要改掉。');

    // 先做一次整理，形成「旧摘要」与整理基线。
    const applied = applyOrganizeMetadata({
      db,
      current: item,
      organized: organized(),
      expectedRevision: item.revision,
      expectedRawVersion: item.rawVersion,
      now: nowIso(),
    });
    expect(applied.changed).toBe(true);
    const afterOrganize = storedRow(item.id);
    expect(afterOrganize.structured_base_raw_version).toBe(1);

    const revised = patchItem(db, {
      id: item.id,
      // Re-read the revision after the organize write instead of guessing it.
      expectedRevision: afterOrganize.revision,
      patch: { rawText: '原文里有一个错字，需要改掉。' },
    });

    expect(revised.rawVersion).toBe(2);
    expect(revised.revision).toBeGreaterThan(item.revision);
    // 旧摘要没有被清空，只是过期：这正是「清空会损失仍有参考价值的信息」的反例。
    expect(revised.summary).toBe('模型给的摘要');
    expect(revised.structuredBaseRawVersion).toBe(1);
    expect(revised.isStructuredStale).toBe(true);
    expect(storedRow(item.id).captured_text).toBe('原文里有一个错子，需要改掉。');
  });

  it('T019-C03 两个窗口基于同一 revision：后保存的一方拿到 409', () => {
    const item = capture('两个窗口同时编辑的原文。');

    // 窗口 A 先保存成功。
    const saved = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: { summary: 'A 窗口写的摘要' },
    });
    expect(saved.revision).toBe(item.revision + 1);

    // 窗口 B 仍拿着旧 revision。
    let raised: unknown = null;
    try {
      patchItem(db, {
        id: item.id,
        expectedRevision: item.revision,
        patch: { summary: 'B 窗口写的摘要' },
      });
    } catch (error) {
      raised = error;
    }

    expect((raised as AppError).code).toBe('REVISION_CONFLICT');
    // B 的内容没有落库，A 的改动仍在。
    expect(storedRow(item.id).summary).toBe('A 窗口写的摘要');
  });

  it('T019-C03 冲突发生后用最新 revision 重试即可保存（草稿不是死路）', () => {
    const item = capture('冲突后重试的原文。');
    const first = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: { summary: '第一次' },
    });

    const retried = patchItem(db, {
      id: item.id,
      expectedRevision: first.revision,
      patch: { summary: 'B 窗口重新载入后的摘要' },
    });

    expect(retried.summary).toBe('B 窗口重新载入后的摘要');
    expect(retried.revision).toBe(first.revision + 1);
  });
});

describe('T019 人工字段保护', () => {
  it('T019-C02 人工改过的标题在整理时不被覆盖，未锁字段仍然更新', () => {
    const item = capture('用户会手动改标题的原文。');

    const edited = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: { title: '我自己定的标题' },
    });
    // 服务器根据实际改动建立锁定，而不是浏览器声明。
    expect(edited.manualFields).toContain('title');

    const result = applyOrganizeMetadata({
      db,
      current: edited,
      organized: organized({ title: '模型想改成的标题', summary: '模型摘要' }),
      expectedRevision: edited.revision,
      expectedRawVersion: edited.rawVersion,
      now: nowIso(),
    });

    expect(result.skipped).toContain('title');
    expect(result.applied).toContain('summary');
    const after = storedRow(item.id);
    expect(after.title).toBe('我自己定的标题');
    expect(after.summary).toBe('模型摘要');
  });

  it('T019-C02 人工锁定的标签不被模型覆盖，未锁字段照常写入', () => {
    const item = capture('用户手动整理过标签的原文。');
    const edited = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: { tags: ['我的标签'], title: '用户标题' },
    });
    expect(edited.manualFields).toEqual(expect.arrayContaining(['tags', 'title']));

    const result = applyOrganizeMetadata({
      db,
      current: edited,
      organized: organized({ tags: ['模型标签'], keywords: ['模型关键词'] }),
      expectedRevision: edited.revision,
      expectedRawVersion: edited.rawVersion,
      now: nowIso(),
    });

    expect(result.skipped).toContain('tags');
    expect(result.applied).toContain('keywords');
    const tags = db
      .prepare(
        `SELECT t.label AS label FROM item_tags it JOIN tags t ON t.id = it.tag_id
          WHERE it.item_id = ? ORDER BY it.position`,
      )
      .all(item.id) as { label: string }[];
    expect(tags.map((row) => row.label)).toEqual(['我的标签']);
    // 模型标签没有因为这次整理被创建进词典。
    expect(findTagByNormalized(db, '模型标签')).toBeNull();
  });

  it('T019-C06 解除保护只移除锁定标记与手册记录，不自动调用模型', () => {
    const item = capture('解除标题保护。');
    const locked = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: { title: '先锁住的标题' },
    });
    expect(locked.manualFields).toContain('title');
    const revisionBefore = locked.revision;

    const unlocked = patchItem(db, {
      id: item.id,
      expectedRevision: locked.revision,
      patch: {},
      unlockFields: ['title'],
    });

    expect(unlocked.manualFields).not.toContain('title');
    expect(unlocked.title).toBe('先锁住的标题');
    // 只动保护标记：版本前进一次，内容不变，且没有 Run 记录被创建。
    expect(unlocked.revision).toBe(revisionBefore + 1);
    const runs = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
    expect(runs.n).toBe(0);
  });

  it('T019-C06 无变化的保存不虚增版本，也不推进 datasetRevision', () => {
    const item = capture('无变化保存的原文。');
    const before = storedRow(item.id);
    const datasetBefore = getDatasetRevision(db);

    const unchanged = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: { rawText: item.rawText, title: item.title, summary: item.summary },
    });

    expect(unchanged.revision).toBe(item.revision);
    expect(storedRow(item.id).updated_at).toBe(before.updated_at);
    expect(getDatasetRevision(db)).toBe(datasetBefore);
  });
});

describe('T019 HTTP 层越权与错误码', () => {
  async function patch(id: string, body: unknown) {
    const { PATCH } = await import('@/app/api/items/[id]/route');
    return callRoute(PATCH, { method: 'PATCH', path: `/api/items/${id}`, body, params: { id } });
  }

  it('T019-C05 PATCH 携带 capturedText / revision / status 被 schema 拒绝，初始材料不变', async () => {
    const item = capture('原始采集内容不应被改写。');

    const response = await patch(item.id, {
      expectedRevision: item.revision,
      patch: { title: '改写标题' },
      // 三个未授权字段：原始材料、并发令牌、派生状态。
      capturedText: '伪造的初始材料',
      revision: 99,
      status: 'done',
    });

    expect(response.status).toBe(400);
    const failure = response.envelope as {
      ok: false;
      error: { code: string; fieldErrors?: Record<string, string[]> };
    };
    expect(failure.error.code).toBe('VALIDATION');
    const named = Object.keys(failure.error.fieldErrors ?? {});
    expect(named).toContain('capturedText');
    expect(named).toContain('revision');
    expect(named).toContain('status');

    const after = storedRow(item.id);
    expect(after.captured_text).toBe('原始采集内容不应被改写。');
    expect(after.revision).toBe(item.revision);
    expect(after.title).toBe('');
  });

  it('T019-C03 陈旧 revision 经 HTTP 层返回 409 REVISION_CONFLICT', async () => {
    const item = capture('HTTP 层冲突。');
    await patch(item.id, {
      expectedRevision: item.revision,
      patch: { summary: '先到的写入' },
    });

    const stale = await patch(item.id, {
      expectedRevision: item.revision,
      patch: { summary: '迟到的写入' },
    });

    expect(stale.status).toBe(409);
    const failure = stale.envelope as { ok: false; error: { code: string; retryable: boolean } };
    expect(failure.error.code).toBe('REVISION_CONFLICT');
    expect(failure.error.retryable).toBe(false);
    expect(storedRow(item.id).summary).toBe('先到的写入');
  });

  it('T019-C05 越界字段值（超长标题、非法重要性）在 HTTP 层被拒绝且不写入', async () => {
    const item = capture('边界字段校验。');

    const tooLong = await patch(item.id, {
      expectedRevision: item.revision,
      patch: { title: '字'.repeat(300) },
    });
    expect(tooLong.status).toBe(400);

    const badImportance = await patch(item.id, {
      expectedRevision: item.revision,
      patch: { importance: 9 },
    });
    expect(badImportance.status).toBe(400);

    const after = storedRow(item.id);
    expect(after.title).toBe('');
    expect(after.revision).toBe(item.revision);
  });

  it('T019-C02 人工标签经 HTTP 写入后进入词典并可被检索到', async () => {
    const item = capture('HTTP 写入标签。');
    const response = await patch(item.id, {
      expectedRevision: item.revision,
      patch: { tags: [' HTTP标签 ', 'http标签'] },
    });

    expect(response.status).toBe(200);
    const data = (response.envelope as { ok: true; data: ItemDTO }).data;
    // 规范化去重后只剩一个，且保留首次出现的可读形式。
    expect(data.tags).toEqual(['HTTP标签']);

    const { GET } = await import('@/app/api/tags/route');
    const tags = await callRoute(GET, { method: 'GET', url: 'http://127.0.0.1:3000/api/tags?q=HTTP' });
    const listed = (tags.envelope as { ok: true; data: { tags: { label: string }[] } }).data;
    expect(listed.tags.map((tag) => tag.label)).toEqual(['HTTP标签']);
  });

  it('T077-C01 经真实仓储写入后关闭连接，重开读取到的记录与版本完全一致', async () => {
    // `database-runtime.test.ts` 已经有一条"关连接再重开"，但它走的是**手写 SQL**：
    // 那只证明磁盘路径正确，不证明仓储写出的行能被仓储重新读成同一个 DTO。
    // 内存替身不能证明磁盘路径正确，反过来，手写 SQL 也不能证明仓储与磁盘一致——
    // 两条各证一半，所以这里补的是"经过真实仓储"的那一半。
    const item = capture('关连接再重开的原文。');
    const patched = await patch(item.id, {
      expectedRevision: item.revision,
      patch: { title: '磁盘上的标题', summary: '磁盘上的摘要' },
    });
    expect(patched.status).toBe(200);
    const before = (patched.envelope as { ok: true; data: ItemDTO }).data;

    // 关掉连接：此时数据必须已经在磁盘上，而不是只在进程里的连接对象里。
    closeDb(harness.databasePath);
    db = openTestDatabase(harness.databasePath);

    const row = storedRow(item.id);
    expect(row.raw_version).toBe(before.rawVersion);
    expect(row.revision).toBe(before.revision);
    expect(row.title).toBe('磁盘上的标题');
    expect(row.summary).toBe('磁盘上的摘要');
    expect(row.captured_text).toBe('关连接再重开的原文。');

    // 经仓储重新读出来的 DTO 也与写入时的响应一致（版本不得虚增或回退）。
    const { getItemOrNull } = await import('@/server/repositories/items');
    const reread = getItemOrNull(db, item.id);
    expect(reread?.rawVersion).toBe(before.rawVersion);
    expect(reread?.revision).toBe(before.revision);
    expect(reread?.title).toBe(before.title);
  });
});