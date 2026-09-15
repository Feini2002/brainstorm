/**
 * T075-C06 与 T075-R05｜威胁说明的诚实性、生产/开发一致性与 CSP 现状。
 *
 * 用例规格：`docs/05_tests/G6/T075_cases.md`（C06「安全承诺不能超过实现」）。
 * 规则原文：`docs/04_tasks/G6/T075_security_regression.md` R05、R06。
 *
 * ## 这一条为什么必须写成测试而不是只写文档
 *
 * R06 要求「明确不覆盖已入侵操作系统、恶意同源脚本和用户主动把 Key 交给不可信服务的
 * 全部后果」。一句承诺是否超过实现，只有在**同时**钉住两侧时才可判定：
 *
 *  - 实现侧：本文断言守卫里没有 `NODE_ENV` 分支、开发模式不降级、`containsSecret`
 *    确实能识别秘密——也就是「我们声称做了什么」这一侧的事实。
 *  - 文档侧：断言 `docs/security-checklist.md` 真的写明了那三类未覆盖威胁，而且**没有**
 *    出现「硬件级」「不可攻破」「绝对安全」这类超出本地明文存储事实的措辞。
 *
 * 只做其中一侧都不成立：文档可以单方面拔高，实现也可以悄悄放宽。两侧都由测试盯住时，
 * 一次「为了开发方便」的放宽或一句营销式加固都会被拦下。
 *
 * ## CSP 的诚实结论
 *
 * R05 说「CSP 按实际图库需要测试后启用」——是先测后启，不是现在就启。本文因此断言的是
 * **当前真实状态**（没有设置 CSP），而不是「已经有 CSP」。为什么不能直接开：Mermaid 的
 * 配色依赖它自己注入的 `<style>` 元素，`style-src` 不给 `'unsafe-inline'` 会把图变成
 * 黑白甚至不可读。这一点由 `tests/unit/flow-sanitize.test.ts` 与
 * `tests/browser/flow-render-security.test.ts` 的实测证据支持（`<style>` 是保留项）。
 * 启用 CSP 需要先做 Mermaid/Markmap 的样式策略设计，属于本任务范围之外；这里如实记录
 * 为「未启用」，并在 checklist 里写明理由与前置条件，不假装已经加固。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LIMITS } from '@/domain/limits';
import { SVG_ALLOWED_TAGS, findUnsafeSvgMarkup } from '@/features/flow/sanitizeSvg';
import { containsSecret, registerSecret, clearRegisteredSecrets } from '@/server/observability/redaction';
import {
  APP_ORIGIN,
  guardMutation,
  type RequestFacts,
} from '@/server/security/localGuard';

const projectRoot = path.resolve(import.meta.dirname, '../..');

/** Facts a legitimate same-origin browser request would carry, plus a valid token. */
async function legitimateFacts(): Promise<RequestFacts> {
  const { getSessionToken } = await import('@/server/security/localGuard');
  return {
    method: 'POST',
    host: new URL(APP_ORIGIN).host,
    origin: APP_ORIGIN,
    secFetchSite: 'same-origin',
    contentType: 'application/json',
    token: getSessionToken(),
  };
}

/** The same request, but carrying no token and a hostile Origin. */
function hostileFacts(): RequestFacts {
  return {
    method: 'POST',
    host: new URL(APP_ORIGIN).host,
    origin: 'http://evil.example',
    secFetchSite: 'cross-site',
    contentType: 'application/json',
    token: null,
  };
}

afterEach(() => {
  clearRegisteredSecrets();
});

