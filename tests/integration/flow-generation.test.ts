/**
 * T063 验收：流程节点、边类型与证据契约。
 *
 * 六个具名场景检查的都是同一件事的不同面：**一个能被解析的流程图还不是一个
 * 诚实的流程图**。所以每个用例都走真实服务入口 `generateFlow`（包括真实适配器 +
 * 注入 transport），并在生成的 View 落库之后回查 `views` 与 `relations` 两张表。
 *
 *   - C01 相关不等于因果：`related_to` 不能按关系认证 causal，但引用原文时标成材料表述；
 *   - C02 假设明确：hypothesis 保留并写明「推测」；
 *   - C03 悬空端点：校验拒绝，Mermaid 不负责补节点；
 *   - C04 来源越界：引用未选择的 Item 被拒；
 *   - C05 关系越界：虚构 Relation ID 不能构成关系证据链，只能退回材料表述；
 *   - C06 不写领域：投影里的推测连接不会自动写回 relations 表。
 *
 * 同时也断言不可违反项：原文持久保存、Key 不进 messages、失败与重试不产生
 * 不可见的额外付费请求（`transport.calls` 就是付费次数）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import type { LlmConfig, UUID } from '@/domain/knowledge';
import { OpenAICompatibleAdapter } from '@/server/llm/adapter';
import type { Transport, TransportRequest, TransportResponse } from '@/server/llm/transport';
import { callSnapshot } from '@/server/llm/types';
import { createCapture } from '@/server/services/items';
import { createManualRelation, reviewRelation } from '@/server/services/relations';
import { generateFlow } from '@/server/services/generateFlow';
import { listViews } from '@/server/services/views/views';
import { createTestDatabase, openTestDatabase, newId, type TestDatabase } from '../helpers/db';

const SECRET = 'sk-test-FLOW-000000000000000000';

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
  beforeReply?: (call: number) => void;
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
    this.options.beforeReply?.(index);
    const reply = this.options.replies[Math.min(index, this.options.replies.length - 1)];
    return reply();
  }

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

function seedItem(rawText: string, title = ''): UUID {
  const created = createCapture(db, {
    captureRequestId: newId(),
    rawText,
    sourceType: 'myself',
    sourceRef: null,
  }).item;
  if (title.length === 0) return created.id;
  db.prepare('UPDATE knowledge_items SET title = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
    .run(title, new Date().toISOString(), created.id);
  return created.id;
}

/**
 * A `causes` relation, created through the product's own path.
 *
 * Manual creation is origin=manual, which is already `accepted` — that is the only
 * shape that can justify a causal edge, and reaching for it through the service
 * keeps the test from depending on the AI-suggestion internals.
 */
function linkCause(sourceId: UUID, targetId: UUID, type: 'causes' | 'related_to' = 'causes'): string {
  const source = db
    .prepare('SELECT revision FROM knowledge_items WHERE id = ?')
    .get(sourceId) as { revision: number };
  const target = db
    .prepare('SELECT revision FROM knowledge_items WHERE id = ?')
    .get(targetId) as { revision: number };
  return createManualRelation(db, {
    sourceId,
    targetId,
    type,
    reason: '测试关系',
    sourceExpectedRevision: Number(source.revision),
    targetExpectedRevision: Number(target.revision),
  }).relation.id;
}

function generate(input: {
  itemIds: UUID[];
  transport: Transport;
  intent?: string;
  direction?: 'LR' | 'TB';
  name?: string;
  requestKey?: UUID;
  schemaRepairEnabled?: boolean;
}) {
  return generateFlow(db, {
    requestKey: input.requestKey ?? newId(),
    selection: { mode: 'explicit', itemIds: input.itemIds },
    intent: input.intent ?? '看这些材料之间的先后和依赖',
    direction: input.direction ?? 'LR',
    ...(input.name !== undefined ? { name: input.name } : {}),
    config: callSnapshot(CONFIG, SECRET),
    configRevision: 1,
    schemaRepairEnabled: input.schemaRepairEnabled ?? false,
    adapter: new OpenAICompatibleAdapter(input.transport),
  });
}

