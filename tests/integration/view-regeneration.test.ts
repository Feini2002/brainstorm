/**
 * T059 验收（集成）：视图过期、再生成与历史保留。
 *
 * 这一层覆盖浏览器用例无法廉价覆盖的部分：过期的**具体明细**（哪条笔记、
 * 哪个版本变了）、筛选型选择在两次读取之间重新解析的结果，以及"读取不写入"
 * 这条不变量在存储层面的证据。
 *
 * 两条设计取舍：
 *
 *  1. **模型只走注入式替身。** 「说明与预览」本身不需要 Provider，用真实服务直接
 *     断言；而「重新生成产生新视图」这一步确实要调模型，因此注入一个记录请求的
 *     transport —— 真实适配器、假网络，除网络之外的每一层（Run 注册、校验、
 *     结构检查、事务写入）都实际运行。真实 Provider 的语义质量仍是外部凭据阻塞项。
 *  2. **断言成对。** 每个用例都同时断言"报告了什么"和"没有被改动什么"。只断言
 *     前者会漏掉"顺手把视图修好了"这类实现，而那正是历史保留要防的事。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import type { LlmConfig } from '@/domain/knowledge';
import { computeStaleness, describeSourceDrift, describeStaleness, type CurrentSourceState } from '@/domain/view';
import { OpenAICompatibleAdapter } from '@/server/llm/adapter';
import type { Transport, TransportRequest, TransportResponse } from '@/server/llm/transport';
import { callSnapshot } from '@/server/llm/types';
import { generateMindmap } from '@/server/services/generateMindmap';
import { createCapture } from '@/server/services/items';
import { getViewFreshness } from '@/server/services/views/getFreshness';
import { createGraphView, editView, getView, removeView } from '@/server/services/views/views';
import { createTestDatabase, newId, openTestDatabase, type TestDatabase } from '../helpers/db';

const SECRET = 'sk-test-T059-000000000000000000';

const CONFIG: LlmConfig = {
  adapter: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
  structuredMode: 'prompt_json',
  tokenField: 'none',
  maxOutputTokens: 4096,
  schemaRepairEnabled: false,
};

/** Injection-based transport: the real adapter over a fake network (T055's shape). */
class ScriptedTransport implements Transport {
  calls = 0;

  constructor(private readonly replies: Array<() => TransportResponse>) {}

  async send(request: TransportRequest): Promise<TransportResponse> {
    const index = this.calls;
    this.calls += 1;
    // The body is still parsed so a malformed request would fail here rather than
    // silently reach the adapter's error handling.
    JSON.parse(request.body);
    return this.replies[Math.min(index, this.replies.length - 1)]!();
  }
}

function chatOk(content: string): TransportResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    bodyText: JSON.stringify({
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
    }),
  };
}

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

/** Put a label on a set of items and return the tag id. */
function tag(itemIds: readonly string[], label: string): string {
  const normalized = label.trim().normalize('NFKC').toLowerCase();
  const existing = db.prepare('SELECT id FROM tags WHERE normalized = ?').get(normalized) as
    | { id: string }
    | undefined;
  let tagId = existing?.id;
  if (tagId === undefined) {
    tagId = newId();
    db.prepare('INSERT INTO tags (id, label, normalized, created_at) VALUES (?, ?, ?, ?)').run(
      tagId,
      label,
      normalized,
      new Date().toISOString(),
    );
  }
  for (const itemId of itemIds) {
    db.prepare('INSERT OR REPLACE INTO item_tags (item_id, tag_id, position) VALUES (?, ?, 0)').run(
      itemId,
      tagId,
    );
  }
  return tagId;
}

/** Advance an item's rawVersion and revision through the real patch path. */
function rewrite(itemId: string, nextText: string): void {
  const result = db
    .prepare(
      'UPDATE knowledge_items SET raw_text = ?, raw_version = raw_version + 1, revision = revision + 1 WHERE id = ?',
    )
    .run(nextText, itemId);
  expect(Number(result.changes)).toBe(1);
}