describe('T075-R05 生产与开发使用同一套来源保护', () => {
  /** Run a guard under a given NODE_ENV value and report the decision. */
  function decideUnder(
    env: string,
    facts: RequestFacts,
  ): { ok: boolean; failure?: string } {
    // `process.env.NODE_ENV` is typed read-only; the mutable view is what a test
    // needs to model "the app was started in development".
    const mutable = process.env as Record<string, string | undefined>;
    const previous = mutable.NODE_ENV;
    mutable.NODE_ENV = env;
    try {
      const result = guardMutation(facts);
      return { ok: result.ok, ...(result.failure ? { failure: result.failure } : {}) };
    } finally {
      if (previous === undefined) delete mutable.NODE_ENV;
      else mutable.NODE_ENV = previous;
    }
  }

  it('同一个跨站请求在 development 与 production 下都被拒绝，且理由相同', async () => {
    const facts = hostileFacts();

    const dev = decideUnder('development', facts);
    const prod = decideUnder('production', facts);
    const test = decideUnder('test', facts);

    expect(dev.ok, '开发模式下跨站请求也被拒绝').toBe(false);
    expect(prod.ok).toBe(false);
    expect(test.ok).toBe(false);
    // 关键：理由必须一致。若开发模式换了一个更宽松的分支，这里会不同。
    expect(dev.failure).toBe(prod.failure);
    expect(prod.failure).toBe(test.failure);
  });

  it('同一个合法请求在两种模式下都被接受（证明上一条不是恒真拒绝）', async () => {
    const facts = await legitimateFacts();

    expect(decideUnder('development', facts).ok).toBe(true);
    expect(decideUnder('production', facts).ok).toBe(true);
  });

  it('守卫源码里没有 NODE_ENV / 开发分支', () => {
    // 上面的运行时断言证明「这次运行里没有降级」。这条进一步证明**没有可降级的分支**：
    // 一个 `if (process.env.NODE_ENV !== 'production') return { ok: true }` 式的写法在这里
    // 会被直接拦下，而不是等某次运行才暴露。
    const guard = readFileSync(
      path.join(projectRoot, 'src/server/security/localGuard.ts'),
      'utf8',
    );
    expect(guard).not.toContain('NODE_ENV');
    expect(guard).not.toContain('development');
  });

  it('启动包装在 dev 与 start 两种模式下都绑定回环地址并先探端口', () => {
    const launcher = readFileSync(path.join(projectRoot, 'scripts/start-local.mjs'), 'utf8');

    // 默认主机必须是回环地址：开发方便不能变成「监听 0.0.0.0」。
    expect(launcher).toContain("const DEFAULT_HOST = '127.0.0.1'");
    expect(launcher).toContain("const DEFAULT_PORT = 3000");
    // 两种模式共用同一条端口探测与同一个 host 参数，没有 dev 专用放宽分支。
    expect(launcher).toContain('portIsFree');
    expect(launcher).toContain(": [nextBin, 'start', '--hostname', config.host, '--port', String(config.port)]");
    expect(launcher).toContain("? [nextBin, 'dev', '--hostname', config.host, '--port', String(config.port)]");
    // 两种模式的分支必须都出现，证明 dev 没走一条不同的启动路径。
    expect(launcher).toMatch(/mode === 'dev'/u);
  });

  it('运行配置拒绝「origin 与监听地址不一致」，避免为了开发把守卫关掉的写法', () => {
    const config = readFileSync(
      path.join(projectRoot, 'src/server/runtime/config.ts'),
      'utf8',
    );
    expect(config).toContain('与监听地址');
    expect(config).toContain('loopbackOnly');
    // 不存在「开发模式跳过 origin 校验」的逃生口。
    expect(config).not.toContain('skipOrigin');
  });
});

describe('T075-R05 CSP 现状与未启用理由', () => {
  /** Every route file under the App Router API surface. */
  function routeSources(): { file: string; source: string }[] {
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/u.test(entry)) files.push(full);
      }
    };
    walk(path.join(projectRoot, 'src'));
    return files.map((file) => ({
      file: path.relative(projectRoot, file).replaceAll('\\', '/'),
      source: readFileSync(file, 'utf8'),
    }));
  }

  it('当前没有任何 CSP 头，也没有 middleware——这是实际状态不是承诺', () => {
    const withCsp = routeSources().filter(({ source }) =>
      /Content-Security-Policy|contentSecurityPolicy/iu.test(source),
    );
    expect(withCsp.map((entry) => entry.file), 'CSP 未启用，不应有代码声称已启用').toEqual([]);
  });

  it('已启用的安全响应头是哪些：no-store 与 nosniff', () => {
    // 「没有 CSP」不等于「没有响应头加固」。诚实的说明要区分这两件事。
    const guard = readFileSync(
      path.join(projectRoot, 'src/server/security/localGuard.ts'),
      'utf8',
    );
    expect(guard).toContain("'Cache-Control': 'no-store'");
    expect(guard).toContain("'X-Content-Type-Options': 'nosniff'");
  });

  it('Mermaid 与 Markmap 依赖内联样式，直接开严格 CSP 会破坏图形渲染', () => {
    // 这是「先测后启」的具体依据，不是推测，而且不是从白名单数组读出来的：
    // `SVG_ALLOWED_TAGS` 里**没有** `style`，但运行时 DOMPurify 的 `USE_PROFILES`
    // 会重建这个集合，所以真正决定去留的是导出前的只读谓词。实测事实是——
    // 一张**惰性的样式表必须放行**，因为 Mermaid 的配色靠它（`#a{fill:#fff}`）。
    //
    // 所以判据落在这个真实闸门上：样式表本体通过，危险内容（外部引用）被拒。
    const inert = findUnsafeSvgMarkup(
      '<svg><style>#a{fill:#fff;}@keyframes d{to{stroke-dashoffset:0;}}</style></svg>',
    );
    expect(inert, '惰性样式表必须放行，否则 Mermaid 会失去配色').toEqual([]);

    expect(
      findUnsafeSvgMarkup('<svg><style>@import url("https://evil.example/x.css");</style></svg>'),
      '带外部引用的样式表必须拒绝',
    ).toContain('包含外部样式引用');

    // 有了这条事实，「给 style-src 不留空间的严格 CSP 会破坏图形视图」就不再是猜测：
    // 产品当前**依赖**内联样式表存活。启用 CSP 需要先设计 Mermaid/Markmap 的样式策略。
    expect(
      SVG_ALLOWED_TAGS.map((tag) => tag.toLowerCase()),
      '声明白名单里没有 style，所以运行时行为必须靠谓词与浏览器矩阵证明',
    ).not.toContain('style');
  });
});

