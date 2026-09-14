/**
 * HTTP 层采集验收（T014-C01/C03/C06）。
 *
 * 这些用例直接调用路由处理函数，覆盖服务层测试看不到的部分：统一信封、
 * 状态码（201 首次 / 200 重放）、严格 schema 拒绝未授权字段，以及被拒绝的
 * 请求不会产生任何写入。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '@/server/db/database';
import { createTestDatabase, newId, openTestDatabase, type TestDatabase } from '../helpers/db';
import { sessionHeaders, callRoute } from './helpers/http';
import type { ItemDTO } from '@/domain/knowledge';

let harness: TestDatabase;

beforeEach(() => {
  harness = createTestDatabase();
  openTestDatabase(harness.databasePath);
});

afterEach(() => {
  harness.cleanup();
});

function countItems(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM knowledge_items').get() as { n: number };
  return row.n;
}

async function postCapture(body: unknown) {
  const { POST } = await import('@/app/api/items/route');
  return callRoute(POST, { method: 'POST', body });
}

const validBody = () => ({
  captureRequestId: newId(),
  rawText: 'HTTP 层采集内容',
  sourceType: 'other' as const,
  sourceRef: null,
});

describe('T014 HTTP 采集接口', () => {
  it('首次创建返回 201，重放返回 200 且指向同一 ID', async () => {
    const body = validBody();

    const first = await postCapture(body);
    expect(first.status).toBe(201);
    expect(first.envelope.ok).toBe(true);

    const replay = await postCapture(body);
    expect(replay.status).toBe(200);
    expect(replay.envelope.ok).toBe(true);

    const firstItem = (first.envelope as { data: { item: ItemDTO } }).data.item;
    const replayItem = (replay.envelope as { data: { item: ItemDTO } }).data.item;
    expect(replayItem.id).toBe(firstItem.id);
    expect(countItems()).toBe(1);
  });

  it('T014-C03 同键异内容返回 409 且错误码正确，原记录保持', async () => {
    const body = validBody();
    await postCapture(body);

    const conflict = await postCapture({ ...body, rawText: '改了内容' });

    expect(conflict.status).toBe(409);
    const failure = conflict.envelope as {
      ok: false;
      error: { code: string; retryable: boolean };
    };
    expect(failure.ok).toBe(false);
    expect(failure.error.code).toBe('CAPTURE_KEY_CONFLICT');
    expect(failure.error.retryable).toBe(false);
    expect(countItems()).toBe(1);
  });

  it('T014-C06 严格 schema 拒绝未授权系统字段且不写入', async () => {
    const injected = {
      ...validBody(),
      // 用户输入不能伪造身份与版本。
      id: newId(),
      revision: 99,
      capturedText: '伪造原文',
      status: 'done',
    };

    const response = await postCapture(injected);

    expect(response.status).toBe(400);
    const failure = response.envelope as { ok: false; error: { code: string; fieldErrors?: Record<string, string[]> } };
    expect(failure.error.code).toBe('VALIDATION');
    // 未授权字段必须被明确指出来，而不是静默丢弃。
    const named = Object.keys(failure.error.fieldErrors ?? {});
    expect(named).toContain('id');
    expect(named).toContain('revision');
    expect(countItems()).toBe(0);
  });

  it('非法 sourceType 被拒绝，不产生记录', async () => {
    const response = await postCapture({ ...validBody(), sourceType: 'telepathy' });
    expect(response.status).toBe(400);
    expect(countItems()).toBe(0);
  });

  it('空白原文被拒绝，不产生记录', async () => {
    const response = await postCapture({ ...validBody(), rawText: '   ' });
    expect(response.status).toBe(400);
    expect(countItems()).toBe(0);
  });

  it('缺少本地令牌时拒绝并返回 SESSION_EXPIRED', async () => {
    const { POST } = await import('@/app/api/items/route');
    const response = await callRoute(POST, { method: 'POST', body: validBody(), token: null });

    expect(response.status).toBe(403);
    const failure = response.envelope as { ok: false; error: { code: string } };
    expect(failure.error.code).toBe('SESSION_EXPIRED');
    expect(countItems()).toBe(0);
  });

  it('非 JSON Content-Type 被拒绝', async () => {
    const { POST } = await import('@/app/api/items/route');
    const response = await callRoute(POST, {
      method: 'POST',
      body: validBody(),
      contentType: 'text/plain',
    });
    expect(response.status).toBe(400);
    expect(countItems()).toBe(0);
  });

  it('GET 列表返回统一分页结构且不修改 datasetRevision', async () => {
    await postCapture(validBody());
    const { GET } = await import('@/app/api/items/route');
    const { getDatasetRevision } = await import('@/server/db/database');

    const before = getDatasetRevision(getDb());
    const response = await callRoute(GET, { method: 'GET', url: 'http://127.0.0.1:3000/api/items' });

    expect(response.status).toBe(200);
    const data = (response.envelope as { data: { items: ItemDTO[]; totalMatched: number } }).data;
    expect(data.items).toHaveLength(1);
    expect(data.totalMatched).toBe(1);
    expect(getDatasetRevision(getDb())).toBe(before);
  });

  it('越界 limit 被查询 schema 拒绝', async () => {
    const { GET } = await import('@/app/api/items/route');
    const response = await callRoute(GET, {
      method: 'GET',
      url: 'http://127.0.0.1:3000/api/items?limit=9999',
    });
    expect(response.status).toBe(400);
  });

  it('sessionHeaders 生成可被本地守卫接受的请求头', async () => {
    const headers = sessionHeaders();
    expect(headers.get('x-brain-token')).toBeTruthy();
    expect(headers.get('origin')).toBe('http://127.0.0.1:3000');
  });
});