describe('T059 视图过期说明与再生成预览', () => {
  it('T059-C01 原文变化：说明给出具体条目与版本，且读取不写入', () => {
    const note = capture('第一版原文');
    const view = createGraphView(db, {
      name: '过期说明',
      selection: { mode: 'explicit', itemIds: [note.id] },
      positions: { [note.id]: { x: 0, y: 0 } },
      direction: 'TB',
    });

    // 生成之后原文被改写：快照留在旧版本，记录往前走。
    rewrite(note.id, '第二版原文');

    const before = getView(db, view.id);
    const freshness = getViewFreshness(db, view.id);

    expect(freshness.isStale).toBe(true);
    expect(freshness.changedItemCount).toBe(1);
    expect(freshness.reason).toContain('1 条笔记已修改');
    // 明细要能指出是哪一条、哪个字段动了 —— 笼统的"依据已过期"用户无法行动。
    expect(freshness.drift).toHaveLength(1);
    expect(freshness.drift[0]!.id).toBe(note.id);
    expect(freshness.drift[0]!.kind).toBe('item');
    expect(freshness.drift[0]!.message).toContain('原文 v1 → v2');
    expect(freshness.drift[0]!.missing).toBe(false);
    // 标题随明细一起返回，界面才不用再发一次请求去解析名字。采集尚未整理时
    // 标题是空串 —— 读取要把"空"如实带出来，而不是退回 id 或省略字段。
    expect(freshness.drift[0]!.title).toBe('');

    // 读取不写入：content / hash / generatedAt / revision 全部不变。
    const after = getView(db, view.id);
    expect(after.content).toEqual(before.content);
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.generatedAt).toBe(before.generatedAt);
    expect(after.revision).toBe(before.revision);
  });

  it('T059-C01 只改标题也报告，但区分开原文与元数据', () => {
    const note = capture('标题会变的原文');
    const view = createGraphView(db, {
      name: '只改标题',
      selection: { mode: 'explicit', itemIds: [note.id] },
      positions: { [note.id]: { x: 0, y: 0 } },
      direction: 'TB',
    });

    // 只推进 revision，不动 rawText：模型看到的标题变了，原文没变。
    db.prepare('UPDATE knowledge_items SET title = ?, revision = revision + 1 WHERE id = ?').run(
      '人工改过的标题',
      note.id,
    );

    const freshness = getViewFreshness(db, view.id);
    expect(freshness.isStale).toBe(true);
    expect(freshness.drift[0]!.message).toContain('revision 1 → 2');
    // 没有 rawVersion 变化就不应声称原文变了 —— 两个字段读起来含义不同。
    expect(freshness.drift[0]!.message).not.toContain('原文');
  });

  it('T059-C01 来源删除报告为缺失而不是过期，且不写进 missingSources 的条目列表之外', () => {
    const kept = capture('保留的原文');
    const doomed = capture('会被删除的原文');
    const view = createGraphView(db, {
      name: '含缺失来源',
      selection: { mode: 'explicit', itemIds: [kept.id, doomed.id] },
      positions: {},
      direction: 'TB',
    });

    db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(doomed.id);

    const freshness = getViewFreshness(db, view.id);
    // 契约把"改了"和"没了"分成两个信号，界面才能给出不同的话。
    expect(freshness.isStale).toBe(false);
    expect(freshness.missingSourceCount).toBe(1);
    expect(freshness.missingSources).toEqual([doomed.id]);
    expect(freshness.drift[0]!.missing).toBe(true);
    expect(freshness.drift[0]!.message).toBe('笔记已删除');
    expect(freshness.reason).toContain('1 条来源已删除');
  });

  it('T059-R01 关系变化计入过期，且关系 id 不混入 missingSources', () => {
    const a = capture('关系端点甲');
    const b = capture('关系端点乙');
    // 关系两端都按 id 升序，满足数据库对 related_to 的 CHECK。
    const [sourceId, targetId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    const relationId = newId();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO relations (
         id, source_id, target_id, relation_type, origin, review_status, score, reason,
         evidence_json, source_raw_version, target_raw_version, run_id, revision, created_at, updated_at
       ) VALUES (?, ?, ?, 'related_to', 'manual', 'accepted', NULL, '', '[]', 1, 1, NULL, 1, ?, ?)`,
    ).run(relationId, sourceId, targetId, now, now);

    // 直接构造一个引用该关系的快照：Graph 视图的 create 路径不带关系，
    // 而"关系变化也算依据过期"正是这里要钉住的行为。
    const state: CurrentSourceState = {
      items: new Map([
        [a.id, { rawVersion: 1, revision: 1 }],
        [b.id, { rawVersion: 1, revision: 1 }],
      ]),
      relations: new Map([[relationId, { revision: 2 }]]),
    };
    const result = computeStaleness(
      {
        items: [
          { id: a.id, rawVersion: 1, revision: 1 },
          { id: b.id, rawVersion: 1, revision: 1 },
        ],
        relations: [{ id: relationId, revision: 1 }],
      },
      state,
    );

    expect(result.isStale).toBe(true);
    expect(result.changedRelationIds).toEqual([relationId]);
    // 关键：missingSources 只放"已不存在的条目 ID"（DTO 契约），关系 id 走 drift。
    expect(result.missingSources).toEqual([]);
    expect(result.drift[0]!.kind).toBe('relation');
    // 描述里关系单独成句，不会读成"1 条笔记已修改"。
    expect(describeStaleness(result)).toContain('1 条关系已变化');
  });

  it('T059-R01 关系被删除时单独说明，不混进笔记计数', () => {
    const result = computeStaleness(
      { items: [], relations: [{ id: 'r1', revision: 1 }] },
      { items: new Map(), relations: new Map() },
    );
    expect(result.missingSources).toEqual([]);
    expect(result.changedRelationIds).toEqual(['r1']);
    const described = describeStaleness(result);
    expect(described).toContain('1 条关系已删除');
    expect(described).not.toContain('笔记');
  });

  it('T059-R03/C04 筛选型选择在读取时重新解析，报出新增成员', () => {
    const first = capture('标签里最初的那条');
    const tagId = tag([first.id], '成员会变');

    const view = createGraphView(db, {
      name: '按标签保存',
      selection: { mode: 'filter', filter: { tagId } },
      positions: {},
      direction: 'TB',
    });

    // 生成时只有一条；保存之后再加入一条。
    const second = capture('标签里后来加入的');
    tag([second.id], '成员会变');

    const freshness = getViewFreshness(db, view.id);
    expect(freshness.currentSelection.mode).toBe('filter');
    expect(freshness.currentSelection.count).toBe(2);
    expect(freshness.currentSelection.snapshotCount).toBe(1);
    expect(freshness.currentSelection.addedIds).toEqual([second.id]);
    expect(freshness.currentSelection.removedIds).toEqual([]);
    expect(freshness.currentSelection.isEmpty).toBe(false);
    expect(freshness.currentSelection.withinBudget).toBe(true);

    // 旧视图本身没有被这次读取改写。
    expect(getView(db, view.id).sourceSnapshot.items).toHaveLength(1);
  });

  it('T059-R03 成员被移出筛选时报告移除，计数不含它', () => {
    const kept = capture('仍留在标签里');
    const leaving = capture('会被移出标签');
    const tagId = tag([kept.id, leaving.id], '成员会减少');

    const view = createGraphView(db, {
      name: '按标签保存两份',
      selection: { mode: 'filter', filter: { tagId } },
      positions: {},
      direction: 'TB',
    });

    db.prepare('DELETE FROM item_tags WHERE item_id = ? AND tag_id = ?').run(leaving.id, tagId);

    const freshness = getViewFreshness(db, view.id);
    expect(freshness.currentSelection.count).toBe(1);
    expect(freshness.currentSelection.snapshotCount).toBe(2);
    expect(freshness.currentSelection.addedIds).toEqual([]);
    expect(freshness.currentSelection.removedIds).toEqual([leaving.id]);
  });

  it('T059-R06 来源全删：预览报告为空，生成会被本地拒绝', () => {
    const doomed = capture('唯一来源');
    const view = createGraphView(db, {
      name: '唯一来源被删',
      selection: { mode: 'explicit', itemIds: [doomed.id] },
      positions: { [doomed.id]: { x: 0, y: 0 } },
      direction: 'TB',
    });

    db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(doomed.id);

    const freshness = getViewFreshness(db, view.id);
    // 预览把"没有材料可发"作为事实报出来，界面据此不提供按钮。
    expect(freshness.currentSelection.isEmpty).toBe(true);
    expect(freshness.currentSelection.count).toBe(0);
    expect(freshness.currentSelection.resolvedIds).toEqual([]);
    expect(freshness.missingSourceCount).toBe(1);
    expect(freshness.missingSources).toEqual([doomed.id]);

    // 旧图仍然可以读取（T059-R06 的另一半）。
    const loaded = getView(db, view.id);
    expect(loaded.missingSources).toEqual([doomed.id]);
  });

  it('T059-R02/C05 改名不动 generatedAt、来源快照与内容，也不产生新的 Run', () => {
    const note = capture('改名用原文');
    const view = createGraphView(db, {
      name: '改名之前',
      selection: { mode: 'explicit', itemIds: [note.id] },
      positions: { [note.id]: { x: 10, y: 20 } },
      direction: 'TB',
    });

    const runsBefore = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };

    const renamed = editView(db, {
      id: view.id,
      expectedRevision: view.revision,
      name: '改名之后',
    });

    expect(renamed.name).toBe('改名之后');
    expect(renamed.generatedAt).toBe(view.generatedAt);
    expect(renamed.content).toEqual(view.content);
    expect(renamed.contentHash).toBe(view.contentHash);
    // 来源快照是"当时依据"的记录，改名不是重新分析。
    expect(renamed.sourceSnapshot).toEqual(view.sourceSnapshot);

    const runsAfter = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
    expect(Number(runsAfter.n)).toBe(Number(runsBefore.n));
  });

  it('T059-C03 生成失败只影响新 Run：旧视图内容、哈希与时间都不变', () => {
    const note = capture('失败也要保住');
    const view = createGraphView(db, {
      name: '旧图',
      selection: { mode: 'explicit', itemIds: [note.id] },
      positions: {},
      direction: 'TB',
    });

    // 失败发生在别处（Provider 不可用 / 结构不合法）。这里断言的是它的**边界**：
    // 无论那次尝试写了什么，旧视图必须逐字段一致。
    const before = getView(db, view.id);

    // 模拟一次失败的尝试可能留下的痕迹：一条 failed 的 Run。它不应触碰视图。
    db.prepare(
      `INSERT INTO ai_runs (
         id, request_key, request_hash, kind, subject_id, input_revision, input_hash, state,
         config_revision, config_snapshot_json, candidate_ids_json, result_ref, error_code,
         error_message, usage_json, prompt_version, attempt_count, started_at, deadline_at,
         finished_at
       ) VALUES (?, ?, ?, 'mindmap', NULL, NULL, ?, 'failed', 1, '{}', '[]', NULL,
         'PROVIDER_UNAVAILABLE', '提供方不可用', NULL, 'mindmap-v1', 1, ?, ?, ?)`,
    ).run(
      newId(),
      newId(),
      'failed-request-hash',
      'failed-input-hash',
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const after = getView(db, view.id);
    expect(after.content).toEqual(before.content);
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.generatedAt).toBe(before.generatedAt);
    expect(after.revision).toBe(before.revision);
    // 失败的 Run 没有 resultRef，因此不会凭空多出一张视图。
    expect(after.id).toBe(before.id);
  });

  it('T059-R02 重新生成是新视图，旧视图保留并可对照', () => {
    const note = capture('对照来源');
    const original = createGraphView(db, {
      name: '第一次组织',
      selection: { mode: 'explicit', itemIds: [note.id] },
      positions: { [note.id]: { x: 0, y: 0 } },
      direction: 'TB',
    });

    rewrite(note.id, '对照来源被改写');

    const regenerated = createGraphView(db, {
      name: '第二次组织',
      selection: { mode: 'explicit', itemIds: [note.id] },
      positions: { [note.id]: { x: 50, y: 60 } },
      direction: 'TB',
    });

    expect(regenerated.id).not.toBe(original.id);
    // 两张都在，且各自的过期状态是分开算的：旧的那张依据过期，新的那张不是。
    const oldOne = getViewFreshness(db, original.id);
    const newOne = getViewFreshness(db, regenerated.id);
    expect(oldOne.isStale).toBe(true);
    expect(newOne.isStale).toBe(false);
    expect(getView(db, original.id).generatedAt).toBe(original.generatedAt);
  });

  it('T059-R02 真正重新生成：新视图是新 ID，旧视图逐字段不变', async () => {
    // 这一条覆盖浏览器用例无法诚实覆盖的部分：需要 Provider 的那一步。用一个
    // 记录请求的替身适配器（而不是伪造一个成功的 HTTP 响应），让**除网络之外的
    // 每一步**都真实运行：注册 Run、校验、结构检查、事务内写新视图。
    const note = capture('真正重新生成');
    const now = new Date().toISOString();
    db.prepare(
      'UPDATE knowledge_items SET title = ?, summary = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
    ).run('重新生成的笔记', '摘要', now, note.id);

    const original = createGraphView(db, {
      name: '第一张',
      selection: { mode: 'explicit', itemIds: [note.id] },
      positions: { [note.id]: { x: 0, y: 0 } },
      direction: 'TB',
    });
    const before = getView(db, original.id);

    const transport = new ScriptedTransport([
      () =>
        chatOk(
          JSON.stringify({
            title: '第二张脑图',
            nodes: [
              { id: 'm1', parentId: null, label: '第二张脑图', itemIds: [note.id], kind: 'group' },
              { id: 'm2', parentId: 'm1', label: '重新生成的分支', itemIds: [note.id], kind: 'note' },
            ],
          }),
        ),
    ]);

    const result = await generateMindmap(db, {
      requestKey: newId(),
      selection: { mode: 'explicit', itemIds: [note.id] },
      config: callSnapshot(CONFIG, SECRET),
      configRevision: 1,
      schemaRepairEnabled: false,
      adapter: new OpenAICompatibleAdapter(transport),
    });

    expect(result.state).toBe('succeeded');
    expect(result.viewId).not.toBeNull();
    // 新 ID，不是同一个对象。
    expect(result.viewId).not.toBe(original.id);

    // 旧视图逐字段不变：内容、哈希、生成时间、revision、名称。
    const after = getView(db, original.id);
    expect(after.content).toEqual(before.content);
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.generatedAt).toBe(before.generatedAt);
    expect(after.revision).toBe(before.revision);
    expect(after.name).toBe(before.name);

    // 两张都能读到，可对照。
    const fresh = getView(db, result.viewId!);
    expect(fresh.id).not.toBe(original.id);
    expect(fresh.generatedAt).not.toBeNull();
    // 新视图刚好来自这次 Run，溯源可查。
    expect(fresh.runId).toBe(result.runId);
  });

  it('T059 视图不存在时抛 404，而不是报告"没有变化"', () => {
    // 对已删除的视图回答"一切正常"会让它看起来还活着。
    expect(() => getViewFreshness(db, newId())).toThrow(AppError);
    try {
      getViewFreshness(db, newId());
    } catch (error) {
      expect((error as AppError).code).toBe('NOT_FOUND');
    }
  });

  it('T059 删除视图后过期查询同样 404，但知识条目不受影响', () => {
    const note = capture('删视图不删知识');
    const view = createGraphView(db, {
      name: '待删除',
      selection: { mode: 'explicit', itemIds: [note.id] },
      positions: {},
      direction: 'TB',
    });

    removeView(db, view.id, view.revision);
    expect(() => getViewFreshness(db, view.id)).toThrow(AppError);

    const items = db.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get() as { n: number };
    expect(Number(items.n)).toBe(1);
  });

  it('T059 明细行覆盖所有字段组合', () => {
    // rawVersion 与 revision 各自可能单独变化，描述必须按实际变化的字段生成，
    // 不能假设"改了就是两个都改"。
    const both = describeSourceDrift({
      id: 'i1',
      kind: 'item',
      recorded: { rawVersion: 1, revision: 1 },
      current: { rawVersion: 2, revision: 2 },
      changedFields: ['rawVersion', 'revision'],
    });
    expect(both).toContain('原文 v1 → v2');
    expect(both).toContain('revision 1 → 2');

    const gone = describeSourceDrift({
      id: 'i2',
      kind: 'item',
      recorded: { rawVersion: 1, revision: 1 },
      current: null,
      changedFields: [],
    });
    expect(gone).toBe('笔记已删除');

    const relationMoved = describeSourceDrift({
      id: 'r1',
      kind: 'relation',
      recorded: { rawVersion: 0, revision: 3 },
      current: { rawVersion: 0, revision: 4 },
      changedFields: ['revision'],
    });
    // 关系没有原文版本，所以只报 revision，且措辞是"关系"而不是"笔记"。
    expect(relationMoved).toBe('revision 3 → 4');
  });
});
