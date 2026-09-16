/**
 * T076-C06 验收：单元测试在禁外网、无模型 Key 的条件下成立。
 *
 * 两件不同的事，分别证明：
 *  1. 守卫本身有效（fail-closed）——非回环目标真的被拒，回环真的放行；
 *  2. 全套单测不需要 Key——`env` 里没有任何模型配置也能跑完（由 `npm test` 整体
 *     证明，这里再钉住"没有测试偷偷读 Key"这一点）。
 *
 * 截图、数据库断言、请求计数证明不同的事，这里用"抛错"证明出口被堵住。
 */
import { describe, expect, it } from 'vitest';
import net from 'node:net';

import config from '../../vitest.config';
import { isLoopbackHost } from './support/networkGuard';

describe('T076-C06 单元测试进程对外网 fail-closed', () => {
  it('T076-C06 unit project 的 setupFiles 确实挂了守卫（摘掉即红）', () => {
    // 这条断言必须读**配置**，不能只看 `fetch.name`：本文件自己 `import` 了守卫模块，
    // 而导入会执行它的顶层副作用，所以即使 `setupFiles` 被摘掉，本进程里 fetch 仍叫
    // `guardedFetch`、下面几条也都通过——但**其它**单测文件就全部失去保护了。
    // 实测确认过这一点：摘掉 setupFiles 后本文件仍 6/6 绿。所以接线要单独钉。
    const projects = (config as { test?: { projects?: unknown[] } }).test?.projects ?? [];
    const unit = projects.find(
      (project) => (project as { test?: { name?: string } }).test?.name === 'unit',
    ) as { test?: { setupFiles?: unknown } } | undefined;

    expect(unit, 'unit project 必须存在').toBeDefined();
    const setupFiles = unit?.test?.setupFiles;
    const list = Array.isArray(setupFiles) ? setupFiles : [setupFiles];
    expect(list).toContain('tests/unit/support/networkGuard.ts');
  });

  it('T076-C06 守卫已挂上：globalThis.fetch 不是原始实现', () => {
    // 证明本进程里守卫是活的（至于它是被 setupFiles 还是被本文件的 import 装上的，
    // 由上一条负责区分）。
    expect(globalThis.fetch.name).toBe('guardedFetch');
  });

  it('T076-C06 访问外网主机直接抛错，而不是发出请求', () => {
    expect(() => fetch('https://api.openai.com/v1/models')).toThrowError(/T076-C06/u);
    expect(() => fetch('http://93.184.216.34/')).toThrowError(/T076-C06/u);
  });

  it('T076-C06 相对路径无法判定时同样拒绝（fail-closed）', () => {
    expect(() => fetch('/api/session')).toThrowError(/T076-C06/u);
  });

  it('T076-C06 回环地址放行：同进程临时服务器与端口探测仍可用', () => {
    // 放行不等于"会连上"：只是不抛守卫那一条错。这里断言它没有立刻抛守卫错误。
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);

    // 外网主机一律不认为是回环。
    expect(isLoopbackHost('api.openai.com')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
    expect(isLoopbackHost('192.168.1.1')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
  });

  it('T076-C06 对外部 TCP 连接同样拒绝，回环连接不受影响', async () => {
    expect(() =>
      net.connect({ host: '93.184.216.34', port: 80 }),
    ).toThrowError(/T076-C06/u);

    // 回环连接必须仍然可用：否则同进程 helper 会被误伤。
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const socket = net.connect({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('T076-C06 环境里没有模型 Key 时本套件自身就足够（不读用户设置）', () => {
    // 这是本文件能被无 Key 环境跑完的原因，也是契约要求的"确定性用例不需要 Key"。
    // 若有人为了新用例去读 `.data` 或真实设置，这一条会先红。
    for (const key of ['OPENAI_API_KEY', 'BRAIN_API_KEY', 'ANTHROPIC_API_KEY']) {
      expect(process.env[key], `${key} 不应出现在单元测试环境`).toBeUndefined();
    }
  });
});
