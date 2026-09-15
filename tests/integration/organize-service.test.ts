/**
 * T036 验收用例｜整理主流程与事务切点
 *
 * 这一组用例证明的不是「整理能跑通」，而是**失败时用户的东西还在**：
 * 原文先落库、网络不占数据库锁、模型期间用户改动不被旧结果覆盖、提交中途
 * 失败不留半条整理、目标被删除不被重建。
 *
 * 全部使用注入式 transport（真实适配器 + 假网络），断言同时覆盖 Run 账本与
 * 数据库实体。不连真实域名。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import { LIMITS } from '@/domain/limits';
import type { LlmConfig } from '@/domain/knowledge';
import { OpenAICompatibleAdapter } from '@/server/llm/adapter';
import type { Transport, TransportRequest, TransportResponse } from '@/server/llm/transport';
import { callSnapshot } from '@/server/llm/types';
import { createCapture, patchItem } from '@/server/services/items';
import { organizeItem } from '@/server/services/organizeItem';
import { findRunByRequestKey } from '@/server/repositories/runs';
import { createTestDatabase, openTestDatabase, newId, type TestDatabase } from '../helpers/db';

const SECRET = 'sk-test-ORGANIZE-0000000000000000';
const TARGET_TEXT = '听同事说，用番茄工作法可能能提高专注度，我还没试过。';

const CONFIG: LlmConfig = {
  adapter: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
  structuredMode: 'prompt_json',
  tokenField: 'none',
  maxOutputTokens: 4096,
  // 默认档位：格式修复关。C05 另行开启。
  schemaRepairEnabled: false,
};

/** 成功但需要被证据校验的整理结果；relation 由各用例自行裁剪。 */
function organizedJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: '番茄工作法的传闻',
    summary: '同事提到番茄工作法可能有助于专注，尚未验证。',
    type: 'idea',
    tags: ['时间管理', '专注'],
    keywords: ['番茄工作法', '专注度'],
    importance: 3,
    relations: [],
    ...overrides,
  });
}

interface ScriptedOptions {
  /** 每次请求返回什么；下标是调用序号。 */
  replies: Array<() => TransportResponse>;
  /** 每次请求前的钩子，用来模拟「模型期间用户改了东西」。 */
  beforeReply?: (call: number) => void;
  /** 模拟请求被延迟挂起，用来证明网络期间数据库仍可写。 */
  onSend?: (call: number) => Promise<void> | void;
}

class ScriptedTransport implements Transport {
  calls = 0;
  readonly bodies: string[] = [];

  constructor(private readonly options: ScriptedOptions) {}

  async send(request: TransportRequest): Promise<TransportResponse> {
    const index = this.calls;
    this.calls += 1;
    this.bodies.push(request.body);
    await this.options.onSend?.(index);
    this.options.beforeReply?.(index);
    const reply = this.options.replies[Math.min(index, this.options.replies.length - 1)];
    return reply();
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

function chatError(message: string, status = 500): TransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    bodyText: JSON.stringify({ error: { message } }),
  };
}

let test: TestDatabase;
let db: DatabaseSync;

beforeEach(() => {
  test = createTestDatabase();
  db = openTestDatabase(test.databasePath);
});

afterEach(() => {
  test.cleanup();
});

function seedTarget(rawText = TARGET_TEXT) {
  return createCapture(db, {
    captureRequestId: newId(),
    rawText,
    sourceType: 'myself',
    sourceRef: null,
  }).item;
}

function seedOther(rawText: string, title = '') {
  const item = createCapture(db, {
    captureRequestId: newId(),
    rawText,
    sourceType: 'myself',
    sourceRef: null,
  }).item;
  if (title.length === 0) return item;
  // 通过正常编辑路径设置标题，避免直接写列绕过领域规则。
  const updated = patchItem(db, {
    id: item.id,
    expectedRevision: item.revision,
    patch: { title, summary: '关于专注与效率的旧笔记' },
  });
  return updated;
}

function organize(input: {
  itemId: string;
  expectedRevision: number;
  requestKey?: string;
  transport: Transport;
  schemaRepairEnabled?: boolean;
}) {
  return organizeItem(db, {
    requestKey: input.requestKey ?? newId(),
    itemId: input.itemId,
    expectedRevision: input.expectedRevision,
    config: callSnapshot(CONFIG, SECRET),
    configRevision: 1,
    schemaRepairEnabled: input.schemaRepairEnabled ?? false,
    adapter: new OpenAICompatibleAdapter(input.transport),
  });
}