/** A flow document citing exactly the given sources. */
function flowJson(input: {
  nodes: { id: string; label: string; itemIds: UUID[] }[];
  edges?: {
    source: string;
    target: string;
    kind: string;
    label: string;
    itemIds: UUID[];
    relationIds?: string[];
  }[];
  title?: string;
  direction?: 'LR' | 'TB';
}): string {
  return JSON.stringify({
    title: input.title ?? '测试流程',
    direction: input.direction ?? 'LR',
    nodes: input.nodes,
    edges: (input.edges ?? []).map((edge) => ({
      relationIds: edge.relationIds ?? [],
      ...edge,
    })),
  });
}

function relationCount(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM relations').get() as { n: number };
  return Number(row.n);
}

describe('T063 流程节点、边类型与证据契约', () => {
  it('T063-C01 相关不等于已确认因果：related_to 不能认证关系，只能标材料表述', async () => {
    const a = seedItem('甲：先收集需求', '甲');
    const b = seedItem('乙：再写方案', '乙');
    // 材料里只有「相关」，没有已确认的 causes。
    const relatedId = linkCause(a, b, 'related_to');

    const transport = new ScriptedTransport({
      replies: [
        () =>
          chatOk(
            flowJson({
              nodes: [
                { id: 'f1', label: '收集需求', itemIds: [a] },
                { id: 'f2', label: '写方案', itemIds: [b] },
              ],
              edges: [
                {
                  source: 'f1',
                  target: 'f2',
                  kind: 'causal',
                  label: '收集需求导致方案更好',
                  itemIds: [a, b],
                  relationIds: [relatedId],
                },
              ],
            }),
          ),
      ],
    });

    const result = await generate({ itemIds: [a, b], transport });
    expect(result.state).toBe('succeeded');
    const content = result.view!.kind === 'flow' ? result.view!.content : null;
    expect(content).not.toBeNull();

    // 相关不能拿来认证因果：关系 id 被丢掉，边按材料表述保留。
    expect(content!.edges).toHaveLength(1);
    expect(content!.edges[0]!.kind).toBe('causal');
    expect(content!.edges[0]!.basis).toBe('material');
    expect(content!.edges[0]!.relationIds).toEqual([]);
    expect(content!.edges[0]!.relationIds).not.toContain(relatedId);
    expect(content!.edges[0]!.label.length).toBeGreaterThan(0);
    expect(result.warnings.join('')).not.toContain('改成');
  });

  it('T063-C01 已确认的 causes 关系支持 causal，方向按关系方向保留', async () => {
    const a = seedItem('甲：缺水', '甲');
    const b = seedItem('乙：叶子发黄', '乙');
    const causesId = linkCause(a, b, 'causes');

    const transport = new ScriptedTransport({
      replies: [
        () =>
          chatOk(
            flowJson({
              nodes: [
                { id: 'f1', label: '缺水', itemIds: [a] },
                { id: 'f2', label: '叶子发黄', itemIds: [b] },
              ],
              edges: [
                {
                  source: 'f1',
                  target: 'f2',
                  kind: 'causal',
                  label: '缺水会导致叶子发黄',
                  itemIds: [a, b],
                  relationIds: [causesId],
                },
              ],
            }),
          ),
      ],
    });

    const result = await generate({ itemIds: [a, b], transport });
    const content = result.view!.kind === 'flow' ? result.view!.content : null;
    expect(content!.edges[0]!.kind).toBe('causal');
    expect(content!.edges[0]!.basis).toBe('relation');
    expect(content!.edges[0]!.relationIds).toEqual([causesId]);
    expect(result.warnings.join('')).not.toContain('改成');
  });

  it('T063-C02 假设明确：hypothesis 边保留，服务端不把它升级为因果', async () => {
    const a = seedItem('甲：一个观察');
    const b = seedItem('乙：另一个观察');

    const transport = new ScriptedTransport({
      replies: [
        () =>
          chatOk(
            flowJson({
              nodes: [
                { id: 'f1', label: '观察甲', itemIds: [a] },
                { id: 'f2', label: '观察乙', itemIds: [b] },
              ],
              edges: [
                {
                  source: 'f1',
                  target: 'f2',
                  kind: 'hypothesis',
                  label: '推测：甲可能先于乙发生',
                  itemIds: [a, b],
                },
              ],
            }),
          ),
      ],
    });

    const result = await generate({ itemIds: [a, b], transport });
    const content = result.view!.kind === 'flow' ? result.view!.content : null;
    expect(content!.edges[0]!.kind).toBe('hypothesis');
    // 文字里保留了推测的标记（编译时还会再加一次前缀，但不会丢掉原意）。
    expect(content!.edges[0]!.label).toContain('推测');
    // 没有产生任何降级警告，因为模型本来就没有声称因果。
    expect(result.warnings.join('')).not.toContain('声称因果');
  });

  it('T063-C03 悬空端点：边指向不存在的节点时整次拒绝，不落库', async () => {
    const a = seedItem('甲：唯一来源');

    const transport = new ScriptedTransport({
      replies: [
        () =>
          chatOk(
            flowJson({
              nodes: [{ id: 'f1', label: '甲', itemIds: [a] }],
              edges: [
                {
                  source: 'f1',
                  target: 'ghost',
                  kind: 'sequence',
                  label: '然后到不存在的一步',
                  itemIds: [a],
                },
              ],
            }),
          ),
      ],
    });

    const caught = await generate({ itemIds: [a], transport }).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('STRUCTURED_INVALID');
    expect((caught as AppError).message).toContain('流程图');
    // 没有视图落库，Run 是失败终态。
    expect(listViews(db, { limit: 10, offset: 0 }).views).toHaveLength(0);
    const run = db
      .prepare('SELECT state, error_code, result_ref FROM ai_runs ORDER BY started_at DESC LIMIT 1')
      .get() as { state: string; error_code: string | null; result_ref: string | null };
    expect(run.state).toBe('failed');
    expect(run.result_ref).toBeNull();
  });

  it('T063-C04 来源越界：节点引用未选择的 Item 时拒绝该结果', async () => {
    const selected = seedItem('选中的资料');
    const stranger = seedItem('没被选中的资料');

    const transport = new ScriptedTransport({
      replies: [
        () =>
          chatOk(
            flowJson({
              nodes: [
                { id: 'f1', label: '选中', itemIds: [selected] },
                { id: 'f2', label: '越界', itemIds: [stranger] },
              ],
            }),
          ),
      ],
    });

    const caught = await generate({ itemIds: [selected], transport }).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).message).toContain('未选择');
    expect(listViews(db, { limit: 10, offset: 0 }).views).toHaveLength(0);
  });

  it('T063-C05 关系越界：虚构的 relationId 不能构成假证据链', async () => {
    const a = seedItem('甲：缺水');
    const b = seedItem('乙：叶子发黄');

    // 里没有任何 relation，模型凭空写一个 UUID 声称因果关系。
    const invented = newId();
    const transport = new ScriptedTransport({
      replies: [
        () =>
          chatOk(
            flowJson({
              nodes: [
                { id: 'f1', label: '缺水', itemIds: [a] },
                { id: 'f2', label: '叶子发黄', itemIds: [b] },
              ],
              edges: [
                {
                  source: 'f1',
                  target: 'f2',
                  kind: 'causal',
                  label: '缺水导致叶子发黄',
                  itemIds: [a, b],
                  relationIds: [invented],
                },
              ],
            }),
          ),
      ],
    });

    const result = await generate({ itemIds: [a, b], transport });
    const content = result.view!.kind === 'flow' ? result.view!.content : null;

    // 虚构的关系 id 被丢弃，不能构成假证据链；引用的原文仍可标成材料表述。
    expect(content!.edges[0]!.kind).toBe('causal');
    expect(content!.edges[0]!.basis).toBe('material');
    expect(content!.edges[0]!.relationIds).toEqual([]);
    expect(result.view!.sourceSnapshot.relations).toHaveLength(0);
    expect(result.warnings.join('')).not.toContain('改成');
  });

  it('T063-C06 不写领域：生成含推测连接后 relations 表没有新增自动写入的边', async () => {
    const a = seedItem('甲：一个观察');
    const b = seedItem('乙：另一个观察');

    const before = relationCount();
    const transport = new ScriptedTransport({
      replies: [
        () =>
          chatOk(
            flowJson({
              nodes: [
                { id: 'f1', label: '甲', itemIds: [a] },
                { id: 'f2', label: '乙', itemIds: [b] },
              ],
              edges: [
                {
                  source: 'f1',
                  target: 'f2',
                  kind: 'hypothesis',
                  label: '推测：可能相关',
                  itemIds: [a, b],
                },
              ],
            }),
          ),
      ],
    });

    const result = await generate({ itemIds: [a, b], transport });
    expect(result.state).toBe('succeeded');
    // 视图里有这条推测连接。
    const content = result.view!.kind === 'flow' ? result.view!.content : null;
    expect(content!.edges).toHaveLength(1);
    // 但知识库的 relations 表完全没有变化 —— 投影推理不是权威关系。
    expect(relationCount()).toBe(before);
  });

  it('T063-R05 被拒绝的 AI 关系不能按关系认证 causal', async () => {
    const a = seedItem('甲');
    const b = seedItem('乙');
    // 只有 AI 建议才有一个"审核"状态可以变成 rejected，所以这条边按模型产出的
    // 形态直接落一行（e2e 的 seedData 也这么做），再走真实的审核服务拒绝它。
    const relationId = newId();
    const now = new Date().toISOString();
    const versions = db
      .prepare('SELECT id, raw_version FROM knowledge_items WHERE id IN (?, ?)')
      .all(a, b) as { id: string; raw_version: number }[];
    const versionOf = (id: string): number =>
      Number(versions.find((row) => row.id === id)!.raw_version);
    db.prepare(
      `INSERT INTO relations (
         id, source_id, target_id, relation_type, origin, review_status, score, reason,
         evidence_json, source_raw_version, target_raw_version, run_id, revision,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'causes', 'ai', 'suggested', 0.9, '模型建议的因果', '[]', ?, ?, NULL, 1, ?, ?)`,
    ).run(relationId, a, b, versionOf(a), versionOf(b), now, now);

    const relation = db
      .prepare('SELECT revision FROM relations WHERE id = ?')
      .get(relationId) as { revision: number };
    reviewRelation(db, {
      id: relationId,
      expectedRevision: Number(relation.revision),
      action: 'reject',
    });

    const transport = new ScriptedTransport({
      replies: [
        () =>
          chatOk(
            flowJson({
              nodes: [
                { id: 'f1', label: '甲', itemIds: [a] },
                { id: 'f2', label: '乙', itemIds: [b] },
              ],
              edges: [
                {
                  source: 'f1',
                  target: 'f2',
                  kind: 'causal',
                  label: '甲导致乙',
                  itemIds: [a, b],
                  relationIds: [relationId],
                },
              ],
            }),
          ),
      ],
    });

    const result = await generate({ itemIds: [a, b], transport });
    const content = result.view!.kind === 'flow' ? result.view!.content : null;
    expect(content!.edges[0]!.kind).toBe('causal');
    expect(content!.edges[0]!.basis).toBe('material');
    expect(content!.edges[0]!.relationIds).not.toContain(relationId);
  });

  it('T063-R03 超过 40 个节点时服务端明确失败，不交给浏览器硬渲染', async () => {
    const a = seedItem('超限流程的唯一来源');
    const nodes = Array.from({ length: 41 }, (_, index) => ({
      id: `f${index}`,
      label: `步骤 ${index}`,
      itemIds: [a],
    }));
    const transport = new ScriptedTransport({
      replies: [() => chatOk(flowJson({ nodes }))],
    });

    const caught = await generate({ itemIds: [a], transport }).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).message).toMatch(/40/u);
    expect(listViews(db, { limit: 10, offset: 0 }).views).toHaveLength(0);
  });

  it('T063-R06 模型返回 Mermaid 源码或 HTML 字段时被 schema 拒绝', async () => {
    const a = seedItem('来源');
    const transport = new ScriptedTransport({
      replies: [
        () =>
          chatOk(
            JSON.stringify({
              title: '试图给源码',
              direction: 'LR',
              mermaid: 'flowchart LR\n  click N0 "http://evil"',
              nodes: [{ id: 'f1', label: '甲', itemIds: [a] }],
              edges: [],
            }),
          ),
      ],
    });

    const caught = await generate({ itemIds: [a], transport }).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('STRUCTURED_INVALID');
  });

  it('T063-R06 相同 requestKey 的重放不重新请求模型', async () => {
    const a = seedItem('重放来源');
    const b = seedItem('重放来源二');
    const requestKey = newId();
    const transport = new ScriptedTransport({
      replies: [
        () =>
          chatOk(
            flowJson({
              nodes: [
                { id: 'f1', label: '甲', itemIds: [a] },
                { id: 'f2', label: '乙', itemIds: [b] },
              ],
              edges: [
                { source: 'f1', target: 'f2', kind: 'sequence', label: '然后', itemIds: [a, b] },
              ],
            }),
          ),
      ],
    });

    const first = await generate({ itemIds: [a, b], transport, requestKey });
    expect(transport.calls).toBe(1);

    const replay = await generate({ itemIds: [a, b], transport, requestKey });
    expect(transport.calls).toBe(1);
    expect(replay.replayed).toBe(true);
    expect(replay.viewId).toBe(first.viewId);
    expect(listViews(db, { limit: 10, offset: 0, kind: 'flow' }).views).toHaveLength(1);
  });

  it('T063-R06 方向是输入的一部分：同一 key 换方向是冲突而不是重放', async () => {
    const a = seedItem('方向来源');
    const requestKey = newId();
    const transport = new ScriptedTransport({
      replies: [() => chatOk(flowJson({ nodes: [{ id: 'f1', label: '甲', itemIds: [a] }] }))],
    });

    await generate({ itemIds: [a], transport, requestKey, direction: 'LR' });
    // 同样的 key、同样的材料，但换方向：这是另一件事，必须拒绝而不是复用旧结果。
    const caught = await generate({ itemIds: [a], transport, requestKey, direction: 'TB' }).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(AppError);
    expect(transport.calls).toBe(1);
  });

  it('T063 生成期间来源被修改时整次 conflict，不保存混版本的图', async () => {
    const a = seedItem('会被改动的来源');
    const transport = new ScriptedTransport({
      replies: [() => chatOk(flowJson({ nodes: [{ id: 'f1', label: '甲', itemIds: [a] }] }))],
      beforeReply: () => {
        db.prepare(
          'UPDATE knowledge_items SET raw_text = raw_text || ?, raw_version = raw_version + 1, updated_at = ? WHERE id = ?',
        ).run('（补充）', new Date().toISOString(), a);
      },
    });

    const result = await generate({ itemIds: [a], transport });
    expect(result.state).toBe('conflict');
    expect(result.viewId).toBeNull();
    expect(listViews(db, { limit: 10, offset: 0, kind: 'flow' }).views).toHaveLength(0);
  });

  it('T063-R01/R02 API Key 不出现在 messages，relation 上下文可供引用', async () => {
    const a = seedItem('甲：缺水', '甲');
    const b = seedItem('乙：叶子发黄', '乙');
    const causesId = linkCause(a, b, 'causes');

    const transport = new ScriptedTransport({
      replies: [
        () =>
          chatOk(
            flowJson({
              nodes: [
                { id: 'f1', label: '缺水', itemIds: [a] },
                { id: 'f2', label: '叶子发黄', itemIds: [b] },
              ],
              edges: [
                {
                  source: 'f1',
                  target: 'f2',
                  kind: 'causal',
                  label: '缺水导致叶子发黄',
                  itemIds: [a, b],
                  relationIds: [causesId],
                },
              ],
            }),
          ),
      ],
    });

    await generate({ itemIds: [a, b], transport });
    const sent = transport.allMessageText();
    expect(sent).not.toContain(SECRET);
    expect(sent).not.toContain('Bearer');
    // 关系上下文确实送到了模型：id、类型与审核状态都在。
    expect(sent).toContain(causesId);
    expect(sent).toContain('causes');
    expect(sent).toContain('accepted');
    // 用户意图也在，且被围栏包住。
    expect(sent).toContain('看这些材料之间的先后和依赖');
  });

  it('T063-R05 没有预建关系时，引用原文的 causal 按材料表述保留', async () => {
    const a = seedItem('甲');
    const b = seedItem('乙');
    const transport = new ScriptedTransport({
      replies: [
        () =>
          chatOk(
            flowJson({
              nodes: [
                { id: 'f1', label: '甲', itemIds: [a] },
                { id: 'f2', label: '乙', itemIds: [b] },
              ],
              edges: [
                {
                  source: 'f1',
                  target: 'f2',
                  kind: 'causal',
                  label: '甲导致乙',
                  itemIds: [a, b],
                },
              ],
            }),
          ),
      ],
    });

    const result = await generate({ itemIds: [a, b], transport });
    expect(transport.allMessageText()).toContain('材料表述');
    const content = result.view!.kind === 'flow' ? result.view!.content : null;
    expect(content!.edges[0]!.kind).toBe('causal');
    expect(content!.edges[0]!.basis).toBe('material');
    expect(result.warnings.join('')).not.toContain('改成');
  });

  it('T063-R06 没有选择任何来源时拒绝生成，不产生 Run 也不发起请求', async () => {
    const transport = new ScriptedTransport({ replies: [() => chatOk('{}')] });
    const caught = await generate({ itemIds: [], transport }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('VALIDATION');
    expect(transport.calls).toBe(0);
    const runs = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
    expect(Number(runs.n)).toBe(0);
  });

  it('T063-R06 开启格式修复时，完整但非法的 JSON 只修复一次', async () => {
    const a = seedItem('需要修复的来源');
    const transport = new ScriptedTransport({
      replies: [
        () => chatOk('这里是解释，不是 JSON。'),
        () => chatOk(flowJson({ nodes: [{ id: 'f1', label: '修复后的节点', itemIds: [a] }] })),
      ],
    });

    const result = await generate({ itemIds: [a], transport, schemaRepairEnabled: true });
    expect(result.state).toBe('succeeded');
    // 第一次失败 + 一次修复：恰好两次，没有自反思循环。
    expect(transport.calls).toBe(2);
    const content = result.view!.kind === 'flow' ? result.view!.content : null;
    expect(content!.nodes[0]!.label).toBe('修复后的节点');
  });

  it('T063-R06 生成失败不破坏旧图', async () => {
    const a = seedItem('已有流程图的来源');
    const good = new ScriptedTransport({
      replies: [() => chatOk(flowJson({ nodes: [{ id: 'f1', label: '旧节点', itemIds: [a] }] }))],
    });
    const first = await generate({ itemIds: [a], transport: good, name: '旧流程图' });
    expect(first.state).toBe('succeeded');

    const bad = new ScriptedTransport({ replies: [() => chatError('upstream exploded')] });
    await expect(generate({ itemIds: [a], transport: bad })).rejects.toBeInstanceOf(AppError);

    const { getView } = await import('@/server/services/views/views');
    const reloaded = getView(db, first.view!.id);
    expect(reloaded.name).toBe('旧流程图');
    expect(reloaded.contentHash).toBe(first.view!.contentHash);
    expect(listViews(db, { limit: 10, offset: 0, kind: 'flow' }).views).toHaveLength(1);
  });

  it('T063-R01 用户给出的名称优先，模型标题只作为内容标题', async () => {
    const a = seedItem('名称来源');
    const transport = new ScriptedTransport({
      replies: [
        () => chatOk(flowJson({ nodes: [{ id: 'f1', label: '甲', itemIds: [a] }], title: '模型标题' })),
      ],
    });
    const named = await generate({ itemIds: [a], transport, name: '我的流程图' });
    expect(named.view!.name).toBe('我的流程图');
    expect(named.view!.kind === 'flow' ? named.view!.content.title : '').toBe('模型标题');
  });
});
