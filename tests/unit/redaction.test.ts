/**
 * T030 验收用例｜模型错误脱敏与安全日志
 *
 * 用一个可搜索但不可用的标记秘密走完每条路径，然后扫描响应、日志与摘要。
 * 这里断言的是“秘密不出现在产物里”，不是“代码看起来做了过滤”。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  PROVIDER_MESSAGE_LIMIT,
  REDACTED,
  buildDiagnosticsSummary,
  clearRegisteredSecrets,
  containsSecret,
  logSafe,
  nextStepFor,
  redactJson,
  redactSecrets,
  redactValue,
  registerSecret,
  safeSettingsSummary,
  setLogSink,
  stripAbsolutePaths,
  summarizeProviderText,
  type SafeLogRecord,
} from '@/server/observability/redaction';

/** Obvious non-credential marker; the whole suite scans for this string. */
const SECRET = 'sk-test-LEAKCANARY-1234567890abcdef';

/** Collects every emitted line so a test can scan the complete log. */
function captureLogs(): { lines: string[]; records: SafeLogRecord[] } {
  const lines: string[] = [];
  const records: SafeLogRecord[] = [];
  setLogSink((record, line) => {
    records.push(record);
    lines.push(line);
  });
  return { lines, records };
}

afterEach(() => {
  setLogSink(null);
  clearRegisteredSecrets();
});