describe('T036 整理主流程', () => {
  it('T036-C01 模型立即失败时，原文与采集结果都还在', async () => {
    const target = seedTarget();
    const transport = new ScriptedTransport({ replies: [() => chatError('upstream exploded')] });

    const caught = await organize({
      itemId: target.id,
      expectedRevision: target.revision,
      transport,
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(AppError);

    // 采集结果必须原封不动：AI 失败不能回滚已经保存的原文。
    const row = db
      .prepare('SELECT raw_text, raw_version, revision, captured_text FROM knowledge_items WHERE id = ?')
      .get(target.id) as {
      raw_text: string;
      raw_version: number;
      revision: number;
      captured_text: string;
    };
    expect(row.raw_text).toBe(TARGET_TEXT);
    expect(row.captured_text).toBe(TARGET_TEXT);
    expect(row.raw_version).toBe(1);
    expect(row.revision).toBe(target.revision);

    // Run 是失败终态，并且带了可解释的错误码，而不是留在 running。
    const run = db
      .prepare('SELECT state, error_code, finished_at FROM ai_runs WHERE subject_id = ?')
      .get(target.id) as { state: string; error_code: string | null; finished_at: string | null };
    expect(run.state).toBe('failed');
    expect(run.error_code).not.toBeNull();
    expect(run.finished_at).not.toBeNull();
  });

  it('T036-C02 模型请求进行中不占用数据库锁，其他笔记照常保存', async () => {
    const target = seedTarget();

    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const transport = new ScriptedTransport({
      replies: [() => chatOk(organizedJson())],
      // 请求「挂起」在网络阶段，此时锁必须已经释放。
      onSend: () => gate,
    });

    const pending = organize({
      itemId: target.id,
      expectedRevision: target.revision,
      transport,
    });

    // 等 transport 真的进来了，确认此刻仍能写库。
    while (transport.calls === 0) await new Promise((resolve) => setTimeout(resolve, 0));

    const running = db
      .prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE state = 'running'")
      .get() as { n: number };
    expect(running.n).toBe(1);

    // 关键断言：模型在飞的时候保存另一条新笔记必须成功，不能等数据库锁。
    const saved = createCapture(db, {
      captureRequestId: newId(),
      rawText: '模型还在跑的时候我随手记的一条。',
      sourceType: 'myself',
      sourceRef: null,
    });
    expect(saved.item.id).toBeTruthy();

    release();
    const result = await pending;
    expect(result.state).toBe('succeeded');
  });

  it('T036-C03 模型期间用户改了原文，Run 进入 conflict 且人工新版不变', async () => {
    const target = seedTarget();
    const editedText = '我把这条改成了：番茄工作法我已经试过三天，确实有效。';

    const transport = new ScriptedTransport({
      replies: [() => chatOk(organizedJson())],
      // 模型返回之前，用户已经保存了新版本。
      beforeReply: () => {
        patchItem(db, {
          id: target.id,
          expectedRevision: target.revision,
          patch: { rawText: editedText },
        });
      },
    });

    const result = await organize({
      itemId: target.id,
      expectedRevision: target.revision,
      transport,
    });

    expect(result.state).toBe('conflict');

    // 旧结果不得覆盖用户的新输入——这是数据损坏与版本冲突的分界。
    const row = db
      .prepare('SELECT raw_text, title, summary, structured_base_raw_version FROM knowledge_items WHERE id = ?')
      .get(target.id) as {
      raw_text: string;
      title: string;
      summary: string;
      structured_base_raw_version: number | null;
    };
    expect(row.raw_text).toBe(editedText);
    expect(row.title).toBe('');
    expect(row.summary).toBe('');
    expect(row.structured_base_raw_version).toBeNull();

    const run = db
      .prepare('SELECT state, error_code, error_message FROM ai_runs WHERE subject_id = ?')
      .get(target.id) as { state: string; error_code: string | null; error_message: string | null };
    expect(run.state).toBe('conflict');
    expect(run.error_message).toContain('修改');
  });

  it('T036-C04 提交阶段标签写入失败时，元数据、关系与 Run 成功标记一起回滚', async () => {
    const target = seedTarget();
    const other = seedOther('关于专注力的旧笔记：番茄钟、时间块都试过。', '专注力练习');

    // 建一条真实可引用的建议；关系要真的会被写入，才能证明回滚。
    const goodRelation = {
      targetId: other.id,
      type: 'related_to',
      reason: '都涉及专注方法',
      score: 0.85,
      evidence: [
        { itemId: target.id, quote: '提高专注度' },
        { itemId: other.id, quote: '专注力练习' },
      ],
    };

    const transport = new ScriptedTransport({
      replies: [() => chatOk(organizedJson({ relations: [goodRelation] }))],
    });

    // 在标签写入的正常路径上注入故障：标签表被删除，setItemTags 必然抛错。
    // 这比 mock 掉整个函数更接近「提交中途失败」的真实形态。
    const original = db.prepare.bind(db);
    let armed = true;
    db.prepare = ((sql: string) => {
      if (armed && typeof sql === 'string' && /INSERT INTO item_tags/u.test(sql)) {
        armed = false;
        throw new Error('CHECK constraint failed: simulated tag write failure');
      }
      return original(sql);
    }) as typeof db.prepare;

    const caught = await organize({
      itemId: target.id,
      expectedRevision: target.revision,
      transport,
    }).catch((error: unknown) => error);

    db.prepare = original as typeof db.prepare;

    expect(caught).toBeInstanceOf(AppError);

    // 元数据没有半条：标题/摘要保持空，structured base 保持 NULL。
    const row = db
      .prepare('SELECT title, summary, structured_base_raw_version FROM knowledge_items WHERE id = ?')
      .get(target.id) as { title: string; summary: string; structured_base_raw_version: number | null };
    expect(row.title).toBe('');
    expect(row.summary).toBe('');
    expect(row.structured_base_raw_version).toBeNull();

    // 关系没有半条。
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM relations').get() as { n: number }).n,
    ).toBe(0);

    // Run 不是 succeeded；失败原因单独短事务写入，账本仍然真实。
    const run = db
      .prepare('SELECT state FROM ai_runs WHERE subject_id = ?')
      .get(target.id) as { state: string };
    expect(run.state).toBe('failed');
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE state = 'running'").get() as { n: number }).n,
    ).toBe(0);
  });

  it('T036-C05 模型期间目标被删除，迟到响应不重建记录', async () => {
    const target = seedTarget();

    const transport = new ScriptedTransport({
      replies: [() => chatOk(organizedJson())],
      beforeReply: () => {
        db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(target.id);
      },
    });

    const result = await organize({
      itemId: target.id,
      expectedRevision: target.revision,
      transport,
    });

    // 删除是用户决定，必须可依赖：同 ID 的记录不得被 INSERT 回来。
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM knowledge_items WHERE id = ?').get(target.id) as {
        n: number;
      }).n,
    ).toBe(0);
    expect(result.state).toBe('conflict');
    expect(result.item).toBeNull();

    const run = db
      .prepare('SELECT state, error_code FROM ai_runs WHERE subject_id = ?')
      .get(target.id) as { state: string; error_code: string | null };
    expect(run.state).toBe('conflict');
    expect(run.error_code).toBe('SOURCE_CHANGED');
  });

  it('T036-C06 请求完成前一直等待，Run 状态可独立查询而不承诺后台完成', async () => {
    const target = seedTarget();
    const requestKey = newId();

    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const transport = new ScriptedTransport({
      replies: [() => chatOk(organizedJson())],
      onSend: () => gate,
    });

    const pending = organize({
      itemId: target.id,
      expectedRevision: target.revision,
      requestKey,
      transport,
    });

    // 页面「关掉再打开」能查到的东西：一条 running 的 Run，而不是队列承诺。
    while (transport.calls === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const whileRunning = findRunByRequestKey(db, requestKey);
    expect(whileRunning?.state).toBe('running');

    release();
    const result = await pending;
    expect(result.state).toBe('succeeded');

    // 终态之后，同一个键读到的就是结果本身。
    const after = findRunByRequestKey(db, requestKey);
    expect(after?.state).toBe('succeeded');
  });
});

