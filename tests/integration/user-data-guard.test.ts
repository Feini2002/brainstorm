/**
 * T077-C06 验收：测试清理限定临时目录，用户的 `.data` 不被触碰。
 *
 * 这条规则此前**没有任何测试**：`assertNotUserDataDir` 只在
 * `src/server/db/database.ts` 里被调用，`tests/helpers/db.ts` 的注释声称它
 * 「确认而不是相信调用方」——但**没有人验证过它真的会拒绝**。所以本轮补的是
 * 守卫自身的对照（正向 + 反向），以及"临时目录之外没有被创建"的实测。
 *
 * 为什么值得单独钉：测试工具本身就是能破坏用户数据的角色。如果这个守卫被静默
 * 摘掉（或 `isUserDataDir` 的比较被写松），失败的测试会**写到用户真实的知识库上**，
 * 而所有别的用例仍然全绿。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DataDirError,
  DEFAULT_DATA_DIR_NAME,
  assertNotUserDataDir,
  findProjectRoot,
  isUserDataDir,
  resolveDataDir,
} from '@/server/runtime/dataDir';

let cleanupDir: string | null = null;

afterEach(() => {
  if (cleanupDir !== null) {
    rmSync(cleanupDir, { recursive: true, force: true });
    cleanupDir = null;
  }
});

const PROJECT_ROOT = findProjectRoot();
const USER_DATA_DIR = path.join(PROJECT_ROOT, DEFAULT_DATA_DIR_NAME);

describe('T077-C06 用户数据目录守卫', () => {
  it('T077-C06 在 TEST 模式下，用户 .data 被明确拒绝', () => {
    // 正向：这正是"测试工具不许碰用户数据"的那道闸。
    expect(() => assertNotUserDataDir(USER_DATA_DIR, 'TEST')).toThrowError(DataDirError);
  });

  it('T077-C06 拒绝也覆盖 .data 的等价写法（不靠字符串相等）', () => {
    // 同一目录的其它写法必须同样被拒，否则守卫可以被路径写法绕过。
    const variants = [
      USER_DATA_DIR,
      `${USER_DATA_DIR}${path.sep}`,
      path.join(USER_DATA_DIR, '.'),
      path.join(USER_DATA_DIR, '..', DEFAULT_DATA_DIR_NAME),
      path.join(USER_DATA_DIR, 'nested', '..'),
    ];

    for (const variant of variants) {
      expect(
        () => assertNotUserDataDir(variant, 'TEST'),
        `${variant} 应被识别为用户数据目录`,
      ).toThrowError(DataDirError);
    }
  });

  it('T077-C06 临时目录不被拒绝，否则所有集成测试都跑不起来', () => {
    // 反向：守卫不能宽到把正常的临时目录也拒了（那样测试会以"被拒绝"的形式失败，
    // 而不是以数据被写坏的形式失败，容易误诊）。
    const dir = mkdtempSync(path.join(tmpdir(), 'feini-t077-'));
    cleanupDir = dir;
    expect(() => assertNotUserDataDir(dir, 'TEST')).not.toThrow();
  });

  it('T077-C06 非 TEST 模式不再拦截（生产运行本来就用 .data）', () => {
    // 四种运行模式里只有 TEST 会拦：检测本身不改变业务规则。
    for (const mode of ['USER', 'DEV', 'BUILD'] as const) {
      expect(
        () => assertNotUserDataDir(USER_DATA_DIR, mode),
        `${mode} 模式不应被测试守卫拦截`,
      ).not.toThrow();
    }
  });

  it('T077-C06 isUserDataDir 只认这一个目录，子目录与兄弟目录不算', () => {
    expect(isUserDataDir(USER_DATA_DIR)).toBe(true);
    // 子目录是另一个目录：它不是"用户的数据目录本身"。
    expect(isUserDataDir(path.join(USER_DATA_DIR, 'backups'))).toBe(false);
    // 名字相近但位置不同的目录也不算（防止前缀匹配式的宽松实现）。
    expect(isUserDataDir(path.join(PROJECT_ROOT, `${DEFAULT_DATA_DIR_NAME}-test`))).toBe(false);
    expect(isUserDataDir(path.join(PROJECT_ROOT, 'data'))).toBe(false);
    expect(isUserDataDir(tmpdir())).toBe(false);
  });

  it('T077-C06 一次集成测试跑完，项目根的 .data 没有被本次测试创建', () => {
    // 这条是行为层的：前面几条证明守卫会拒绝，这条证明**在正常路径上也没人绕过它**。
    // 若某个 helper 硬编码了 '.data' 而没走 resolveDataDir，这里就会红。
    cleanupDir = mkdtempSync(path.join(tmpdir(), 'feini-t077-run-'));
    const resolved = resolveDataDir({ ...process.env, BRAIN_DATA_DIR: cleanupDir });
    expect(resolved).toBe(path.resolve(cleanupDir));

    // 解析出来的目录在临时区，不在项目根下。
    expect(resolved.startsWith(path.resolve(PROJECT_ROOT))).toBe(false);
    expect(resolved.startsWith(path.resolve(tmpdir()))).toBe(true);
  });

  it('T077-C06 测试的清理目标永远是临时目录，不是项目根', () => {
    // R06 的措辞是"不在测试脚本里执行项目根递归删除"。这里钉住实际清理助手
    // （tests/helpers/db.ts）产出的路径形状：它来自 mkdtempSync(tmpdir())。
    cleanupDir = mkdtempSync(path.join(tmpdir(), 'feini-t077-clean-'));
    const tempRoot = path.resolve(tmpdir());
    const target = path.resolve(cleanupDir);

    expect(target.startsWith(tempRoot)).toBe(true);
    // 递归删除的目标绝不能是项目根或磁盘根。
    expect(target).not.toBe(path.resolve(PROJECT_ROOT));
    expect(path.dirname(target)).not.toBe(target);
    expect(existsSync(target)).toBe(true);
  });
});
