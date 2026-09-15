/**
 * T060/T068：导出端点的查询解析必须与其它端点同一套。
 *
 * 该路由原来自建解析：
 * `Object.fromEntries(new URL(request.url).searchParams.entries())`。
 * `Object.fromEntries` 对重复键**后者胜出**，于是
 * `?format=json&format=mermaid` 被静默当成 `mermaid` 接受，而不是作为歧义请求拒绝。
 *
 * 这正是 `parseQuery` 存在要防的那类覆盖缺陷 —— 同一形态此前让
 * `?itemId=a&itemId=b` 只留下最后一个 id，使「将发送什么材料」面板描述了一个子集，
 * 被删条目可以藏在截断后面（T062-C05）。
 *
 * 断言只针对**契约行为**（400 + 不把 svg 说成可用 + 不返回可执行字节），
 * 不依赖服务端用哪一句文案。
 *
 * 注意：导出端点返回**文件**而非 `{ok,data}` 信封（T060-R03），所以这里直接
 * 使用原始 `Response`，不走 `callRoute` 的 JSON 解析。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import type { ApiEnvelope } from '@/domain/api';
import { createCapture } from '@/server/services/items';
import { createTestDatabase, newId, openTestDatabase, type TestDatabase } from '../helpers/db';
import { sessionHeaders } from './helpers/http';

let harness: TestDatabase;
let db: DatabaseSync;

beforeEach(() => {
  harness = createTestDatabase();
  db = openTestDatabase(harness.databasePath);
});

afterEach(() => {
  harness.cleanup();
});

function seedMindmap(name: string): string {
  const item = createCapture(db, {
    captureRequestId: newId(),
    rawText: '导出查询解析样本',
    sourceType: 'other',
    sourceRef: null,
  }).item;

  const now = new Date().toISOString();
  const id = newId();
  db.prepare(
    `INSERT INTO views (
       id, name, kind, selection_json, source_snapshot_json, content_json, content_hash,
       renderer_version, prompt_version, run_id, revision, generated_at, created_at, updated_at
     ) VALUES (?, ?, 'mindmap', ?, ?, ?, 'hash-export-query', 'mindmap-markmap-v1', 'mindmap-v1', NULL, 1, ?, ?, ?)`,
  ).run(
    id,
    name,
    JSON.stringify({ mode: 'explicit', itemIds: [item.id] }),
    JSON.stringify({
      items: [{ id: item.id, rawVersion: item.rawVersion, revision: item.revision }],
      relations: [],
    }),
    JSON.stringify({
      title: '导出查询解析',
      nodes: [
        { id: 'm1', parentId: null, label: '导出查询解析', itemIds: [item.id], kind: 'group' },
        { id: 'm2', parentId: 'm1', label: '子节点', itemIds: [item.id], kind: 'leaf' },
      ],
    }),
    now,
    now,
    now,
  );
  return id;
}

/** Call the route and return the raw `Response` (导出端点不返回 JSON 信封). */
async function exportRaw(viewId: string, query: string): Promise<Response> {
  const { GET } = await import('@/app/api/views/[id]/export/route');
  const request = new Request(`http://127.0.0.1:3000/api/views/${viewId}/export${query}`, {
    method: 'GET',
    headers: sessionHeaders(),
  });
  return (GET as never as (r: Request, c: unknown) => Promise<Response>)(request, {
    params: Promise.resolve({ id: viewId }),
  });
}

describe('T060-R03 导出查询解析', () => {
  // 脑图导出器只支持 markdown / json（mermaid 属于流程导出），所以合法样例用 json。
  it('单个合法 format 正常返回文件', async () => {
    const viewId = seedMindmap('单个 format');

    const response = await exportRaw(viewId, '?format=json');

    const body = await response.text();
    expect(response.status, `body=${body}`).toBe(200);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    // 导出信封自带应用标识；脑图标题位于其内容字段内。
    expect(parsed.application).toBe('feini-brain');
    expect(body).toContain('导出查询解析');
  });

  it('缺省 format 按契约回落到 markdown', async () => {
    const viewId = seedMindmap('缺省 format');

    const response = await exportRaw(viewId, '');

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body.startsWith('#')).toBe(true);
  });

  /**
   * 关键对照：两个**都合法**的 format 重复出现。
   *
   * 旧的 `Object.fromEntries` 解析会静默保留最后一个（`json`）并返回 200，
   * 于是「用户点了哪份」与「服务端给了哪份」可以不一致而无人知晓。
   * 本用例在旧实现下会失败（200），这正是它有意义的原因 —— 若换成
   * `?format=json&format=mermaid`，旧实现因 mermaid 对脑图本就不受支持而同样 400，
   * 该用例就会在坏实现上误通过，等于没有验证任何东西。
   */
  it('两个都合法的 format 重复出现时被拒为 VALIDATION，而不是静默取最后一个', async () => {
    const viewId = seedMindmap('重复 format');

    const response = await exportRaw(viewId, '?format=markdown&format=json');

    expect(response.status, '重复参数是歧义请求，必须 400 而不是取其一带过').toBe(400);
    const envelope = (await response.json()) as { ok: false; error: { code: string } };
    expect(envelope.error.code).toBe('VALIDATION');
  });

  /**
   * 顺序对照：两个都合法、只差顺序。旧实现两种顺序都返回 200，即「用户点了哪份」
   * 与「拿到哪份」由 URL 里最后那个 query 决定，调用方无从知晓也没有报错。
   * 单独跑「取最后一个」这一侧证明不了什么，必须两侧都断言。
   */
  it('反向顺序同样被拒，不因「最后一个合法」而通过', async () => {
    const viewId = seedMindmap('反向重复 format');

    const response = await exportRaw(viewId, '?format=json&format=markdown');

    expect(response.status).toBe(400);
    const envelope = (await response.json()) as { ok: false; error: { code: string } };
    expect(envelope.error.code).toBe('VALIDATION');
  });

  it('重复标量参数被点名，fieldErrors 指出是哪个参数重复', async () => {
    const viewId = seedMindmap('重复参数点名');

    const response = await exportRaw(viewId, '?format=json&format=json');

    expect(response.status).toBe(400);
    const envelope = (await response.json()) as {
      ok: false;
      error: { code: string; fieldErrors?: Record<string, string[]> };
    };
    expect(envelope.error.code).toBe('VALIDATION');
    expect(Object.keys(envelope.error.fieldErrors ?? {})).toEqual(['format']);
  });

  it('svg 仍被拒绝，且不返回任何可执行字节', async () => {
    const viewId = seedMindmap('svg 拒绝');

    const response = await exportRaw(viewId, '?format=svg');

    expect(response.status).toBe(400);
    const envelope = (await response.json()) as ApiEnvelope<unknown>;
    // The message must not advertise svg as an available format.
    expect(JSON.stringify(envelope)).not.toMatch(/"svg"\s*[,:]/u);
  });
});
