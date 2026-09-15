/**
 * T006-C01：客户端提交的「原型同名」字段键必须得到可读的 400，而不是 500。
 *
 * `zodFieldErrors` 与 `parseQuery` 原先用**普通对象字面量**做按名累积的容器，
 * 而键来自客户端。当键命中 `Object.prototype` 的成员（`constructor`、`toString`、
 * `valueOf`、`hasOwnProperty`）时，`fieldErrors[key]` 读到的是原型上的函数而不是
 * 新建累积器应有的 `undefined`，于是 `(fieldErrors[key] ??= []).push(...)` 在一个
 * 函数上调用 `.push`，抛出 `TypeError` 并以 `500 INTERNAL` 逃逸。
 *
 * 契约要求这类输入是**可读的**协议错误（T006-C01）：本应是
 * `400 VALIDATION` 并点名「该字段不允许由客户端提交」，结果却是「服务器出错」。
 *
 * 用例走**真实路由**而不是直接调 helper，因为缺陷发生在「拒绝理由的构造」这一步 ——
 * 只调 helper 会漏掉「异常逃逸到信封」这一半。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ApiEnvelope } from '@/domain/api';
import { createTestDatabase, newId, openTestDatabase, type TestDatabase } from '../helpers/db';
import { callRoute } from './helpers/http';

let harness: TestDatabase;

beforeEach(() => {
  harness = createTestDatabase();
  openTestDatabase(harness.databasePath);
});

afterEach(() => {
  harness.cleanup();
});

interface FieldErrorEnvelope {
  ok: false;
  error: { code: string; fieldErrors?: Record<string, string[]> };
}

const PROTO_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'] as const;

const UNKNOWN_FIELD_MESSAGE = '该字段不允许由客户端提交';

/** Summarise an envelope so a failure says what came back instead of just "not 400". */
function describeEnvelope(envelope: ApiEnvelope<unknown>): string {
  const error = (envelope as { error?: { code?: string; message?: string } }).error;
  return `code=${error?.code ?? '(none)'} message=${error?.message ?? '(none)'}`;
}

describe('T006-C01 原型同名键：查询参数', () => {
  /**
   * `/api/selection` is the documented repeated-parameter route, so it exercises
   * `parseQuery` (the sibling of the helper that threw) on the same request.
   */
  it.each(PROTO_KEYS)('查询参数 %s=x 被拒为 VALIDATION 并点名该字段', async (key) => {
    const { GET } = await import('@/app/api/selection/route');
    const response = await callRoute(GET, {
      method: 'GET',
      path: `/api/selection?itemId=${newId()}&${key}=x`,
    });

    expect(
      response.status,
      `期望可读的 400，实际 ${response.status}：${describeEnvelope(response.envelope)}`,
    ).toBe(400);
    const envelope = response.envelope as FieldErrorEnvelope;
    expect(envelope.error.code).toBe('VALIDATION');
    // Naming the field is the point: without the entry the client cannot mark
    // which input was rejected, which is the readability T006-C01 asks for.
    expect(envelope.error.fieldErrors?.[key]).toEqual([UNKNOWN_FIELD_MESSAGE]);
  });

  it('重复出现的原型同名键也走收集路径，不把原型成员塞进参数数组', async () => {
    const { GET } = await import('@/app/api/selection/route');
    const response = await callRoute(GET, {
      method: 'GET',
      path: `/api/selection?itemId=${newId()}&constructor=a&constructor=b`,
    });

    expect(
      response.status,
      `期望可读的 400，实际 ${response.status}：${describeEnvelope(response.envelope)}`,
    ).toBe(400);
    const envelope = response.envelope as FieldErrorEnvelope;
    expect(envelope.error.code).toBe('VALIDATION');
    expect(envelope.error.fieldErrors?.constructor).toEqual([UNKNOWN_FIELD_MESSAGE]);
  });
});

describe('T006-C01 原型同名键：请求体', () => {
  it.each(PROTO_KEYS)('请求体字段 %s 被拒为 VALIDATION 并点名该字段', async (key) => {
    const { POST } = await import('@/app/api/items/route');
    const response = await callRoute(POST, {
      method: 'POST',
      path: '/api/items',
      body: { captureRequestId: newId(), rawText: '原型同名键样本', [key]: 'x' },
    });

    expect(
      response.status,
      `期望可读的 400，实际 ${response.status}：${describeEnvelope(response.envelope)}`,
    ).toBe(400);
    const envelope = response.envelope as FieldErrorEnvelope;
    expect(envelope.error.code).toBe('VALIDATION');
    expect(envelope.error.fieldErrors?.[key]).toEqual([UNKNOWN_FIELD_MESSAGE]);
  });

  /**
   * `__proto__` is the luckiest of the family: it survives without throwing, but
   * on a plain-object accumulator it lands as array-index keys (`"0"`, `"1"`)
   * instead of an own `"__proto__"` entry — a silent rename. It must be reported
   * under its own name like any other unknown field.
   */
  it('__proto__ 作为普通未知字段被点名，而不是被静默改名', async () => {
    const { POST } = await import('@/app/api/items/route');
    const response = await callRoute(POST, {
      method: 'POST',
      path: '/api/items',
      rawBody: JSON.stringify({
        captureRequestId: newId(),
        rawText: '原型同名键样本',
        ['__proto__']: 'x',
      }),
    });

    expect(
      response.status,
      `期望可读的 400，实际 ${response.status}：${describeEnvelope(response.envelope)}`,
    ).toBe(400);
    const envelope = response.envelope as FieldErrorEnvelope;
    expect(envelope.error.code).toBe('VALIDATION');
    expect(envelope.error.fieldErrors?.['__proto__']).toEqual([UNKNOWN_FIELD_MESSAGE]);
  });
});