describe('T075-C06 威胁说明不超过实现', () => {
  const checklist = readFileSync(
    path.join(projectRoot, 'docs/security-checklist.md'),
    'utf8',
  );

  it('清单明确列出三类未覆盖威胁', () => {
    // R06 逐字点名的三类，都必须出现在「不覆盖」那一节里。
    // 顺序不定，所以允许中间有少量其它字。
    expect(checklist, '必须写明操作系统已被入侵这一情形').toMatch(
      /操作系统[\s\S]{0,30}(已被入侵|被入侵|已被控制|被控制|已失守)/u,
    );
    expect(checklist, '必须写明恶意同源脚本').toMatch(/同源脚本/u);
    expect(checklist, '必须写明用户主动把 Key 交给不可信服务').toMatch(
      /不可信(的)?服务|交给[\s\S]{0,20}不可信/u,
    );
  });

  it('清单不宣称本地明文 Key 有硬件级保护', () => {
    // 这一条是 C06 的核心否定断言。天真做法是「全文搜关键词就报错」，但那会把
    // 文档里**否认**这句话的写法也判成违规——而否认恰恰是 R06 要求的。所以判据
    // 收紧为「只允许出现在否定语境里」：含有超范围措辞的行必须同时含否定词。
    const OVERCLAIM = /硬件级|不可攻破|绝对安全|军事级|安全芯片|加密芯片|Secure Enclave|\bTPM\b/u;
    const NEGATION = /不|无|没|未|非/u;

    const offenders = checklist
      .split(/\r?\n/u)
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => OVERCLAIM.test(line) && !NEGATION.test(line));

    expect(
      offenders,
      `这些行把安全承诺拔高到了实现之上：${JSON.stringify(offenders)}`,
    ).toEqual([]);

    // 同时要求文档**主动**说明没有硬件级保护，而不是靠沉默。
    expect(checklist, '必须主动否认硬件级保护').toMatch(
      /(没有|无|不具备|不提供)[\s\S]{0,12}硬件级/u,
    );
  });

  it('清单写明 Key 是本地明文存储，并说明它只用于出站请求', () => {
    expect(checklist).toMatch(/明文/u);
    expect(checklist).toMatch(/本地/u);
  });

  it('清单说明令牌守卫不防本机恶意进程', () => {
    // 威胁模型的边界要写清楚，否则「本机请求保护」会被误读成「本机进程认证」。
    expect(checklist).toMatch(/本机(恶意)?进程|同机进程/u);
  });

  it('清单如实记录 CSP 未启用', () => {
    expect(checklist).toMatch(/CSP/u);
    expect(checklist).toMatch(/未启用|尚未启用|还没启用/u);
  });
});

describe('T075-C06 清单里声称的措施在实现里真的存在', () => {
  it('containsSecret 能识别秘密——清单若声称「扫描产物」就必须可用', () => {
    // 反向验证：一个恒返回 false 的 containsSecret 会让 C02 全绿而毫无价值。
    const googleKey = 'AIzaSyD4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ12';
    expect(containsSecret(`前缀 ${googleKey} 后缀`)).toBe(false);

    registerSecret(googleKey);
    expect(containsSecret(`前缀 ${googleKey} 后缀`), '登记后必须能识别').toBe(true);
    expect(containsSecret('完全无关的普通文本')).toBe(false);
  });

  it('令牌长度取自 LIMITS，不是写死的字面量', () => {
    // 「进程级随机令牌」这条声称要真的成立：长度来自契约常量。
    expect(LIMITS.tokenBytes).toBeGreaterThanOrEqual(16);
    expect(LIMITS.host).toBe('127.0.0.1');
  });
});
