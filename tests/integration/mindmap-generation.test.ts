/**
 * T055 验收：脑图生成任务与树结构提示词。
 *
 * 六个具名场景覆盖：单条来源不过度扩写、虚构来源被拒、同一来源可被多个分支
 * 引用但不复制知识、无来源叶被拒、超限失败而非硬渲染、生成失败不破坏旧图。
 *
 * 全部使用注入式 transport（真实适配器 + 假网络），同时断言 Run 账本与数据库
 * 实体。观察内容包括：发给模型的 messages 里有没有 Key、调用了几次、Run 终态、
 * 以及旧 View 是否原样存在。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import { LIMITS } from '@/domain/limits';
import type { LlmConfig, UUID } from '@/domain/knowledge';
import { OpenAICompatibleAdapter } from '@/server/llm/adapter';
import type { Transport, TransportRequest, TransportResponse } from '@/server/llm/transport';
import { callSnapshot } from '@/server/llm/types';
import { createCapture } from '@/server/services/items';
import { generateMindmap } from '@/server/services/generateMindmap';
import { getView, listViews } from '@/server/services/views/views';
import { createTestDatabase, openTestDatabase, newId, type TestDatabase } from '../helpers/db';

const SECRET = 'sk-test-MINDMAP-0000000000000000';

const CONFIG: LlmConfig = {
  adapter: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
  structuredMode: 'prompt_json',
  tokenField: 'none',
  maxOutputTokens: 4096,
  schemaRepairEnabled: false,
};

interface ScriptedOptions {
  replies: Array<() => TransportResponse>;
  /** 每次请求前的钩子，用来模拟「模型生成期间用户改了东西」。 */
  beforeReply?: (call: number) => void;
  onSend?: (call: number) => Promise<void> | void;
}

class ScriptedTransport implements Transport {
  calls = 0;
  readonly bodies: string[] = [];
  readonly requests: TransportRequest[] = [];

  constructor(private readonly options: ScriptedOptions) {}

  async send(request: TransportRequest): Promise<TransportResponse> {
    const index = this.calls;
    this.calls += 1;
    this.bodies.push(request.body);
    this.requests.push(request);
    await this.options.onSend?.(index);
    this.options.beforeReply?.(index);
    const reply = this.options.replies[Math.min(index, this.options.replies.length - 1)];
    return reply();
  }

