/**
 * 脚本化 provider 缝（T061 闭环验收的支撑装置）。
 *
 * 验收用例必须在真实路由、真实适配器和真实事务上跑，只把「模型那一次出站 HTTP」
 * 换成固定样本。这里钉住那条缝的边界：默认关闭、拒绝用户真实数据目录、缺文件
 * 直接失败而不是偷偷走网络，以及同一文件内容才复用请求序号。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AppError } from '@/domain/errors';
import {
  FetchTransport,
  getTransport,
  scriptedProviderPath,
  setTransport,
  type TransportRequest,
} from '@/server/llm/transport';

const KEY_STORE = 'BRAIN_SCRIPTED_PROVIDER';
const DIR_STORE = 'BRAIN_DATA_DIR';

let scratch: string | null = null;

function workspace(): string {
  scratch ??= mkdtempSync(path.join(tmpdir(), 'brain-scripted-'));
  return scratch;
}

/** A script file whose `replies` answer the next N requests. */
function writeScript(name: string, replies: unknown[], token = 'v1'): string {
  const file = path.join(workspace(), `${name}.json`);
  writeFileSync(file, JSON.stringify({ token, replies }), 'utf8');
  return file;
}

const request: TransportRequest = {
  url: 'https://api.example.com/v1/chat/completions',
  method: 'POST',
  headers: { Authorization: 'Bearer sk-canary-0000000000000000' },
  body: '{"model":"m","messages":[]}',
  timeoutMs: 1000,
};

afterEach(() => {
  setTransport(null);
  delete process.env[KEY_STORE];
  delete process.env[DIR_STORE];
});

describe('T061 脚本化 provider 缝', () => {
  it('未设置变量时仍然是真实的 FetchTransport，行为不变', () => {
    process.env[DIR_STORE] = workspace();
    delete process.env[KEY_STORE];

    expect(scriptedProviderPath()).toBeNull();
    expect(getTransport()).toBeInstanceOf(FetchTransport);
  });

  it('拒绝用户真实数据目录，即使变量指向合法文件', () => {
    // 不设置 BRAIN_DATA_DIR：默认解析到仓库根的 .data，也就是用户自己的库。
    delete process.env[DIR_STORE];
    process.env[KEY_STORE] = writeScript('ok', [{ content: 'hi' }]);

    expect(() => getTransport()).toThrowError(AppError);
    expect(() => getTransport()).toThrowError(/隔离数据目录/);
  });

  it('变量指向不存在的文件时直接失败，不退化成真实网络调用', () => {
    process.env[DIR_STORE] = workspace();
    process.env[KEY_STORE] = path.join(workspace(), 'missing.json');

    expect(() => getTransport()).toThrowError(/路径不存在/);
  });

  it('按顺序回放，并在文件内容变化时把序号重置', async () => {
    process.env[DIR_STORE] = workspace();
    const file = writeScript('sequence', [
      { content: '第一版' },
      { content: '第二版' },
    ]);
    process.env[KEY_STORE] = file;

    const transport = getTransport();
    const first = await transport.send(request);
    const second = await transport.send(request);
    // 越界后复用最后一条，修复重试才有固定答案。
    const third = await transport.send(request);

    expect(JSON.parse(first.bodyText).choices[0].message.content).toBe('第一版');
    expect(JSON.parse(second.bodyText).choices[0].message.content).toBe('第二版');
    expect(JSON.parse(third.bodyText).choices[0].message.content).toBe('第二版');

    // 同一个进程服务整个套件：下一个用例重写文件后必须从第一条开始。
    writeScript('sequence', [{ content: '第三版' }], 'v2');
    const afterRewrite = await getTransport().send(request);
    expect(JSON.parse(afterRewrite.bodyText).choices[0].message.content).toBe('第三版');
  });

  it('用 bodyText 覆盖非 JSON 与错误状态，供协议层用例使用', async () => {
    process.env[DIR_STORE] = workspace();
    process.env[KEY_STORE] = writeScript('raw', [
      { status: 200, bodyText: '这不是 JSON', headers: { 'content-type': 'text/plain' } },
      { status: 429, bodyText: '{"error":{"message":"rate limited"}}' },
    ]);

    const transport = getTransport();
    const raw = await transport.send(request);
    expect(raw.status).toBe(200);
    expect(raw.bodyText).toBe('这不是 JSON');
    expect(raw.headers['content-type']).toBe('text/plain');

    const limited = await transport.send(request);
    expect(limited.status).toBe(429);
  });

  it('脚本格式错误时给出可诊断的错误，而不是静默成功', async () => {
    process.env[DIR_STORE] = workspace();

    const empty = path.join(workspace(), 'empty.json');
    writeFileSync(empty, JSON.stringify({ replies: [] }), 'utf8');
    process.env[KEY_STORE] = empty;
    await expect(getTransport().send(request)).rejects.toThrowError(/非空的 replies/);

    const broken = path.join(workspace(), 'broken.json');
    writeFileSync(broken, '{ not json', 'utf8');
    process.env[KEY_STORE] = broken;
    await expect(getTransport().send(request)).rejects.toThrowError(/不是合法 JSON/);
  });

  it('同一进程内切换脚本文案后，读取的是新的那一份', async () => {
    process.env[DIR_STORE] = workspace();
    process.env[KEY_STORE] = writeScript('switch-a', [{ content: 'A' }]);

    const first = await getTransport().send(request);
    expect(JSON.parse(first.bodyText).choices[0].message.content).toBe('A');

    process.env[KEY_STORE] = writeScript('switch-b', [{ content: 'B' }]);
    const second = await getTransport().send(request);
    expect(JSON.parse(second.bodyText).choices[0].message.content).toBe('B');
  });

  it('指向目录时回放最新写入的脚本，空目录直接失败', async () => {
    process.env[DIR_STORE] = workspace();
    const dir = path.join(workspace(), 'scripts');
    mkdirSync(dir, { recursive: true });
    process.env[KEY_STORE] = dir;

    // 目录里一个脚本都没有：不是「没有替换」，而是配置错误。
    await expect(getTransport().send(request)).rejects.toThrowError(/没有脚本/);

    // 连续写入两个脚本，模拟同一个服务进程服务两个用例。
    writeFileSync(path.join(dir, '01-case.json'), JSON.stringify({ replies: [{ content: '先' }] }));
    const first = await getTransport().send(request);
    expect(JSON.parse(first.bodyText).choices[0].message.content).toBe('先');

    writeFileSync(path.join(dir, '02-case.json'), JSON.stringify({ replies: [{ content: '后' }] }));
    const second = await getTransport().send(request);
    expect(JSON.parse(second.bodyText).choices[0].message.content).toBe('后');

    // 同一个脚本被再读一次时，序号从内容不变这一点上得以延续。
    const third = await getTransport().send(request);
    expect(JSON.parse(third.bodyText).choices[0].message.content).toBe('后');
  });
});
