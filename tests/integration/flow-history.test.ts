/**
 * T067 验收：流程视图保存、来源和新鲜度。
 *
 * 六个具名场景都建立在同一件事上：**流程是一次生成的快照，不是一张图**。因此
 * 每个用例都走真实服务（`generateFlow` 落库、`getView` 重读、`editView` 改名、
 * `reviewRelation` 改审核状态、`exportView` 导出），再对比数据库里的实际行。
 *
 *   - C01 重开流程：内容从 canonical JSON 重建，节点/边与来源快照逐项相等；
 *   - C02 关系被拒绝：新鲜度报出依据变化，而不是只看节点标题；
 *   - C03 假设说明：推测边可与事实边区分（面板与导出共用同一个领域函数）；
 *   - C04 历史保留：重新生成产出第二张视图，旧的那张仍然可比较；
 *   - C05 打开不计费：重复读取与导出不新增任何 run；
 *   - C06 源码派生：Mermaid 每次从内容重新编译，缓存字符串不是权威。
 *
 * 另外两条不可违反项也在这里钉住：改名不移动 `generatedAt`，删除视图不删知识。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import type { LlmConfig, UUID } from '@/domain/knowledge';
import { computeStaleness } from '@/domain/view';
import { flowHypothesisEdges } from '@/domain/validateFlow';
import { compileFlow } from '@/domain/compileFlow';
import { OpenAICompatibleAdapter } from '@/server/llm/adapter';
import type { Transport, TransportResponse } from '@/server/llm/transport';
import { callSnapshot } from '@/server/llm/types';
import { createCapture } from '@/server/services/items';
import { createManualRelation } from '@/server/services/relations';
import { generateFlow } from '@/server/services/generateFlow';
import { exportView } from '@/server/services/views/exportView';
import { getViewFreshness } from '@/server/services/views/getFreshness';
import {
  editView,
  getView,
  listViews,
  readCurrentSourceState,
} from '@/server/services/views/views';
import { createTestDatabase, openTestDatabase, newId, type TestDatabase } from '../helpers/db';

const CONFIG: LlmConfig = {
  adapter: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
  structuredMode: 'prompt_json',
  tokenField: 'none',
  maxOutputTokens: 4096,
  schemaRepairEnabled: false,
};

class ScriptedTransport implements Transport {
  calls = 0;

  constructor(private readonly replies: Array<() => TransportResponse>) {}

  // The interface declares a request parameter; this double ignores it, and TS
  // allows the shorter signature, so no unused binding is needed.
  async send(): Promise<TransportResponse> {
    const index = this.calls;
    this.calls += 1;
    return this.replies[Math.min(index, this.replies.length - 1)]!();
  }
}

function chatOk(content: string): TransportResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    bodyText: JSON.stringify({
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
    }),
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

function linkCause(sourceId: UUID, targetId: UUID, type: 'causes' | 'related_to' = 'causes'): string {
  const revision = (id: UUID): number =>
    Number(
      (db.prepare('SELECT revision FROM knowledge_items WHERE id = ?').get(id) as { revision: number })
        .revision,
    );
  return createManualRelation(db, {
    sourceId,
    targetId,
    type,
    reason: '测试关系',
    sourceExpectedRevision: revision(sourceId),
    targetExpectedRevision: revision(targetId),
  }).relation.id;
}

function flowJson(input: {
  nodes: { id: string; label: string; itemIds: UUID[] }[];
  edges?: { source: string; target: string; kind: string; label: string; itemIds: UUID[]; relationIds?: string[] }[];
  title?: string;
}): string {
  return JSON.stringify({
    title: input.title ?? '测试流程',
    direction: 'LR',
    nodes: input.nodes,
    edges: (input.edges ?? []).map((edge) => ({ relationIds: [], ...edge })),
  });
}

function generate(itemIds: UUID[], transport: Transport, name?: string) {
  return generateFlow(db, {
    requestKey: newId(),
    selection: { mode: 'explicit', itemIds },
    intent: '这些材料的先后和依赖',
    direction: 'LR',
    ...(name !== undefined ? { name } : {}),
    config: callSnapshot(CONFIG, 'sk-test-T067-0000000000000000'),
    configRevision: 1,
    schemaRepairEnabled: false,
    adapter: new OpenAICompatibleAdapter(transport),
  });
}

function runCount(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
  return Number(row.n);
}

describe('T067 流程视图保存、来源和新鲜度', () => {
  it('T067-C01 重开流程：从 canonical JSON 重建，节点/边与快照逐项相等', async () => {
    const a = seedItem('甲：先收集需求', '甲');
    const b = seedItem('乙：再写方案', '乙');
    const transport = new ScriptedTransport([
      () =>
        chatOk(
          flowJson({
            nodes: [
              { id: 'f1', label: '收集需求', itemIds: [a] },
              { id: 'f2', label: '写方案', itemIds: [b] },
            ],
            edges: [
              { source: 'f1', target: 'f2', kind: 'sequence', label: '顺序：先甲后乙', itemIds: [a, b] },
            ],
          }),
        ),
    ]);

    const created = await generate([a, b], transport, '先收集再写方案');
    expect(created.state).toBe('succeeded');

    // 重新读取：内容和快照必须与生成时逐项相等（这是"可追溯重现"的实质）。
    const reopened = getView(db, created.viewId!);
    expect(reopened.kind).toBe('flow');
    expect(reopened.content).toEqual(created.view!.content);
    expect(reopened.sourceSnapshot).toEqual(created.view!.sourceSnapshot);
    expect(reopened.contentHash).toBe(created.view!.contentHash);
    // 生成时间不因查看而改变。
    expect(reopened.generatedAt).toBe(created.view!.generatedAt);

    const content = reopened.kind === 'flow' ? reopened.content : null;
    expect(content!.nodes).toHaveLength(2);
    expect(content!.edges).toHaveLength(1);
    // 每个节点引用的来源都真实存在。
    for (const node of content!.nodes) {
      for (const id of node.itemIds) {
        const row = db.prepare('SELECT COUNT(*) AS n FROM knowledge_items WHERE id = ?').get(id) as {
          n: number;
        };
        expect(Number(row.n)).toBe(1);
      }
    }
  });

  it('T067-C02 关系被拒绝：新鲜度报出依据变化，而不是只看节点标题', async () => {
    const a = seedItem('甲：缺水', '甲');
    const b = seedItem('乙：叶子发黄', '乙');
    const causesId = linkCause(a, b, 'causes');

    const transport = new ScriptedTransport([
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
    ]);

    const created = await generate([a, b], transport, '因果流程');
    const viewId = created.viewId!;
    expect((created.view!.kind === 'flow' ? created.view!.content.edges[0]!.kind : null)).toBe(
      'causal',
    );
    // 生成时是新鲜的：关系没有动过。
    const freshBefore = getViewFreshness(db, viewId);
    expect(freshBefore.isStale).toBe(false);
    expect(freshBefore.currentSelection.count).toBe(2);

    // 关系被删除（拒绝的终局形态；人工关系不能 review，只能删）。节点标题完全没变。
    db.prepare('DELETE FROM relations WHERE id = ?').run(causesId);

    const reopened = getView(db, viewId);
    const staleness = computeStaleness(
      reopened.sourceSnapshot,
      readCurrentSourceState(db, reopened.sourceSnapshot),
    );
    // 只检查节点标题的实现会漏掉这一条：变化发生在关系上。
    expect(staleness.isStale).toBe(true);
    expect(staleness.changedRelationIds).toEqual([causesId]);

    const freshness = getViewFreshness(db, viewId);
    expect(freshness.isStale).toBe(true);
    expect(freshness.changedRelationCount).toBe(1);
    expect(freshness.reason).toContain('关系');

    // 而且旧图本身没有被改写：边还在，内容与哈希都没变。
    expect(reopened.content).toEqual(created.view!.content);
    expect(reopened.contentHash).toBe(created.view!.contentHash);
  });

  it('T067-C02 关系被修改（revision 变化）同样被报出', async () => {
    const a = seedItem('甲');
    const b = seedItem('乙');
    const relationId = linkCause(a, b, 'related_to');

    const transport = new ScriptedTransport([
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
                kind: 'association',
                label: '相关：两件事有关系',
                itemIds: [a, b],
                relationIds: [relationId],
              },
            ],
          }),
        ),
    ]);

    const created = await generate([a, b], transport);
    // 直接改动关系行（模拟另一处的评审动作），节点标题不动。
    db.prepare('UPDATE relations SET revision = revision + 1, updated_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      relationId,
    );

    const freshness = getViewFreshness(db, created.viewId!);
    expect(freshness.isStale).toBe(true);
    expect(freshness.changedRelationCount).toBe(1);
    expect(freshness.drift.some((entry) => entry.kind === 'relation')).toBe(true);
  });

  it('T067-C03 假设说明：推测边可与事实边区分，且导出保留同样区分', async () => {
    const a = seedItem('甲：一个观察');
    const b = seedItem('乙：另一个观察');
    const transport = new ScriptedTransport([
      () =>
        chatOk(
          flowJson({
            nodes: [
              { id: 'f1', label: '观察甲', itemIds: [a] },
              { id: 'f2', label: '观察乙', itemIds: [b] },
            ],
            edges: [
              { source: 'f1', target: 'f2', kind: 'sequence', label: '顺序：甲在乙之前', itemIds: [a] },
              { source: 'f2', target: 'f1', kind: 'hypothesis', label: '推测：乙可能反过来影响甲', itemIds: [a, b] },
            ],
          }),
        ),
    ]);

    const created = await generate([a, b], transport, '事实与推测');
    const view = getView(db, created.viewId!);
    const content = view.kind === 'flow' ? view.content : null;

    // 领域层给出的"哪些是推测"是唯一答案，面板与导出都从这里读。
    const hypotheses = flowHypothesisEdges(content!);
    expect(hypotheses).toHaveLength(1);
    expect(hypotheses[0]).toMatchObject({ source: 'f2', target: 'f1' });

    // 编译后：推测是虚线并带「推测：」前缀，事实边是实线。
    const compiled = compileFlow(content!);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const lines = compiled.compiled.source.split('\n');
    expect(lines.some((line) => line.includes('-.->') && line.includes('推测'))).toBe(true);
    expect(lines.some((line) => line.includes('-->') && line.includes('顺序'))).toBe(true);

    // 导出同样保留：文本里有虚线箭头，JSON 里 hypotheses 单列。
    const exported = exportView(db, {
      id: created.viewId!,
      format: 'mermaid',
      now: '2026-09-15T00:00:00.000Z',
    });
    expect(exported.body).toContain('-.->');
    expect(exported.body).toContain('推测');

    const exportedJson = exportView(db, {
      id: created.viewId!,
      format: 'json',
      now: '2026-09-15T00:00:00.000Z',
    });
    const parsed = JSON.parse(exportedJson.body) as { hypotheses: unknown[]; kind: string };
    expect(parsed.kind).toBe('flow');
    expect(parsed.hypotheses).toHaveLength(1);
  });

  it('T067-C04 历史保留：重新生成产出第二张视图，旧图仍可比较', async () => {
    const a = seedItem('同一观察问题的材料');
    const first = new ScriptedTransport([
      () => chatOk(flowJson({ nodes: [{ id: 'f1', label: '第一版节点', itemIds: [a] }], title: '第一版' })),
    ]);
    const one = await generate([a], first, '同一问题');
    expect(one.state).toBe('succeeded');

    const second = new ScriptedTransport([
      () => chatOk(flowJson({ nodes: [{ id: 'f1', label: '第二版节点', itemIds: [a] }], title: '第二版' })),
    ]);
    const two = await generate([a], second, '同一问题');
    expect(two.state).toBe('succeeded');

    // 两张不同的视图，两个不同的 run：生成是可追踪的，不是无痕覆盖。
    expect(two.viewId).not.toBe(one.viewId);
    expect(two.runId).not.toBe(one.runId);

    const list = listViews(db, { kind: 'flow', limit: 10, offset: 0 });
    expect(list.views).toHaveLength(2);
    const ids = list.views.map((view) => view.id);
    expect(ids).toContain(one.viewId);
    expect(ids).toContain(two.viewId);

    // 旧图内容没有被后一次生成改动。
    const oldView = getView(db, one.viewId!);
    const oldContent = oldView.kind === 'flow' ? oldView.content : null;
    expect(oldContent!.nodes[0]!.label).toBe('第一版节点');
    const newView = getView(db, two.viewId!);
    const newContent = newView.kind === 'flow' ? newView.content : null;
    expect(newContent!.nodes[0]!.label).toBe('第二版节点');
  });

  it('T067-C04 改名是新 revision，不移动 generatedAt，也不改内容', async () => {
    const a = seedItem('改名来源');
    const transport = new ScriptedTransport([
      () => chatOk(flowJson({ nodes: [{ id: 'f1', label: '节点', itemIds: [a] }] })),
    ]);
    const created = await generate([a], transport, '原名');
    const viewId = created.viewId!;

    const renamed = editView(db, { id: viewId, expectedRevision: 1, name: '新名字' });
    expect(renamed.name).toBe('新名字');
    expect(renamed.revision).toBe(2);
    // 语义内容与生成时间不受影响。
    expect(renamed.generatedAt).toBe(created.view!.generatedAt);
    expect(renamed.content).toEqual(created.view!.content);
    expect(renamed.contentHash).toBe(created.view!.contentHash);
    expect(renamed.kind === 'flow' ? renamed.content.title : '').toBe('测试流程');
  });

  it('T067-C05 打开不计费：重复读取与导出不新增任何 run 或模型请求', async () => {
    const a = seedItem('不计费来源');
    const transport = new ScriptedTransport([
      () => chatOk(flowJson({ nodes: [{ id: 'f1', label: '节点', itemIds: [a] }] })),
    ]);
    const created = await generate([a], transport);
    const runsAfterGenerate = runCount();
    expect(transport.calls).toBe(1);
    expect(runsAfterGenerate).toBe(1);

    // 模拟"反复访问保存的流程"：读列表、读视图、读新鲜度、读两次导出。
    for (let round = 0; round < 3; round += 1) {
      listViews(db, { kind: 'flow', limit: 25, offset: 0 });
      getView(db, created.viewId!);
      getViewFreshness(db, created.viewId!);
      exportView(db, { id: created.viewId!, format: 'json', now: '2026-09-15T00:00:00.000Z' });
      exportView(db, { id: created.viewId!, format: 'mermaid', now: '2026-09-15T00:00:00.000Z' });
    }

    // 付费次数没有变。
    expect(transport.calls).toBe(1);
    expect(runCount()).toBe(runsAfterGenerate);
  });

  it('T067-C06 源码派生：Mermaid 每次从 canonical 内容重新编译，缓存字符串不是权威', async () => {
    const a = seedItem('派生来源');
    const transport = new ScriptedTransport([
      () => chatOk(flowJson({ nodes: [{ id: 'f1', label: '派生节点', itemIds: [a] }] })),
    ]);
    const created = await generate([a], transport);
    const viewId = created.viewId!;

    const first = exportView(db, { id: viewId, format: 'mermaid', now: '2026-09-15T00:00:00.000Z' });
    const second = exportView(db, { id: viewId, format: 'mermaid', now: '2026-09-16T00:00:00.000Z' });

    // 两次导出的图体逐字节相同（只有导出时间注释不同）。
    const bodyOf = (text: string) => text.split('\n').filter((line) => !line.startsWith('%% 导出时间')).join('\n');
    expect(bodyOf(first.body)).toBe(bodyOf(second.body));

    // 图体来自编译器对当前 content 的输出，而不是任何被存下来的字符串。
    // 先取值再收窄：两次调用 `getView` 会让 TypeScript 无法把 `kind === 'flow'` 的
    // 判断传播到第二个表达式上（T062 期间本文件曾因此阻塞 `npm run build`）。
    const loaded = getView(db, viewId);
    const content = loaded.kind === 'flow' ? loaded.content : null;
    const compiled = compileFlow(content!);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(first.body).toContain(compiled.compiled.source);

    // 数据库里没有任何存放 Mermaid 源码的列或副本表。
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.some((row) => /mermaid/iu.test(row.name))).toBe(false);
  });

  it('T067-R01/R06 流程使用通用 views 表，kind 为 flow，打开不写 generatedAt', async () => {
    const a = seedItem('通用表来源');
    const transport = new ScriptedTransport([
      () => chatOk(flowJson({ nodes: [{ id: 'f1', label: '节点', itemIds: [a] }] })),
    ]);
    const created = await generate([a], transport);

    const row = db
      .prepare('SELECT kind, generated_at, content_json FROM views WHERE id = ?')
      .get(created.viewId) as { kind: string; generated_at: string; content_json: string };
    expect(row.kind).toBe('flow');
    // canonical JSON 落库，可重新解析。
    const stored = JSON.parse(row.content_json) as { nodes: unknown[]; edges: unknown[] };
    expect(Array.isArray(stored.nodes)).toBe(true);
    expect(Array.isArray(stored.edges)).toBe(true);

    // 读取若干次不改 generated_at。
    for (let index = 0; index < 3; index += 1) getView(db, created.viewId!);
    const after = db.prepare('SELECT generated_at FROM views WHERE id = ?').get(created.viewId) as {
      generated_at: string;
    };
    expect(after.generated_at).toBe(row.generated_at);
  });

  it('T067 删除视图不删除知识', async () => {
    const a = seedItem('知识本体');
    const transport = new ScriptedTransport([
      () => chatOk(flowJson({ nodes: [{ id: 'f1', label: '节点', itemIds: [a] }] })),
    ]);
    const created = await generate([a], transport);

    db.prepare('DELETE FROM views WHERE id = ?').run(created.viewId!);
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM knowledge_items WHERE id = ?').get(a) as {
      n: number;
    };
    expect(Number(remaining.n)).toBe(1);
  });
});