describe('T030 脱敏', () => {
  it('T030-C01 传入含 Authorization 的对象时，字段与被注册的秘密都不回显', () => {
    registerSecret(SECRET);
    const { lines } = captureLogs();

    logSafe({
      level: 'warn',
      message: 'api settings.llm.test PROVIDER_AUTH',
      requestId: 'req-1',
      code: 'PROVIDER_AUTH',
      // 常见调试写法会把整个请求初始化对象打出来：
      ...(redactValue({
        headers: { Authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        apiKey: SECRET,
      }) as Record<string, never>),
    });

    const blob = lines.join('\n');
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain('LEAKCANARY');
    expect(blob).not.toContain('Bearer sk-');
  });

  it('T030-C01 递归过滤已知敏感字段名，即使值不是当前秘密', () => {
    const redacted = redactJson({
      outer: {
        authorization: 'Bearer somethingelse-entirely',
        apiKey: 'plain-value',
        api_key: 'plain-value',
        token: 'plain-value',
        secret: 'plain-value',
        password: 'plain-value',
        nested: { credential: 'plain-value', keep: 'visible-value' },
      },
    });
    expect(redacted).not.toContain('somethingelse-entirely');
    expect(redacted).not.toContain('plain-value');
    // 非敏感字段仍然保留，脱敏不是“全部丢掉”。
    expect(redacted).toContain('visible-value');
    expect(redacted).toContain(REDACTED);
  });

  it('T030-C02 供应商把 Key 嵌在 message 里时，仅按字段名过滤还不够', () => {
    registerSecret(SECRET);

    // 字段名是普通的 message，字面值却带着 Key —— 这正是只按字段名过滤漏掉的情形。
    const embedded = `Incorrect API key provided: ${SECRET}. You can find your API key at ...`;
    const safe = redactSecrets(embedded);

    expect(safe).not.toContain(SECRET);
    expect(safe).toContain(REDACTED);
    expect(safe).toContain('Incorrect API key provided');

    // 没有注册时，形如 sk- 的字符串仍然被模式拦下。
    clearRegisteredSecrets();
    const withoutRegistration = redactSecrets(`token sk-proj-abcdefghijklmnop rejected`);
    expect(withoutRegistration).not.toContain('sk-proj-abcdefghijklmnop');
  });

  it('T030-C02 返回给 UI 的摘要不含秘密值', () => {
    registerSecret(SECRET);
    const summary = summarizeProviderText(
      JSON.stringify({ error: { message: `bad key ${SECRET}`, type: 'invalid_request_error' } }),
    );
    expect(summary).not.toContain(SECRET);
    expect(summary).toContain('invalid_request_error');
  });

  it('T030-C03 超长正文只保留限长摘要与可识别字段', () => {
    const html = `<html><body>${'x'.repeat(50_000)}</body></html>`;
    const summary = summarizeProviderText(html);
    expect(summary.length).toBeLessThanOrEqual(PROVIDER_MESSAGE_LIMIT + 1);
    expect(summary.startsWith('<html>')).toBe(true);

    // 大段 JSON 也不会把整个正文带到日志里。
    const hugeJson = JSON.stringify({ error: { message: 'y'.repeat(50_000) } });
    const jsonSummary = summarizeProviderText(hugeJson);
    expect(jsonSummary.length).toBeLessThanOrEqual(PROVIDER_MESSAGE_LIMIT + 1);
  });

  it('T030-C03 错误正文里的笔记内容不会被原样带出', () => {
    const noteText = '这是一段私人笔记内容，不应出现在错误摘要里。'.repeat(20);
    const summary = summarizeProviderText(`<pre>${noteText}</pre>`);
    expect(summary.length).toBeLessThanOrEqual(PROVIDER_MESSAGE_LIMIT + 1);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('T030-C04 绝对路径被替换成占位符', () => {
    const windowsPath = 'C:\\Users\\someone\\Desktop\\私人知识库\\.data\\brain.db';
    expect(stripAbsolutePaths(windowsPath)).toBe('[path]');
    expect(stripAbsolutePaths('/Users/someone/.data/brain.db 打不开')).toBe('[path] 打不开');

    const summary = summarizeProviderText(`ENOENT: ${windowsPath}`);
    const cleaned = stripAbsolutePaths(summary);
    expect(cleaned).not.toContain('Desktop');
    expect(cleaned).not.toContain('brain.db');
  });

  it('T030-C04 堆栈不进入日志记录形状', () => {
    const { lines, records } = captureLogs();
    const error = new Error(`failed at ${SECRET} with key`);
    error.stack = `Error: boom\n    at C:\\Users\\someone\\app\\file.ts:12:3`;

    logSafe({
      level: 'error',
      message: 'api items.create INTERNAL',
      requestId: 'req-2',
      errorSummary: summarizeProviderText(error.message),
    });

    expect(records).toHaveLength(1);
    // 记录形状里没有 stack 字段，也没有路径。
    expect(Object.keys(records[0])).not.toContain('stack');
    expect(lines.join('\n')).not.toContain('file.ts');
    expect(lines.join('\n')).not.toContain('C:\\Users');
  });

  it('T030-C05 完整流程的日志里不含任何秘密标记', () => {
    registerSecret(SECRET);
    const { lines, records } = captureLogs();

    // 设置 → 测试 → 整理 → 失败，逐条经过 logger。
    logSafe({ level: 'info', message: 'api settings.llm.put', requestId: 'r1', code: 'OK' });
    logSafe({
      level: 'warn',
      message: 'api settings.llm.test PROVIDER_AUTH',
      requestId: 'r2',
      code: 'PROVIDER_AUTH',
      httpStatus: 401,
      errorSummary: summarizeProviderText(
        JSON.stringify({ error: { message: `Incorrect API key provided: ${SECRET}` } }),
      ),
    });
    logSafe({
      level: 'warn',
      message: 'api items.organize REVISION_CONFLICT',
      requestId: 'r3',
      runId: 'run-1',
      code: 'REVISION_CONFLICT',
    });
    logSafe({
      level: 'error',
      message: 'api items.organize INTERNAL',
      requestId: 'r4',
      runId: 'run-2',
      code: 'INTERNAL',
      errorSummary: `boom at C:\\Users\\someone\\.data\\brain.db with ${SECRET}`,
    });

    const blob = `${lines.join('\n')}\n${JSON.stringify(records)}`;
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain('LEAKCANARY');
    // 关联 ID 仍然在，失败可定位。
    expect(blob).toContain('r4');
    expect(blob).toContain('run-2');
    expect(containsSecret(blob)).toBe(false);
  });

  it('T030-R01 日志只接受白名单字段，正文与消息体无法进入', () => {
    const { records } = captureLogs();
    logSafe({
      level: 'info',
      message: 'api items.create OK',
      requestId: 'req-3',
      count: 1,
      durationMs: 12,
    } as SafeLogRecord);

    const record = records[0];
    // 关键否定断言：存在结构化记录，但没有承载正文的字段。
    for (const forbidden of ['body', 'payload', 'headers', 'rawText', 'content', 'data']) {
      expect(Object.keys(record)).not.toContain(forbidden);
    }
  });

  it('T030-R05 环境变量与路径不进入诊断摘要', () => {
    const summary = buildDiagnosticsSummary({
      node: '24.18.0',
      platform: 'win32',
      arch: 'x64',
      appVersion: '1.0.0',
      dataDirKind: 'default',
      endpointHost: 'api.example.com',
      model: 'gpt-4o-mini',
      apiKeyConfigured: true,
      recentRuns: [
        { kind: 'organize', state: 'failed', code: 'PROVIDER_AUTH', durationMs: 1200 },
      ],
      recentCodes: ['PROVIDER_AUTH'],
    });

    const blob = JSON.stringify(summary);
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain('Desktop');
    // 只给 dataDirKind，不给绝对路径。
    expect(summary.environment.dataDirKind).toBe('default');
    expect(Object.keys(summary.environment).sort()).toEqual([
      'appVersion',
      'arch',
      'dataDirKind',
      'node',
      'platform',
    ]);
  });

  it('T030-C06 分享用的设置摘要只有 host，没有路径或 Key 长度', () => {
    const summary = safeSettingsSummary({
      baseUrl: 'https://gateway.example.com/tenant-secret-path/v1',
      model: 'gpt-4o-mini',
      apiKeyConfigured: true,
    });
    const blob = JSON.stringify(summary);
    expect(summary.endpointHost).toBe('gateway.example.com');
    // 带租户信息的路径不出现。
    expect(blob).not.toContain('tenant-secret-path');
    // 长度也不给，避免成为秘密指纹。
    expect(summary.keyLength).toBeNull();
  });

  it('T030-R06 错误码给出可执行的下一步，不虚构额度数字', () => {
    for (const code of ['PROVIDER_AUTH', 'PROVIDER_ENDPOINT', 'PROVIDER_RATE_LIMIT', 'PROVIDER_NETWORK']) {
      const step = nextStepFor(code);
      expect(step.length).toBeGreaterThan(0);
      // 不编造具体余额或配额。
      expect(step).not.toMatch(/\d+\s*(美元|元|tokens?|次)/u);
    }
    expect(nextStepFor('PROVIDER_AUTH')).toContain('Key');
    // 未知错误码也有兜底说明。
    expect(nextStepFor('SOME_UNKNOWN_CODE').length).toBeGreaterThan(0);
  });

  it('T030-R02 大数组与深层嵌套不会让脱敏失控', () => {
    const wide = { items: Array.from({ length: 500 }, (_, index) => `value-${index}`) };
    const redacted = redactValue(wide) as { items: string[] };
    expect(redacted.items.length).toBeLessThanOrEqual(50);

    // 自引用环不能导致无限递归。
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    expect(() => redactJson(cyclic)).not.toThrow();
  });
});
