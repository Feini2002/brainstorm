/**
 * T018 验收：详情抽屉、原文和来源回溯。
 *
 * 用例规格：docs/05_tests/G1/T018_cases.md。审计结论是「`KnowledgeDrawer.tsx` /
 * `SourceReference.tsx` 无测试导入；契约点名的 `src/app/api/items/[id]/route.ts` 实际
 * 存在，但无 HTTP 层测试指向它」。这里补齐 HTTP 层能证明的部分：初始原文与当前原文
 * 同时可读、版本可分辨、来源是字面数据而不是链接、删除竞态返回 404 而不是无限重试。
 *
 * 抽屉的焦点管理与视觉呈现依赖真实渲染，node 环境无法断言（仓库 vitest 是
 * `environment: 'node'`，没有 jsdom），那部分仍只由 e2e 覆盖。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import type { ItemDTO } from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import { createCapture, patchItem } from '@/server/services/items';
import { applyOrganizeMetadata } from '@/server/services/applyOrganizeMetadata';
import { createTestDatabase, newId, openTestDatabase, type TestDatabase } from '../helpers/db';
import { callRoute, sessionHeaders } from './helpers/http';

let harness: TestDatabase;
let db: DatabaseSync;

beforeEach(() => {
  harness = createTestDatabase();
  db = openTestDatabase(harness.databasePath);
});

afterEach(() => {
  harness.cleanup();
});

function capture(rawText: string, sourceRef: string | null = null): ItemDTO {
  return createCapture(db, {
    captureRequestId: newId(),
    rawText,
    sourceType: 'other',
    sourceRef,
  }).item;
}

async function getItem(id: string): Promise<{ status: number; data: ItemDTO }> {
  const { GET } = await import('@/app/api/items/[id]/route');
  const response = await callRoute(GET, {
    method: 'GET',
    path: `/api/items/${id}`,
    params: { id },
  });
  const envelope = response.envelope as { ok: true; data: ItemDTO };
  return { status: response.status, data: envelope.data };
}

describe('T018-C01 初始原文与当前原文', () => {
  it('T018-C01 修改 rawText 后同时看到 capturedText、当前 rawText 与两个版本', async () => {
    const created = capture('最初的原文，里面有一个错子。');
    const edited = patchItem(db, {
      id: created.id,
      expectedRevision: created.revision,
      patch: { rawText: '最初的原文，里面有一个错字。' },
    });
    expect(edited.rawVersion).toBe(2);

    const { status, data } = await getItem(created.id);

    expect(status).toBe(200);
    // 三条信息必须同时可读，否则无法区分「最初材料」与「后期修订」。
    expect(data.capturedText).toBe('最初的原文，里面有一个错子。');
    expect(data.rawText).toBe('最初的原文，里面有一个错字。');
    expect(data.rawVersion).toBe(2);
    expect(data.capturedText).not.toBe(data.rawText);
  });

  it('T018-C01 未修改原文时两者相同且 rawVersion 为 1（不制造假的修订）', async () => {
    const created = capture('从未修改过的原文。');
    const { data } = await getItem(created.id);

    expect(data.capturedText).toBe(data.rawText);
    expect(data.rawVersion).toBe(1);
  });

  it('T018-C01 旧摘要保留但被标记为过期派生数据', async () => {
    const created = capture('会被改动的原文。');
    const organized = applyOrganizeMetadata({
      db,
      current: created,
      organized: {
        title: '旧标题',
        summary: '旧摘要',
        type: 'idea',
        tags: [],
        keywords: [],
        importance: 3,
        relations: [],
      },
      expectedRevision: created.revision,
      expectedRawVersion: created.rawVersion,
      now: new Date().toISOString(),
    });
    expect(organized.changed).toBe(true);

    const afterOrganize = await getItem(created.id);
    const revised = patchItem(db, {
      id: created.id,
      expectedRevision: afterOrganize.data.revision,
      patch: { rawText: '会被改动的原文，现在改了。' },
    });

    const { data } = await getItem(created.id);
    // 清空旧摘要会损失仍有参考价值的信息，所以保留并标记过期。
    expect(data.summary).toBe('旧摘要');
    expect(data.structuredBaseRawVersion).toBe(1);
    expect(data.isStructuredStale).toBe(true);
    expect(data.rawVersion).toBe(revised.rawVersion);
  });
});

describe('T018-C02 HTML 材料按字面存储', () => {
  it('T018-C02 script 与 img 标记原样返回，不被转义或执行', async () => {
    const raw = '<script>alert(1)</script><img src="http://evil.example/x.png">';
    const created = capture(raw);

    const { data } = await getItem(created.id);

    // 服务端是纯数据通道：一个字符都不该被改写，否则看到的原文就不是用户存的原文。
    expect(data.rawText).toBe(raw);
    expect(data.capturedText).toBe(raw);
    // 真正的保护是响应形态：content-type 是 JSON 且带 nosniff，浏览器不会把正文
    // 当 HTML 文档解析，因此这里的 script 标记不可能成为同源脚本入口。
    const { GET } = await import('@/app/api/items/[id]/route');
    const raw_response = await GET(new Request(`http://127.0.0.1:3000/api/items/${created.id}`, {
      headers: sessionHeaders(),
    }), { params: Promise.resolve({ id: created.id }) });
    expect(raw_response.headers.get('content-type')).toContain('application/json');
    expect(raw_response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('T018-C03 恶意来源', () => {
  it('T018-C03 javascript: 协议被当作字面文本返回，服务端不生成链接', async () => {
    const created = capture('来源是一条恶意链接。', 'javascript:alert(document.cookie)');

    const { data } = await getItem(created.id);

    // sourceRef 是来源记录，不是 href：服务端只回字符串，协议判定属于展示层。
    expect(data.sourceRef).toBe('javascript:alert(document.cookie)');
    expect(typeof data.sourceRef).toBe('string');
  });

  it('T018-C03 超长 sourceRef 被拒绝，不存在绕过长度限制的写入路径', async () => {
    const created = capture('来源过长。');
    const { PATCH } = await import('@/app/api/items/[id]/route');
    const tooLong = `https://example.com/${'a'.repeat(LIMITS.sourceRefCodePoints)}`;
    expect(Array.from(tooLong).length).toBeGreaterThan(LIMITS.sourceRefCodePoints);

    const response = await callRoute(PATCH, {
      method: 'PATCH',
      path: `/api/items/${created.id}`,
      body: { expectedRevision: created.revision, patch: { sourceRef: tooLong } },
      params: { id: created.id },
    });

    expect(response.status).toBe(400);
    const failure = response.envelope as {
      ok: false;
      error: { fieldErrors?: Record<string, string[]> };
    };
    // 字段定位在 wire 层带上了 `patch.` 前缀（zod path 是 patch.sourceRef），
    // 界面按后缀匹配也能拿到这条消息。
    const named = Object.keys(failure.error.fieldErrors ?? {});
    expect(named.some((key) => key === 'sourceRef' || key.endsWith('.sourceRef'))).toBe(true);
    const { data } = await getItem(created.id);
    expect(data.sourceRef).toBeNull();
    // 被拒绝的写入没有推进版本。
    expect(data.revision).toBe(created.revision);
  });

  it('T018-C03 正常 http 来源原样返回，来源是领域数据而不是草稿', async () => {
    const created = capture('带正常来源的原文。', 'https://example.com/article');
    const { data } = await getItem(created.id);
    expect(data.sourceRef).toBe('https://example.com/article');
    expect(data.sourceType).toBe('other');
  });
});

describe('T018-C05 删除竞态', () => {
  it('T018-C05 抽屉打开时条目被删除：详情返回 404，不是 500 或空对象', async () => {
    const created = capture('会被另一个标签页删掉。');
    db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(created.id);

    const { GET } = await import('@/app/api/items/[id]/route');
    const response = await callRoute(GET, {
      method: 'GET',
      path: `/api/items/${created.id}`,
      params: { id: created.id },
    });

    expect(response.status).toBe(404);
    const failure = response.envelope as {
      ok: false;
      error: { code: string; retryable: boolean };
    };
    expect(failure.error.code).toBe('NOT_FOUND');
    // retryable=false 是「不要无限重试」的判据：读取 404 不能被当成临时网络故障。
    expect(failure.error.retryable).toBe(false);
  });

  it('T018-C05 不存在的 id 与已删除的 id 得到同一个规范结果', async () => {
    const never = newId();
    const deleted = capture('刚被删掉。');
    db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(deleted.id);

    const a = await getItem(never);
    const b = await getItem(deleted.id);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
  });
});

describe('T018-C06 图谱回溯到同一条记录', () => {
  it('T018-C06 从视图来源 id 经 /api/items/[id] 读到与资料库完全相同的记录', async () => {
    const source = capture('视图引用这条材料。', 'https://example.com/source');
    const fromView = await getItem(source.id);
    const fromLibrary = await getItem(source.id);

    // 同一个 id 只能有一条记录：视图中的文字不能成为断开的副本。
    expect(fromView.data.id).toBe(source.id);
    expect(fromView.data.rawText).toBe(fromLibrary.data.rawText);
    expect(fromView.data.rawVersion).toBe(fromLibrary.data.rawVersion);
    expect(fromView.data.revision).toBe(fromLibrary.data.revision);
    expect(fromView.data.capturedText).toBe(source.capturedText);
  });

  it('T018-C06 详情返回完整 DTO 字段集，界面不必自己猜缺省含义', async () => {
    const created = capture('字段完整性。');
    const { data } = await getItem(created.id);

    const required: (keyof ItemDTO)[] = [
      'id',
      'capturedText',
      'rawText',
      'rawVersion',
      'revision',
      'structuredBaseRawVersion',
      'title',
      'summary',
      'type',
      'tags',
      'keywords',
      'importance',
      'manualFields',
      'status',
      'lastRunId',
      'error',
      'sourceType',
      'sourceRef',
      'createdAt',
      'updatedAt',
      'isStructuredStale',
    ];
    for (const field of required) {
      expect(Object.hasOwn(data, field), `缺少字段 ${field}`).toBe(true);
    }
    // nullable 字段返回 null，而不是缺省。
    expect(data.structuredBaseRawVersion).toBeNull();
    expect(data.lastRunId).toBeNull();
    expect(data.error).toBeNull();
    expect(data.sourceRef).toBeNull();
  });
});
