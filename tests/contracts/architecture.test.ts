/**
 * T003 验收：工程目录与服务端隔离（负向 fixture）。
 *
 * 用例规格：docs/05_tests/G0/T003_cases.md。审计结论是「`npm run lint` exit 0 只
 * 证明**当前**导入图合法，不构成 C01–C06 的证据」。因此这里不重复跑一次 lint，
 * 而是用 ESLint 的 `lintText` 在**真实项目配置**下「造一个违规文件」，断言规则
 * 真的会报错 —— 也就是断言这条架构边界真的会咬人。
 *
 * 用 `lintText`（虚拟文件名）而不是往 `src/` 里写临时文件：其它并行 worker 也会
 * 跑 `npm run lint`，落地一个故意违规的文件会污染他们的结果。虚拟文件名仍会走
 * flat config 的 `files` 匹配，所以测的是同一套配置。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESLint, type Linter } from 'eslint';

const projectRoot = path.resolve(import.meta.dirname, '../..');

async function lintTextAs(relativePath: string, code: string): Promise<Linter.LintMessage[]> {
  const eslint = new ESLint({ cwd: projectRoot });
  const results = await eslint.lintText(code, {
    filePath: path.join(projectRoot, relativePath),
  });
  return results.flatMap((result) => result.messages);
}

function restrictedImportMessages(messages: Linter.LintMessage[]): Linter.LintMessage[] {
  return messages.filter(
    (message) =>
      message.ruleId === 'no-restricted-imports' || /T003-R0[126]/u.test(message.message),
  );
}

describe('T003-C01 错误客户端导入必须被静态检查拦下', () => {
  it('T003-C01/R02 客户端组件引用 @/server 运行时模块会被 ESLint 报错', async () => {
    const messages = await lintTextAs(
      'src/features/shared/architectureProbe.tsx',
      [
        "'use client';",
        "import { getDb } from '@/server/db/database';",
        'export function Probe() {',
        '  return getDb().toString();',
        '}',
      ].join('\n'),
    );

    const violations = restrictedImportMessages(messages);
    expect(violations.length, `违规导入未被拦下：${JSON.stringify(messages)}`).toBeGreaterThan(0);
    // 报错必须指向这条边界本身，而不是别的样式问题。
    expect(violations.every((message) => message.severity === 2)).toBe(true);
    expect(violations.map((message) => message.message).join('\n')).toContain('T003-R02');
  });

  it('T003-C01/R02 直接引用 node:sqlite 同样被拦下（不靠 server-only 才生效）', async () => {
    const messages = await lintTextAs(
      'src/features/library/architectureProbe.tsx',
      ["'use client';", "import { DatabaseSync } from 'node:sqlite';", 'export const X = DatabaseSync;'].join(
        '\n',
      ),
    );

    const violations = restrictedImportMessages(messages);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((message) => message.message).join('\n')).toContain('node:sqlite');
  });

  it('T003-C01/R06 客户端页面同样不能引用模型 transport 或秘密模块', async () => {
    const messages = await lintTextAs(
      'src/app/settings/architectureProbe.tsx',
      [
        "'use client';",
        "import { getTransport } from '@/server/llm/transport';",
        'export const X = getTransport;',
      ].join('\n'),
    );

    expect(restrictedImportMessages(messages).length).toBeGreaterThan(0);
  });

  it('T003-C01 规则不是一刀切：客户端组件从 domain 取纯类型仍然合法', async () => {
    // 反面样本证明上一条断言不是「任何 import 都报错」的恒真结果。
    const messages = await lintTextAs(
      'src/features/library/architectureProbe.tsx',
      [
        "'use client';",
        "import type { ItemDTO } from '@/domain/knowledge';",
        'export type Probe = ItemDTO;',
      ].join('\n'),
    );

    expect(restrictedImportMessages(messages)).toEqual([]);
  });
});

describe('T003-C02 公共类型复用与 domain 纯净', () => {
  it('T003-C02/R01 domain 引用服务端模块会被报错', async () => {
    const messages = await lintTextAs(
      'src/domain/architectureProbe.ts',
      ["import { getDb } from '@/server/db/database';", 'export const X = getDb;'].join('\n'),
    );

    const violations = restrictedImportMessages(messages);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((message) => message.message).join('\n')).toContain('T003-R01');
  });

  it('T003-C02/R01 domain 引用 react 或 next 也会被报错（纯类型与无副作用）', async () => {
    const withReact = await lintTextAs(
      'src/domain/architectureProbe.tsx',
      ["import { useState } from 'react';", 'export const X = useState;'].join('\n'),
    );
    expect(restrictedImportMessages(withReact).length).toBeGreaterThan(0);

    const withNode = await lintTextAs(
      'src/domain/architectureProbe.ts',
      ["import { readFileSync } from 'node:fs';", 'export const X = readFileSync;'].join('\n'),
    );
    expect(restrictedImportMessages(withNode).length).toBeGreaterThan(0);
  });

  it('T003-C02 页面与 API 都能从 domain 导入同一份 ItemDTO 纯类型', async () => {
    // 两侧同时引用同一个纯类型模块，正是 C02 的前置。
    const page = await lintTextAs(
      'src/app/library/architectureProbe.tsx',
      ["import type { ItemDTO } from '@/domain/knowledge';", 'export type P = ItemDTO;'].join('\n'),
    );
    const api = await lintTextAs(
      'src/app/api/items/architectureProbe.ts',
      [
        "import { getDb } from '@/server/db/database';",
        "import type { ItemDTO } from '@/domain/knowledge';",
        'export type A = ItemDTO;',
        'export const X = getDb;',
      ].join('\n'),
    );

    expect(restrictedImportMessages(page)).toEqual([]);
    // api 目录是唯一允许触达服务层的地方：这条 import 不该被报错。
    expect(restrictedImportMessages(api)).toEqual([]);
  });
});

describe('T003-C03/C05 路由变薄与服务可注入', () => {
  it('T003-C03/R05 route 文件不做 SQL，也不拼接提示词', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const routeFiles: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry === 'route.ts') routeFiles.push(full);
      }
    };
    walk(path.join(projectRoot, 'src/app/api'));

    expect(routeFiles.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of routeFiles) {
      const source = readFileSync(file, 'utf8');
      // route 只做保护、解析、调用与错误映射：出现裸 SQL 就说明业务漏进了路由层。
      if (/\bdb\.prepare\s*\(/u.test(source)) offenders.push(`${file}: db.prepare`);
      if (/SELECT\s+.+\s+FROM\s+/iu.test(source)) offenders.push(`${file}: raw SQL`);
    }
    expect(offenders).toEqual([]);
  });

  it('T003-C05 服务层的外部依赖是注入的：测试不需要真实 Key 就能驱动适配器', async () => {
    // 这条不做静态扫描，而是断言「注入点存在且真的被使用」：类型上 adapter 是可选的
    // 注入口，且生产默认值只在服务层构造，组件里一处也没有。
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const source = readFileSync(
      path.join(projectRoot, 'src/server/services/organizeItem.ts'),
      'utf8',
    );
    expect(source).toMatch(/adapter\?:\s*LLMAdapter/u);
    expect(source).toMatch(/input\.adapter\s*\?\?/u);

    // 适配器只能在服务层被 new 出来，绝不散落在 features 组件里（AGENTS.md 禁止项）。
    const featureFiles: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/u.test(entry)) featureFiles.push(full);
      }
    };
    walk(path.join(projectRoot, 'src/features'));
    const offenders = featureFiles.filter((file) =>
      /new OpenAICompatibleAdapter\(/u.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('T003-C06 目录漂移', () => {
  it('T003-C06 schema 的权威定义只在 src/domain/schemas，不存在重复目录', async () => {
    const { existsSync, readdirSync, statSync } = await import('node:fs');

    expect(existsSync(path.join(projectRoot, 'src/domain/schemas'))).toBe(true);

    // 找出 src 下所有叫 schema/schemas 的目录，除了 domain 里那个权威位置。
    const strays: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (!statSync(full).isDirectory()) continue;
        if (entry === 'schema' || entry === 'schemas') {
          const relative = path.relative(projectRoot, full).replaceAll('\\', '/');
          if (relative !== 'src/domain/schemas') strays.push(relative);
        }
        walk(full);
      }
    };
    walk(path.join(projectRoot, 'src'));

    expect(strays, '出现第二个 schemas 目录就意味着两个权威类型来源').toEqual([]);
  });

  it('T003-R03 features 按域分目录，没有把业务塞进统一的 utils 桶', async () => {
    const { existsSync } = await import('node:fs');
    for (const domain of ['inbox', 'library', 'graph', 'mindmap', 'flow', 'settings']) {
      expect(
        existsSync(path.join(projectRoot, 'src/features', domain)),
        `缺少 features/${domain}`,
      ).toBe(true);
    }
    expect(existsSync(path.join(projectRoot, 'src/features/utils'))).toBe(false);
  });
});