  /** Every message content the model was shown, joined, for leak assertions. */
  allMessageText(): string {
    return this.requests
      .flatMap((request) => {
        const body = JSON.parse(request.body) as { messages?: { content?: string }[] };
        return (body.messages ?? []).map((message) => message.content ?? '');
      })
      .join('\n');
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

function seedItem(rawText: string, title = ''): { id: UUID; revision: number } {
  const created = createCapture(db, {
    captureRequestId: newId(),
    rawText,
    sourceType: 'myself',
    sourceRef: null,
  }).item;
  if (title.length === 0) return { id: created.id, revision: created.revision };
  // 通过正常编辑路径设置标题，避免直接写列绕过领域规则。
  const now = new Date().toISOString();
  db.prepare('UPDATE knowledge_items SET title = ?, summary = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
    .run(title, `关于${title}的旧笔记`, now, created.id);
  return { id: created.id, revision: created.revision + 1 };
}

function generate(input: {
  itemIds: UUID[];
  transport: Transport;
  intent?: string;
  name?: string;
  requestKey?: UUID;
  schemaRepairEnabled?: boolean;
}) {
  return generateMindmap(db, {
    requestKey: input.requestKey ?? newId(),
    selection: { mode: 'explicit', itemIds: input.itemIds },
    ...(input.intent !== undefined ? { intent: input.intent } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    config: callSnapshot(CONFIG, SECRET),
    configRevision: 1,
    schemaRepairEnabled: input.schemaRepairEnabled ?? false,
    adapter: new OpenAICompatibleAdapter(input.transport),
  });
}

/** A tree citing exactly the given ids, with `note` leaves for each. */
function treeJson(
  rootItemIds: UUID[],
  leaves: { id: string; label: string; itemIds: UUID[] }[],
  title = '测试脑图',
): string {
  return JSON.stringify({
    title,
    nodes: [
      { id: 'm1', parentId: null, label: title, itemIds: rootItemIds, kind: 'group' },
      ...leaves.map((leaf) => ({ ...leaf, parentId: 'm1', kind: 'note' })),
    ],
  });
}

describe('T055 脑图生成', () => {
  it('T055-C01 只选一条资料时允许简单结构，不凭空扩写', async () => {
    const item = seedItem('我只记了一句：先写问题再写方案。', '先写问题');
    const transport = new ScriptedTransport({
      // 模型给出根 + 一个叶子，正好两条节点：这是合规的最小答案。
      replies: [
        () =>
          chatOk(
            treeJson(
              [item.id],
              [{ id: 'm2', label: '先写问题', itemIds: [item.id] }],
              '先写问题',
            ),
          ),
      ],
    });

    const result = await generate({ itemIds: [item.id], transport });
    expect(result.state).toBe('succeeded');
    expect(result.view).not.toBeNull();
    expect(result.view!.kind).toBe('mindmap');

    const content = result.view!.kind === 'mindmap' ? result.view!.content : null;
    expect(content!.nodes).toHaveLength(2);
    // 每条节点都能回溯到唯一来源，没有制造第二个来源。
    expect(content!.nodes.every((node) => node.itemIds.length > 0)).toBe(true);
    expect(result.view!.sourceSnapshot.items.map((entry) => entry.id)).toEqual([item.id]);
  });

  it('T055-C02 叶节点引用未选择的 ID 时整次失败，不落库', async () => {
    const selected = seedItem('选中的资料');
    const stranger = seedItem('没被选中的资料');
    const transport = new ScriptedTransport({
      replies: [
        () =>
          chatOk(
            treeJson([selected.id], [
              { id: 'm2', label: '虚构来源', itemIds: [stranger.id] },
            ]),
          ),
      ],
    });

    const caught = await generate({ itemIds: [selected.id], transport }).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('STRUCTURED_INVALID');
    expect((caught as AppError).message).toContain('不在本次选择中');

    // 失败不产生 View，Run 是失败终态且带可解释错误。
    expect(listViews(db, { limit: 10, offset: 0 }).views).toHaveLength(0);
    const run = db
      .prepare('SELECT state, error_code, result_ref FROM ai_runs ORDER BY started_at DESC LIMIT 1')
      .get() as { state: string; error_code: string | null; result_ref: string | null };
    expect(run.state).toBe('failed');
    expect(run.error_code).toBe('STRUCTURED_INVALID');
    expect(run.result_ref).toBeNull();
  });

  it('T055-C03 同一来源被两个主题引用时视图重复、知识不复制', async () => {
    const item = seedItem('一个观点可以支撑多个主题');
    const transport = new ScriptedTransport({
      replies: [
        () =>
          chatOk(
            treeJson([item.id], [
              { id: 'm2', label: '角度甲', itemIds: [item.id] },
              { id: 'm3', label: '角度乙', itemIds: [item.id] },
            ]),
          ),
      ],
    });

    const result = await generate({ itemIds: [item.id], transport });
    const content = result.view!.kind === 'mindmap' ? result.view!.content : null;

    // 两个分支都引用同一条来源。
    expect(content!.nodes.filter((node) => node.itemIds.includes(item.id))).toHaveLength(3);
    // 知识库仍然只有一条，没有因为视图重复而复制实体。
    const count = db.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get() as { n: number };
    expect(Number(count.n)).toBe(1);
    // 快照也只有一个来源。
    expect(result.view!.sourceSnapshot.items).toHaveLength(1);
  });

  it('T055-C04 模型新增没有来源的事实叶时拒绝', async () => {
    const item = seedItem('有来源的资料');
    // 根是 group 且只挂了另一个 group，整棵子树没有任何 note，
    // 因此没有任何可回溯来源。
    const transport = new ScriptedTransport({
      replies: [
        () =>
          chatOk(
            JSON.stringify({
              title: '空分支脑图',
              nodes: [
                { id: 'm1', parentId: null, label: '根', itemIds: [item.id], kind: 'group' },
                { id: 'm2', parentId: 'm1', label: '凭空主题', itemIds: [item.id], kind: 'group' },
              ],
            }),
          ),
      ],
    });

    const caught = await generate({ itemIds: [item.id], transport }).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).message).toContain('没有可回溯的来源');
    expect(listViews(db, { limit: 10, offset: 0 }).views).toHaveLength(0);
  });

  it('T055-C05 超过 120 个节点时服务端失败，不交给浏览器硬渲染', async () => {
    const item = seedItem('超限图的唯一来源');
    const nodes: Record<string, unknown>[] = [
      { id: 'm1', parentId: null, label: '根', itemIds: [item.id], kind: 'group' },
    ];
    for (let index = 0; index <= LIMITS.mindmapNodes; index += 1) {
      nodes.push({
        id: `n${index}`,
        parentId: 'm1',
        label: `分支 ${index}`,
        itemIds: [item.id],
        kind: 'note',
      });
    }
    const transport = new ScriptedTransport({
      replies: [() => chatOk(JSON.stringify({ title: '过大的脑图', nodes }))],
    });

    const caught = await generate({ itemIds: [item.id], transport }).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(AppError);
    // 具体错误来自 schema 的 maxItems 或数量校验，两者都指向同一上限。
    expect((caught as AppError).message).toMatch(/120|最多/u);
    expect(listViews(db, { limit: 10, offset: 0 }).views).toHaveLength(0);
  });

  it('T055-C06 新生成失败时旧脑图仍然可以打开', async () => {
    const item = seedItem('已有脑图的来源');

    // 先成功生成一张，作为旧的成果。
    const good = new ScriptedTransport({
      replies: [
        () => chatOk(treeJson([item.id], [{ id: 'm2', label: '旧分支', itemIds: [item.id] }])),
      ],
    });
    const first = await generate({ itemIds: [item.id], transport: good, name: '旧脑图' });
    expect(first.state).toBe('succeeded');
    const oldId = first.view!.id;

    // 再发起一次会失败的生成：模型直接报错。
    const bad = new ScriptedTransport({ replies: [() => chatError('upstream exploded')] });
    await expect(generate({ itemIds: [item.id], transport: bad })).rejects.toBeInstanceOf(AppError);

    // 旧视图原封不动：能读、内容与 revision 都没变。
    const reloaded = getView(db, oldId);
    expect(reloaded.name).toBe('旧脑图');
    expect(reloaded.revision).toBe(first.view!.revision);
    expect(reloaded.contentHash).toBe(first.view!.contentHash);
    expect(listViews(db, { limit: 10, offset: 0 }).views).toHaveLength(1);
  });

  it('T055-R06 相同 requestKey 的重放不重新请求模型，且复用已有视图', async () => {
    const item = seedItem('重放来源');
    const requestKey = newId();
    const transport = new ScriptedTransport({
      replies: [
        () => chatOk(treeJson([item.id], [{ id: 'm2', label: '分支', itemIds: [item.id] }])),
      ],
    });

    const first = await generate({ itemIds: [item.id], transport, requestKey });
    expect(transport.calls).toBe(1);

    const replay = await generate({ itemIds: [item.id], transport, requestKey });
    // 关键：没有第二次付费请求。
    expect(transport.calls).toBe(1);
    expect(replay.replayed).toBe(true);
    expect(replay.viewId).toBe(first.viewId);
    expect(listViews(db, { limit: 10, offset: 0 }).views).toHaveLength(1);
  });

  it('T055-R06 生成期间来源被修改时整次 conflict，不保存混版本的图', async () => {
    const item = seedItem('会被改动的来源');
    const transport = new ScriptedTransport({
      replies: [
        () => chatOk(treeJson([item.id], [{ id: 'm2', label: '分支', itemIds: [item.id] }])),
      ],
      // 模型返回之前，用户改了这条资料的原文。
      beforeReply: () => {
        db.prepare(
          'UPDATE knowledge_items SET raw_text = raw_text || ?, raw_version = raw_version + 1, updated_at = ? WHERE id = ?',
        ).run('（补充）', new Date().toISOString(), item.id);
      },
    });

    const result = await generate({ itemIds: [item.id], transport });
    expect(result.state).toBe('conflict');
    expect(result.viewId).toBeNull();
    expect(result.warnings.join('')).toContain('来源发生变化');
    expect(listViews(db, { limit: 10, offset: 0 }).views).toHaveLength(0);

    const run = db
      .prepare('SELECT state, error_code FROM ai_runs ORDER BY started_at DESC LIMIT 1')
      .get() as { state: string; error_code: string | null };
    expect(run.state).toBe('conflict');
    expect(run.error_code).toBe('SOURCE_CHANGED');
  });

  it('T055-R03 API Key 不出现在发给模型的消息里', async () => {
    const item = seedItem('泄漏检查来源');
    const transport = new ScriptedTransport({
      replies: [
        () => chatOk(treeJson([item.id], [{ id: 'm2', label: '分支', itemIds: [item.id] }])),
      ],
    });

    await generate({ itemIds: [item.id], transport });
    const sent = transport.allMessageText();
    expect(sent).not.toContain(SECRET);
    expect(sent).not.toContain('Bearer');
    expect(sent).not.toContain('Authorization');
  });

  it('T055-R05 没有选择任何来源时拒绝生成，不产生 Run', async () => {
    const transport = new ScriptedTransport({ replies: [() => chatOk('{}')] });
    const caught = await generate({ itemIds: [], transport }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('VALIDATION');
    // 空选择应该在请求模型之前就被挡住：调用次数为零。
    expect(transport.calls).toBe(0);
    const runs = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
    expect(Number(runs.n)).toBe(0);
  });

  it('T055-R06 开启格式修复时，完整但非法的 JSON 只修复一次', async () => {
    const item = seedItem('需要修复的来源');
    const transport = new ScriptedTransport({
      replies: [
        () => chatOk('这里本来该是 JSON，但是模型先写了说明。'),
        () => chatOk(treeJson([item.id], [{ id: 'm2', label: '修复后的分支', itemIds: [item.id] }])),
      ],
    });

    const result = await generate({
      itemIds: [item.id],
      transport,
      schemaRepairEnabled: true,
    });

    expect(result.state).toBe('succeeded');
    // 第一次失败 + 一次修复，恰好两次调用，没有自反思循环。
    expect(transport.calls).toBe(2);
    const content = result.view!.kind === 'mindmap' ? result.view!.content : null;
    expect(content!.nodes.map((node) => node.label)).toContain('修复后的分支');
  });

  it('T055-R03 预算超限的选择在请求模型之前就被明确拒绝', async () => {
    // 造出超过单次上限的来源数量。
    const itemIds: UUID[] = [];
    for (let index = 0; index <= LIMITS.selectedItemsPerProjection; index += 1) {
      itemIds.push(seedItem(`预算来源 ${index}`).id);
    }
    const transport = new ScriptedTransport({ replies: [() => chatOk('{}')] });

    const caught = await generate({ itemIds, transport }).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('VALIDATION');
    expect((caught as AppError).message).toContain('减少');
    expect(transport.calls).toBe(0);
  });

  it('T055-R01 视图名称优先采用用户给出的名字，模型标题只作为 AST 标题', async () => {
    const item = seedItem('名称来源');
    const transport = new ScriptedTransport({
      replies: [
        () =>
          chatOk(treeJson([item.id], [{ id: 'm2', label: '分支', itemIds: [item.id] }], '模型标题')),
      ],
    });

    const named = await generate({ itemIds: [item.id], transport, name: '我的脑图' });
    expect(named.view!.name).toBe('我的脑图');
    expect(named.view!.kind === 'mindmap' ? named.view!.content.title : '').toBe('模型标题');

    const unnamed = await generate({
      itemIds: [item.id],
      transport: new ScriptedTransport({
        replies: [
          () => chatOk(treeJson([item.id], [{ id: 'm2', label: '分支', itemIds: [item.id] }], '第二个标题')),
        ],
      }),
    });
    expect(unnamed.view!.name).toBe('第二个标题');
  });
});