describe('T036 规则落点', () => {
  it('T036-R01 未配置连接时明确报错且不动原文', async () => {
    const target = seedTarget();
    const transport = new ScriptedTransport({ replies: [() => chatOk(organizedJson())] });

    const caught = await organizeItem(db, {
      requestKey: newId(),
      itemId: target.id,
      expectedRevision: target.revision,
      // 缺 Key 与 Base URL 的调用快照。
      config: callSnapshot({ ...CONFIG, baseUrl: '' }, ''),
      configRevision: 0,
      schemaRepairEnabled: false,
      adapter: new OpenAICompatibleAdapter(transport),
    }).catch((error: unknown) => error);

    expect((caught as AppError).code).toBe('MODEL_NOT_CONFIGURED');
    // 连一次请求都没发出去。
    expect(transport.calls).toBe(0);
    const row = db.prepare('SELECT raw_text FROM knowledge_items WHERE id = ?').get(target.id) as {
      raw_text: string;
    };
    expect(row.raw_text).toBe(TARGET_TEXT);
  });

  it('T036-R01 revision 不符时在注册前就拒绝，不占用槽位', async () => {
    const target = seedTarget();
    const transport = new ScriptedTransport({ replies: [() => chatOk(organizedJson())] });

    const caught = await organize({
      itemId: target.id,
      expectedRevision: target.revision + 5,
      transport,
    }).catch((error: unknown) => error);

    expect((caught as AppError).code).toBe('REVISION_CONFLICT');
    expect(transport.calls).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number }).n,
    ).toBe(0);
  });

  it('T036-R02 请求正文里没有 Key，Run 里也没有', async () => {
    const target = seedTarget();
    const transport = new ScriptedTransport({ replies: [() => chatOk(organizedJson())] });

    await organize({
      itemId: target.id,
      expectedRevision: target.revision,
      transport,
    });

    const sent = transport.bodies.join('\n');
    expect(sent).not.toContain(SECRET);
    expect(sent).not.toContain('Authorization');

    const run = db
      .prepare('SELECT config_snapshot_json FROM ai_runs WHERE subject_id = ?')
      .get(target.id) as { config_snapshot_json: string };
    expect(run.config_snapshot_json).not.toContain(SECRET);
    expect(run.config_snapshot_json).not.toContain('apiKey');
  });

  it('T036-R04 成功提交后元数据、标签、关系与 Run 终态一起可见', async () => {
    const target = seedTarget();
    const other = seedOther('这是一条关于时间管理的旧资料。', '时间管理');

    const transport = new ScriptedTransport({
      replies: [
        () =>
          chatOk(
            organizedJson({
              relations: [
                {
                  targetId: other.id,
                  type: 'related_to',
                  reason: '都和时间管理有关',
                  score: 0.8,
                  evidence: [
                    { itemId: target.id, quote: '番茄工作法' },
                    { itemId: other.id, quote: '时间管理' },
                  ],
                },
              ],
            }),
          ),
      ],
    });

    const result = await organize({
      itemId: target.id,
      expectedRevision: target.revision,
      transport,
    });

    expect(result.state).toBe('succeeded');
    expect(result.relationsCreated).toBe(1);

    const item = db
      .prepare(
        `SELECT title, summary, type, keywords_json, structured_base_raw_version
           FROM knowledge_items WHERE id = ?`,
      )
      .get(target.id) as {
      title: string;
      summary: string;
      type: string;
      keywords_json: string;
      structured_base_raw_version: number;
    };
    expect(item.title).toBe('番茄工作法的传闻');
    expect(item.type).toBe('idea');
    expect(item.structured_base_raw_version).toBe(1);

    const tags = db
      .prepare(
        `SELECT t.label AS label FROM item_tags it JOIN tags t ON t.id = it.tag_id
          WHERE it.item_id = ? ORDER BY it.position`,
      )
      .all(target.id) as { label: string }[];
    expect(tags.map((row) => row.label)).toEqual(['时间管理', '专注']);

    const relation = db
      .prepare('SELECT origin, review_status, score, run_id FROM relations')
      .get() as { origin: string; review_status: string; score: number; run_id: string };
    // AI 建议一律是待确认状态，绝不自带 accepted。
    expect(relation.origin).toBe('ai');
    expect(relation.review_status).toBe('suggested');
    expect(relation.score).toBeCloseTo(0.8);
    expect(relation.run_id).toBe(result.runId);

    // 成功的 Run 必须记录 usage，且 attempt_count 只有一次主调用。
    const run = db
      .prepare('SELECT state, usage_json, attempt_count FROM ai_runs WHERE id = ?')
      .get(result.runId) as { state: string; usage_json: string; attempt_count: number };
    expect(run.state).toBe('succeeded');
    expect(run.attempt_count).toBe(1);
    expect(JSON.parse(run.usage_json)).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      totalTokens: 160,
    });
  });

  it('T036-R03 所有字段都被人工锁定时不覆盖，但 Run 仍以成功终结', async () => {
    const target = seedTarget();
    // 用正常编辑路径把六个字段全部锁定。
    const locked = patchItem(db, {
      id: target.id,
      expectedRevision: target.revision,
      patch: {
        title: '我自己写的标题',
        summary: '我自己写的摘要',
        type: 'observation',
        tags: ['我的标签'],
        keywords: ['我的关键词'],
        importance: 5,
      },
    });
    expect(locked.manualFields).toHaveLength(6);

    const transport = new ScriptedTransport({ replies: [() => chatOk(organizedJson())] });
    const result = await organize({
      itemId: target.id,
      expectedRevision: locked.revision,
      transport,
    });

    expect(result.state).toBe('succeeded');
    const item = db
      .prepare('SELECT title, summary, type, importance FROM knowledge_items WHERE id = ?')
      .get(target.id) as { title: string; summary: string; type: string; importance: number };
    expect(item.title).toBe('我自己写的标题');
    expect(item.summary).toBe('我自己写的摘要');
    expect(item.type).toBe('observation');
    expect(item.importance).toBe(5);
    expect(result.warnings.join('')).toContain('手动');
  });

  it('T036-R05 同键重放直接复用存储结果，不再产生第二次请求', async () => {
    const target = seedTarget();
    const requestKey = newId();
    // 第一次整理成功后，该条目的 revision 已经被提交事务推进。
    const transport = new ScriptedTransport({ replies: [() => chatOk(organizedJson())] });

    const first = await organize({
      itemId: target.id,
      expectedRevision: target.revision,
      requestKey,
      transport,
    });

    const bumped = db.prepare('SELECT revision FROM knowledge_items WHERE id = ?').get(target.id) as {
      revision: number;
    };
    expect(bumped.revision).toBeGreaterThan(target.revision);

    // 重放必须发生在 revision 校验之前：否则用户重发同一个键就会被自己的
    // 上一次提交顶成 409，而契约要求直接复用既有结果。
    const second = await organize({
      itemId: target.id,
      expectedRevision: target.revision,
      requestKey,
      transport,
    });

    expect(transport.calls).toBe(1);
    expect(second.replayed).toBe(true);
    expect(second.runId).toBe(first.runId);
  });

  it('T036-R05 换了请求键但 revision 过期时仍返回 409，不被误当成重放', async () => {
    const target = seedTarget();
    const transport = new ScriptedTransport({ replies: [() => chatOk(organizedJson())] });

    await organize({
      itemId: target.id,
      expectedRevision: target.revision,
      transport,
    });

    // 新键 = 新的整理意图，必须按正常 CAS 校验拒绝过期的 revision。
    const caught = await organize({
      itemId: target.id,
      expectedRevision: target.revision,
      transport,
    }).catch((error: unknown) => error);

    expect((caught as AppError).code).toBe('REVISION_CONFLICT');
    expect(transport.calls).toBe(1);
  });

  it('T036-R05 迟到响应发现 Run 已被中断时丢弃结果', async () => {
    const target = seedTarget();

    const transport = new ScriptedTransport({
      replies: [() => chatOk(organizedJson())],
      beforeReply: () => {
        // 模拟恢复机制在响应到达前把租约收走。
        db.prepare(
          `UPDATE ai_runs SET state = 'interrupted', finished_at = ?
            WHERE subject_id = ? AND state = 'running'`,
        ).run(new Date().toISOString(), target.id);
      },
    });

    const result = await organize({
      itemId: target.id,
      expectedRevision: target.revision,
      transport,
    });

    expect(result.state).toBe('conflict');
    // 终态不回活，整理字段也没有写入。
    const row = db
      .prepare('SELECT title, structured_base_raw_version FROM knowledge_items WHERE id = ?')
      .get(target.id) as { title: string; structured_base_raw_version: number | null };
    expect(row.title).toBe('');
    expect(row.structured_base_raw_version).toBeNull();

    const run = db
      .prepare('SELECT state FROM ai_runs WHERE subject_id = ?')
      .get(target.id) as { state: string };
    expect(run.state).toBe('interrupted');
  });

  it('T036-R06 整理失败后旧的可读整理结果不被清空', async () => {
    const target = seedTarget();
    const other = seedOther('一条旧资料，用来让候选集非空。');

    const good = new ScriptedTransport({ replies: [() => chatOk(organizedJson())] });
    await organize({
      itemId: target.id,
      expectedRevision: target.revision,
      transport: good,
    });

    // 第二次整理：原文未变，但模型这次彻底失败。
    const current = db
      .prepare('SELECT revision, title, summary FROM knowledge_items WHERE id = ?')
      .get(target.id) as { revision: number; title: string; summary: string };
    expect(current.title).toBe('番茄工作法的传闻');

    const bad = new ScriptedTransport({ replies: [() => chatError('quota exhausted', 429)] });
    const caught = await organize({
      itemId: target.id,
      expectedRevision: current.revision,
      transport: bad,
    }).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AppError);

    // 旧结果仍在：一次失败不该把可用的整理结果擦掉。
    const after = db
      .prepare('SELECT title, summary, raw_text FROM knowledge_items WHERE id = ?')
      .get(target.id) as { title: string; summary: string; raw_text: string };
    expect(after.title).toBe('番茄工作法的传闻');
    expect(after.summary).toBe('同事提到番茄工作法可能有助于专注，尚未验证。');
    expect(after.raw_text).toBe(TARGET_TEXT);

    void other;
  });

  it('T036-R03 关系引用未知条目时被丢弃，元数据仍然成功', async () => {
    const target = seedTarget();
    const other = seedOther('关于睡眠与专注的旧资料。');

    const transport = new ScriptedTransport({
      replies: [
        () =>
          chatOk(
            organizedJson({
              relations: [
                {
                  // 模型编造了一个没发送过的 id。
                  targetId: newId(),
                  type: 'related_to',
                  reason: '凭空捏造',
                  score: 0.9,
                  evidence: [{ itemId: target.id, quote: '番茄工作法' }],
                },
                {
                  targetId: other.id,
                  type: 'related_to',
                  reason: '引用不存在于原文',
                  score: 0.9,
                  evidence: [{ itemId: target.id, quote: '这段文字原文里没有' }],
                },
              ],
            }),
          ),
      ],
    });

    const result = await organize({
      itemId: target.id,
      expectedRevision: target.revision,
      transport,
    });

    // 两条都进不来：一条越权，一条证据不逐字存在。
    expect(result.state).toBe('succeeded');
    expect(result.relationsCreated).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM relations').get() as { n: number }).n).toBe(0);
    // 元数据不受关系失效影响。
    const item = db
      .prepare('SELECT title FROM knowledge_items WHERE id = ?')
      .get(target.id) as { title: string };
    expect(item.title).toBe('番茄工作法的传闻');
  });

  it('T036-R05 只有一次主调用，草稿关闭修复时不追加第二次请求', async () => {
    const target = seedTarget();
    // 完整返回但不是合法 JSON：可修复形态，但草稿关掉了修复。
    const transport = new ScriptedTransport({
      replies: [() => chatOk('这里是整理结果：{"title": "缺字段的"')],
    });

    const caught = await organize({
      itemId: target.id,
      expectedRevision: target.revision,
      transport,
      schemaRepairEnabled: false,
    }).catch((error: unknown) => error);

    expect((caught as AppError).code).toBe('STRUCTURED_INVALID');
    expect(transport.calls).toBe(1);
    expect(LIMITS.schemaRepairAttempts).toBe(1);
  });

  it('T036-R02 开启修复时最多两次请求，且第二次不携带新资料', async () => {
    const target = seedTarget();
    seedOther('一条与本次整理无关的旧资料，用来验证修复消息不会追加它。');

    const transport = new ScriptedTransport({
      replies: [
        () => chatOk('整理结果如下：{"title": "缺字段"'),
        () => chatOk(organizedJson()),
      ],
    });

    const result = await organize({
      itemId: target.id,
      expectedRevision: target.revision,
      transport,
      schemaRepairEnabled: true,
    });

    expect(transport.calls).toBe(2);
    expect(result.state).toBe('succeeded');

    const repairBody = transport.bodies[1];
    // 修复消息只带上一次的输出与错误摘要，不重新装载候选资料。
    expect(repairBody).toContain('PREVIOUS OUTPUT');
    expect(repairBody).not.toContain('无关的旧资料');

    const run = db
      .prepare('SELECT attempt_count FROM ai_runs WHERE id = ?')
      .get(result.runId) as { attempt_count: number };
    expect(run.attempt_count).toBe(2);
  });
});
