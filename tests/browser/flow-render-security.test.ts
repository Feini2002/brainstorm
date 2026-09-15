/**
 * T065-C01…C04 ｜在真实 Chromium 里跑生产净化器与渲染器（函数层）。
 *
 * 用例原文：`docs/05_tests/G5/T065_cases.md`。规则原文：`docs/04_tasks/G5/T065_mermaid_renderer.md`
 * 的 T065-R01…R06。
 *
 * ## 为什么这一层必须有浏览器
 *
 * 两条实测事实，不是选择：
 *
 *  1. `dompurify` 在没有 DOM 的环境里**不会挂上** `sanitize`：本仓库 Node 环境下
 *     `DOMPurify.isSupported === false`、`typeof DOMPurify.sanitize === 'undefined'`，
 *     依赖树里也没有 jsdom/happy-dom。所以「净化器到底跑了没有、跑出了什么」在进程内
 *     无法回答。手写 DOM stub 只会让断言变成关于 stub 的断言。
 *  2. Mermaid 本来就是浏览器库。
 *
 * `tests/browser/support/flowSandbox.ts` 于是用 esbuild 把生产入口打进真实 Chromium，
 * 调用的就是 `src/features/flow/sanitizeSvg.ts` 与 `src/features/flow/useMermaidRender.ts`
 * 里的**同一个函数**：真 DOMPurify、真模板、真渲染队列、真临时节点清理、真净化后校验。
 *
 * ## T065-C01 的「没有外部请求」为什么必须在这里证明
 *
 * 外部资源要真发才会出现在网络记录里。所以本文件对**每一条**攻击面都做两件事：
 * 断言净化后的字符串里那段标记消失了，然后把净化结果按产品的方式（`innerHTML`）放进
 * 活页面、等一会儿、数真实请求。只做前一半会漏掉一类真实缺陷——`USE_PROFILES` 会覆盖
 * `ALLOWED_TAGS`/`ALLOWED_ATTR`，所以「白名单里没有它」并不等于「它出不来」；而
 * `url(http://…)` 这种功能记号根本不以 URI 属性的形式出现，DOMPurify 的协议检查看不到
 * 里面的地址。这两点都是本轮在这个文件里实测出来的（见 `sanitizeSvg.ts` 的模块注释）。
 *
 * ## 这里不能证明什么
 *
 * React 自身的生命周期（Strict Mode 双挂载、effect 清理、ResizeObserver 断开、重试按钮）
 * 在函数层不可观察，那些断言在 `tests/e2e/flow-lifecycle.spec.ts` 走真实 `/flow` 页面。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeFlowSandbox,
  externalRequests,
  openFlowSandbox,
  type FlowSandboxHandle,
} from './support/flowSandbox';

/**
 * The sandbox's copy of the production renderer/sanitizer, opened once per file.
 *
 * `SeedFlow` used to live here as a hand-written mirror of the content shape; it
 * was removed because the cases below build their content inline and a second
 * declaration of the contract would be one more thing that can drift from
 * `src/domain/knowledge.ts`.
 */
let sandbox: FlowSandboxHandle;

beforeAll(async () => {
  sandbox = await openFlowSandbox();
}, 180_000);

afterAll(async () => {
  await closeFlowSandbox();
});

/** 把一段 SVG 放进活页面，返回它自己造成的真实请求。 */
async function observeRequests(svg: string): Promise<string[]> {
  await sandbox.resetPage();
  await sandbox.page.evaluate((html) => {
    const host = document.createElement('div');
    host.setAttribute('data-under-test', '1');
    host.innerHTML = html;
    document.body.appendChild(host);
  }, svg);
  // 给任何「想加载点什么」的标记一点时间去加载；外部主机不可达时浏览器会很快失败，
  // 而请求记录在这一步之前就已经产生。
  await sandbox.page.waitForTimeout(600);
  return externalRequests(sandbox.requests);
}

/* -------------------------------------------------------------------------- */
/* T065-C01 恶意标签                                                           */
/* -------------------------------------------------------------------------- */

describe('T065-C01 恶意标签：编译→渲染→净化之后没有脚本执行与外部请求', () => {
  it('整链跑通：注入片段被剥除或降级为文字，页面零请求零弹框', async () => {
    const hostileLabels = [
      '<img src=x onerror=alert(1)>',
      '<script>alert(2)</script>',
      '</text><foreignObject><div>x</div></foreignObject><text>',
      '</text><iframe src="http://evil.example/x"></iframe><text>',
      '</text><a href="javascript:alert(3)">点我</a><text>',
      '</text><image href="//evil.example/x.png"/><text>',
      '</text><use href="http://evil.example/x#a"/><text>',
      '正在降级安全：securityLevel "loose"',
      '普通中文标签（括号）[方括号]',
    ];

    await sandbox.resetPage();

    const observation = await sandbox.page.evaluate(
      async (labels: string[]) => {
        const api = globalThis.FlowSandbox;
        const content = {
          title: '恶意标签样本',
          direction: 'LR' as const,
          nodes: labels.map((label, index) => ({
            id: `n${index}`,
            label,
            itemIds: ['3f1a6b0e-8f4c-4b1d-9f2e-1a2b3c4d5e6f'],
          })),
          edges: labels.slice(1).map((_, index) => ({
            source: `n${index}`,
            target: `n${index + 1}`,
            kind: 'hypothesis',
            label: `也许：${labels[index]}`,
            itemIds: ['3f1a6b0e-8f4c-4b1d-9f2e-1a2b3c4d5e6f'],
            relationIds: [] as string[],
          })),
        };

        const compiled = api.compileFlow(content);
        if (!compiled.ok || !compiled.compiled) {
          return { compiled: false as const, issues: (compiled.issues ?? []).map((i) => i.message) };
        }

        const svg = await api.renderFlowSvg({
          source: compiled.compiled.source,
          id: 't065-hostile',
        });

        // 产品放图的那一步（`dangerouslySetInnerHTML` 写的就是这个字符串）。
        const host = document.createElement('div');
        host.setAttribute('data-hostile', '1');
        host.innerHTML = svg;
        document.body.appendChild(host);
        await new Promise((resolve) => setTimeout(resolve, 800));

        const all = [...host.querySelectorAll('*')];
        const attributeNames = all.flatMap((element) =>
          [...element.attributes].map((attribute) => attribute.name.toLowerCase()),
        );
        const count = (selector: string): number => host.querySelectorAll(selector).length;

        /**
         * Every attribute value that could make the browser *do* something, with the
         * attribute it came from. Asserted in the test rather than here so the
         * failure prints the offending value.
         */
        const REFERENCE_ATTRS = new Set([
          'href',
          'xlink:href',
          'src',
          'filter',
          'clip-path',
          'mask',
          'marker',
          'marker-start',
          'marker-mid',
          'marker-end',
          'fill',
          'stroke',
          'style',
        ]);
        const referenceValues = all.flatMap((element) =>
          [...element.attributes]
            .filter((attribute) => REFERENCE_ATTRS.has(attribute.name.toLowerCase()))
            .map((attribute) => ({ name: attribute.name, value: attribute.value })),
        );

        return {
          compiled: true as const,
          issues: [] as string[],
          svg,
          findings: api.findUnsafeSvgMarkup(svg),
          referenceValues,
          counts: {
            script: count('script'),
            img: count('img, image'),
            iframe: count('iframe'),
            foreignObject: count('foreignObject'),
            navigableAnchor: count('a[href], a[xlink\\:href]'),
            use: count('use'),
            handlers: attributeNames.filter((name) => name.startsWith('on')).length,
            svg: count('svg'),
            text: count('text'),
          },
          drawnText: all.map((element) => element.textContent ?? '').join(' '),
        };
      },
      hostileLabels,
    );

    expect(
      observation.compiled,
      `恶意标签不应让编译失败：${JSON.stringify(observation.issues)}`,
    ).toBe(true);
    if (!observation.compiled) return;

    // ---- 必须排除：没有脚本执行 ----
    expect(observation.counts.script, 'DOM 里不应留下 <script>').toBe(0);
    expect(observation.counts.handlers, 'DOM 里不应留下 on* 事件属性').toBe(0);
    expect(observation.counts.foreignObject, 'DOM 里不应留下 <foreignObject>').toBe(0);
    expect(observation.counts.iframe, 'DOM 里不应留下 <iframe>').toBe(0);
    expect(observation.counts.img, 'DOM 里不应留下 <img>/<image>').toBe(0);
    expect(observation.counts.navigableAnchor, 'DOM 里不应留下可导航的 <a href>').toBe(0);
    expect(observation.counts.use, 'DOM 里不应留下 <use>').toBe(0);

    expect(sandbox.dialogs, `不应有 alert 弹出，实际 ${JSON.stringify(sandbox.dialogs)}`).toEqual([]);
    expect(sandbox.pageErrors, `不应有未捕获异常，实际 ${JSON.stringify(sandbox.pageErrors)}`).toEqual(
      [],
    );

    // ---- 必须排除：没有外部加载 ----
    expect(
      externalRequests(sandbox.requests),
      '渲染与净化结果不应发出任何请求（含图片、字体、样式）',
    ).toEqual([]);

    // 净化后的字符串必须同时过只读检查——导出与显示同源的前提（T065-R06）。
    expect(observation.findings, '净化结果不应含被拒标记').toEqual([]);

    /*
     * 这里断言的是**引用属性的值**，不是整段字符串。
     *
     * 差别是实质的：标签正文里出现 `javascript:` 或 `http://evil.example/x` 是期望行为
     * （笔记就是在讨论这些东西），对它做整串正则会把正确实现判成失败——本轮第一次
     * 跑这条用例时就是这么红的。真正要排除的是「某个属性把浏览器指向了别处」。
     */
    for (const reference of observation.referenceValues) {
      const value = reference.value.trim();
      expect(
        /^javascript\s*:/iu.test(value),
        `属性 ${reference.name} 不应写入 javascript:：${value}`,
      ).toBe(false);
      expect(
        /^(?:https?:)?\/\//iu.test(value),
        `属性 ${reference.name} 不应指向外部地址：${value}`,
      ).toBe(false);
      // 只允许站内 #fragment 与内联 data:image（Mermaid 不用后者，但白名单规则允许）。
      const internal =
        value.startsWith('#') || /^data:image\/(?:png|jpe?g|gif|webp);base64,/iu.test(value);
      if (reference.name.toLowerCase() === 'href' || reference.name.toLowerCase() === 'xlink:href') {
        expect(internal, `属性 ${reference.name} 只应指向本图内的 #fragment：${value}`).toBe(true);
      }
    }
    expect(observation.svg, '不应含 @import').not.toMatch(/@import/iu);

    // ---- 反向约束：正常路径没被「全删」骗过 ----
    expect(observation.counts.svg, '图必须真的画出来了').toBeGreaterThan(0);
    expect(observation.counts.text, '文字必须还在').toBeGreaterThan(0);
    expect(observation.drawnText, '普通中文标签必须仍然可读').toContain('普通中文标签（括号）[方括号]');
    expect(observation.drawnText, '注入片段应作为文字留下，而不是被整段删除').toContain(
      'securityLevel',
    );
  }, 180_000);

  it('净化矩阵：逐条断言该剥除的被剥除，并证明每一条都不再产生真实请求', async () => {
    const payloads: Record<string, string> = {
      script: '<svg><script>alert(1)</script><text>甲</text></svg>',
      foreignObject: '<svg><foreignObject><div>x</div></foreignObject><text>甲</text></svg>',
      iframe: '<svg><iframe src="http://evil.example/x"></iframe></svg>',
      object: '<svg><object data="http://evil.example/x"></object></svg>',
      embed: '<svg><embed src="http://evil.example/x"/></svg>',
      htmlImg: '<svg><img src="http://evil.example/x.png" onerror="alert(1)"/></svg>',
      onload: '<svg onload="alert(1)"><text>甲</text></svg>',
      onbegin: '<svg><rect onbegin="alert(1)" width="4" height="4"/></svg>',
      javascriptHref: '<svg><a href="javascript:alert(1)"><text>甲</text></a></svg>',
      dataHtmlHref: '<svg><a href="data:text/html;base64,PHNjcmlwdD4="><text>甲</text></a></svg>',
      anchorHttp: '<svg><a href="http://evil.example/x"><text>甲</text></a></svg>',
      anchorXlink: '<svg><a xlink:href="http://evil.example/x"><text>甲</text></a></svg>',
      imageHref: '<svg><image href="http://evil.example/x.png"/></svg>',
      imageProtocolRelative: '<svg><image href="//evil.example/x.png"/></svg>',
      useRemote: '<svg><use href="http://evil.example/x#a"/></svg>',
      // `<a>` is retained by DOMPurify's svg profile, but only as a container: every
      // reference attribute on it is removed (measured), so it cannot navigate.
      // `resolveAnchor` is the case that proves that rather than assuming it.
      resolveAnchor: '<svg><a href="http://evil.example/x" xlink:href="javascript:alert(1)"><text>甲</text></a></svg>',
      styleImport: '<svg><style>@import url("http://evil.example/x.css");</style><text>甲</text></svg>',
      styleBareImport: '<svg><style>@import "http://evil.example/x.css";</style><text>甲</text></svg>',
      styleUrl: '<svg><style>rect{fill:url(http://evil.example/x.svg#p)}</style><rect width="4" height="4"/></svg>',
      styleFont: '<svg><style>@font-face{font-family:"p";src:url("http://evil.example/p.woff2")}</style><text>甲</text></svg>',
      styleAttr: '<svg><rect style="background:url(http://evil.example/x.png)" width="4" height="4"/></svg>',
      filterRemote: '<svg><rect filter="url(http://evil.example/f.svg#f)" width="4" height="4"/></svg>',
      clipPathRemote: '<svg><rect clip-path="url(http://evil.example/c.svg#c)" width="4" height="4"/></svg>',
      maskRemote: '<svg><rect mask="url(http://evil.example/m.svg#m)" width="4" height="4"/></svg>',
      markerEndRemote: '<svg><path marker-end="url(http://evil.example/m.svg#m)" d="M0 0L1 1"/></svg>',
      fillRemote: '<svg><rect fill="url(http://evil.example/p.svg#g)" width="4" height="4"/></svg>',
      // 合法形状：站内 # 引用、文字、marker 定义都必须活下来。
      validShapes:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
        '<g class="node"><rect width="5" height="5" fill="#fff" stroke="#333"/></g>' +
        '<text x="1" y="2" text-anchor="middle"><tspan>第一步写清目标</tspan></text>' +
        '<defs><marker id="m"><path d="M0 0"/></marker></defs>' +
        '<path d="M0 0L5 5" marker-end="url(#m)"/></svg>',
    };

    await sandbox.resetPage();

    const sanitized = await sandbox.page.evaluate((cases: Record<string, string>) => {
      const api = globalThis.FlowSandbox;
      const out: Record<string, { clean: string; findings: string[] }> = {};
      for (const [name, svg] of Object.entries(cases)) {
        const clean = api.sanitizeSvgString(svg);
        out[name] = { clean, findings: api.findUnsafeSvgMarkup(clean) };
      }
      return out;
    }, payloads);

    const clean = (name: string): string => sanitized[name]!.clean;

    /**
     * 攻击面清单：名字 → 它必须在净化结果里消失的形状。
     *
     * `url` 类的判据是「不再有非 # 的 url()」，不是「`<style>` 元素消失」：
     * 一个被清空的 `<style></style>` 是惰性的，而 Mermaid 的配色本来就靠这一块。
     */
    const MUST_VANISH: readonly (readonly [string, RegExp])[] = [
      ['script', /<\s*script\b/iu],
      ['foreignObject', /<\s*foreignobject\b/iu],
      ['iframe', /<\s*iframe\b/iu],
      ['object', /<\s*object\b/iu],
      ['embed', /<\s*embed\b/iu],
      ['htmlImg', /<\s*img\b/iu],
      ['onload', /\son[a-z]+\s*=/iu],
      ['onbegin', /\son[a-z]+\s*=/iu],
      ['javascriptHref', /javascript\s*:/iu],
      ['dataHtmlHref', /data:text\/html/iu],
      ['anchorHttp', /(?:href|xlink:href)\s*=\s*["']?https?:\/\//iu],
      ['anchorXlink', /(?:href|xlink:href)\s*=\s*["']?https?:\/\//iu],
      ['imageHref', /href\s*=\s*["']?https?:\/\//iu],
      ['imageProtocolRelative', /href\s*=\s*["']?\/\//iu],
      ['useRemote', /<\s*use\b|href\s*=\s*["']?https?:\/\//iu],
      ['resolveAnchor', /href\s*=\s*["']?|javascript\s*:/iu],
      ['styleImport', /@import|url\s*\(\s*["']?https?:\/\//iu],
      ['styleBareImport', /@import|url\s*\(\s*["']?https?:\/\//iu],
      ['styleUrl', /@import|url\s*\(\s*["']?https?:\/\//iu],
      ['styleFont', /@import|url\s*\(\s*["']?https?:\/\//iu],
      ['styleAttr', /\sstyle\s*=/iu],
      ['filterRemote', /url\s*\(\s*["']?(?!\s*#)/iu],
      ['clipPathRemote', /url\s*\(\s*["']?(?!\s*#)/iu],
      ['maskRemote', /url\s*\(\s*["']?(?!\s*#)/iu],
      ['markerEndRemote', /url\s*\(\s*["']?(?!\s*#)/iu],
      ['fillRemote', /url\s*\(\s*["']?(?!\s*#)/iu],
    ];

    for (const [name, pattern] of MUST_VANISH) {
      expect(clean(name), `${name} 的标记必须消失：${clean(name)}`).not.toMatch(pattern);
    }

    // 每一条净化结果都必须同时过只读谓词（否则导出路径会被自己的检查拒绝）。
    for (const [name, value] of Object.entries(sanitized)) {
      expect(value.findings, `${name} 的净化结果不应含被拒标记：${value.clean}`).toEqual([]);
    }

    // ---- 正常路径：不能靠「全删」通过上面那一组 ----
    const valid = clean('validShapes');
    expect(valid, '正常路径不应被删空').toContain('<svg');
    expect(valid, '文字必须保留').toContain('第一步写清目标');
    expect(valid, 'node 分组必须保留').toContain('class="node"');
    expect(valid, '箭头 marker 的站内引用必须保留').toContain('marker-end="url(#m)"');

    // ---- 关键证据：每一条都不再产生真实请求 ----
    for (const name of Object.keys(payloads)) {
      const requests = await observeRequests(clean(name));
      expect(requests, `${name} 净化后不应再发出请求，实际 ${JSON.stringify(requests)}`).toEqual([]);
    }
  }, 300_000);

  it('反向约束：标签里提到 javascript:/URL 只是文字，不能因此整张图渲染失败', async () => {
    // 这是本轮修掉的一个真实缺陷：`findUnsafeSvgMarkup` 原来对**整段文本**搜
    // `javascript\s*:`，而 `renderFlowSvg` 在校验失败时 fail-closed。于是一条笔记只要
    // 在正文里写了「见 javascript:alert(1) 这段」，整张图就打不开——把安全规则误当成
    // 「谁提到就拒绝谁」。这条用例把它钉住。
    await sandbox.resetPage();

    const result = await sandbox.page.evaluate(async () => {
      const api = globalThis.FlowSandbox;
      const compiled = api.compileFlow({
        title: '提及',
        direction: 'LR',
        nodes: [
          {
            id: 'n0',
            label: '见 javascript:alert(1) 这段，以及 http://evil.example/x 这个地址',
            itemIds: ['3f1a6b0e-8f4c-4b1d-9f2e-1a2b3c4d5e6f'],
          },
          { id: 'n1', label: '第二个节点', itemIds: ['3f1a6b0e-8f4c-4b1d-9f2e-1a2b3c4d5e6f'] },
        ],
        edges: [
          {
            source: 'n0',
            target: 'n1',
            kind: 'hypothesis',
            label: '也许：因为 javascript: 写错了',
            itemIds: ['3f1a6b0e-8f4c-4b1d-9f2e-1a2b3c4d5e6f'],
            relationIds: [],
          },
        ],
      });
      if (!compiled.ok || !compiled.compiled) {
        return { ok: false as const, issues: (compiled.issues ?? []).map((i) => i.message) };
      }
      const outcome = await api
        .renderFlowSvg({ source: compiled.compiled.source, id: 't065-mention' })
        .then(
          (svg) => ({ svg, error: null as string | null }),
          (error: unknown) => ({ svg: null, error: String(error) }),
        );
      return {
        ok: true as const,
        error: outcome.error,
        svg: outcome.svg,
        findings: outcome.svg === null ? [] : api.findUnsafeSvgMarkup(outcome.svg),
        drawnText:
          outcome.svg === null
            ? ''
            : (() => {
                const host = document.createElement('div');
                host.innerHTML = outcome.svg;
                return (host.textContent ?? '').replace(/\s+/gu, ' ');
              })(),
      };
    });

    expect(result.ok, `编译不应失败：${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) return;

    expect(result.error, '提到 javascript: 的文字不应让渲染失败').toBeNull();
    expect(result.svg, '应该真的画出图来').not.toBeNull();
    expect(result.drawnText, '文字必须原样可读').toContain('javascript:alert(1)');
    expect(result.drawnText, 'URL 字样也必须原样可读').toContain('http://evil.example/x');
    expect(result.findings, '净化结果应通过只读检查').toEqual([]);

    // 顺手钉住 SMIL：`<set attributeName="href">` 是「把 URL 写进属性」的手法。
    const smil = await sandbox.page.evaluate(() => {
      const api = globalThis.FlowSandbox;
      const raw =
        '<svg><a><text>甲</text><set attributeName="href" to="javascript:alert(1)"/></a></svg>';
      const clean = api.sanitizeSvgString(raw);
      return { clean, findings: api.findUnsafeSvgMarkup(clean) };
    });
    expect(smil.clean, '写 href 的 SMIL 元素必须被去掉').not.toMatch(
      /<\s*(?:set|animate)\b|javascript\s*:/iu,
    );
    expect(smil.findings, 'SMIL 结果应通过只读检查').toEqual([]);
  }, 180_000);

  it('只读谓词不会被文字骗出误报，也不会漏掉属性里的地址', async () => {
    // 这一步专门测「判据」，用的是**手工构造**的净化结果，因此它度量的是
    // `findUnsafeSvgMarkup` 自己，而不是净化器的输出。两边都要有：
    // 少了前一组，一个永远返回 [] 的实现会全绿；少了这一组，一个对整段文本
    // 搜关键词的实现也会全绿——而它恰好让上面那条用例的图开不出来。
    await sandbox.resetPage();

    const matrix = await sandbox.page.evaluate(() => {
      const api = globalThis.FlowSandbox;
      const cases: Record<string, string> = {
        // 必须放行
        inertStyle:
          '<svg><style>#a{fill:#fff;}@keyframes dash{to{stroke-dashoffset:0;}}</style><text>甲</text></svg>',
        markerFragment: '<svg><path marker-end="url(#m)"/></svg>',
        fillFragment: '<svg><rect fill="url(#g)" width="4" height="4"/></svg>',
        textMentioningJavascript: '<svg><text>见 javascript:alert(1)</text></svg>',
        textMentioningUrl: '<svg><text>见 http://evil.example/x 这个地址</text></svg>',
        textMentioningScript: '<svg><text>别用 &lt;script&gt; 标签</text></svg>',
        dataPng: '<svg><image href="data:image/png;base64,iVBORw0KGgo="/></svg>',
        // 必须拒绝
        script: '<svg><script>alert(1)</script></svg>',
        namespacedScript: '<svg><svg:script>alert(1)</svg:script></svg>',
        handler: '<svg onload="alert(1)"/></svg>',
        hrefJavascript: '<svg><a href="javascript:alert(1)"><text>甲</text></a></svg>',
        hrefEncodedJavascript: '<svg><a href="jav&#x61;script:alert(1)"><text>甲</text></a></svg>',
        hrefUnquotedJavascript: '<svg><a href=javascript:alert(1)><text>甲</text></a></svg>',
        hrefHttp: '<svg><image href="http://evil.example/x.png"/></svg>',
        hrefProtocolRelative: '<svg><image href="//evil.example/x.png"/></svg>',
        hrefRelative: '<svg><image href="evil.example/x.png"/></svg>',
        styleImport: '<svg><style>@import url("https://evil.example/x.css");</style></svg>',
        styleBareImport: '<svg><style>@import "https://evil.example/x.css";</style></svg>',
        styleRemoteUrl: '<svg><style>rect{fill:url(https://evil.example/x.svg#p)}</style></svg>',
        styleRelativeUrl: '<svg><style>rect{fill:url(evil.example/x.svg#p)}</style></svg>',
        filterRemote: '<svg><rect filter="url(http://evil.example/f.svg#f)"/></svg>',
        clipPathRemote: '<svg><rect clip-path="url(//evil.example/c.svg#c)"/></svg>',
        markerEndRemote: '<svg><path marker-end="url(http://evil.example/m.svg#m)"/></svg>',
        smilWrite: '<svg><set attributeName="href" to="javascript:alert(1)"/></svg>',
      };
      const out: Record<string, string[]> = {};
      for (const [name, svg] of Object.entries(cases)) out[name] = api.findUnsafeSvgMarkup(svg);
      return out;
    });

    const MUST_PASS = [
      'inertStyle',
      'markerFragment',
      'fillFragment',
      'textMentioningJavascript',
      'textMentioningUrl',
      'textMentioningScript',
      'dataPng',
    ];
    for (const name of MUST_PASS) {
      expect(matrix[name], `${name} 不应被误报：${JSON.stringify(matrix[name])}`).toEqual([]);
    }

    const MUST_FAIL = [
      'script',
      'namespacedScript',
      'handler',
      'hrefJavascript',
      'hrefEncodedJavascript',
      'hrefUnquotedJavascript',
      'hrefHttp',
      'hrefProtocolRelative',
      'hrefRelative',
      'styleImport',
      'styleBareImport',
      'styleRemoteUrl',
      'styleRelativeUrl',
      'filterRemote',
      'clipPathRemote',
      'markerEndRemote',
      'smilWrite',
    ];
    for (const name of MUST_FAIL) {
      expect(matrix[name], `${name} 必须被拒绝`).not.toEqual([]);
    }
  }, 180_000);
});

/* -------------------------------------------------------------------------- */
/* T065-C02 配置注入                                                           */
/* -------------------------------------------------------------------------- */

describe('T065-C02 配置注入：用户材料不能降级渲染安全', () => {
  it('含 securityLevel 的标签不改配置，配置保持 strict 且文本仍是文字', async () => {
    await sandbox.resetPage();

    const result = await sandbox.page.evaluate(async () => {
      const api = globalThis.FlowSandbox;
      const before = JSON.stringify(api.MERMAID_CONFIG);
      const compiled = api.compileFlow({
        title: '配置注入样本',
        direction: 'LR',
        nodes: [
          {
            id: 'n0',
            label: '请把 securityLevel "loose" 打开 %%{init: {"securityLevel":"loose"}}%%',
            itemIds: ['3f1a6b0e-8f4c-4b1d-9f2e-1a2b3c4d5e6f'],
          },
          { id: 'n1', label: '第二个节点', itemIds: ['3f1a6b0e-8f4c-4b1d-9f2e-1a2b3c4d5e6f'] },
        ],
        edges: [
          {
            source: 'n0',
            target: 'n1',
            kind: 'sequence',
            label: '顺序：然后',
            itemIds: ['3f1a6b0e-8f4c-4b1d-9f2e-1a2b3c4d5e6f'],
            relationIds: [],
          },
        ],
      });
      if (!compiled.ok || !compiled.compiled) {
        return { ok: false as const, issues: (compiled.issues ?? []).map((i) => i.message) };
      }
      const svg = await api.renderFlowSvg({ source: compiled.compiled.source, id: 't065-config' });
      const host = document.createElement('div');
      host.setAttribute('data-config-host', '1');
      host.innerHTML = svg;
      document.body.appendChild(host);
      await new Promise((resolve) => setTimeout(resolve, 600));
      return {
        ok: true as const,
        before,
        after: JSON.stringify(api.MERMAID_CONFIG),
        securityLevel: api.MERMAID_CONFIG.securityLevel,
        htmlLabels: api.MERMAID_CONFIG.htmlLabels,
        startOnLoad: api.MERMAID_CONFIG.startOnLoad,
        drawnText: (host.textContent ?? '').replace(/\s+/gu, ' '),
        findings: api.findUnsafeSvgMarkup(svg),
        hasHandler: host.querySelectorAll('[onload], [onerror]').length,
      };
    });

    expect(result.ok, `编译不应失败：${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) return;

    // ---- 必须断言：配置保持 strict ----
    expect(result.securityLevel, 'securityLevel 必须保持 strict').toBe('strict');
    expect(result.htmlLabels, 'HTML 标签能力必须保持关闭').toBe(false);
    expect(result.startOnLoad, '不应让 Mermaid 扫全文档').toBe(false);
    expect(result.after, '渲染不得修改配置').toBe(result.before);

    // ---- 必须断言：文本不被当指令 ----
    expect(result.drawnText, '指令字样应作为文字出现').toContain('securityLevel');
    expect(result.drawnText, 'init 指令应作为文字出现').toContain('init');
    expect(result.hasHandler, '指令字样不得变成属性').toBe(0);
    expect(result.findings, '净化结果不应含被拒标记').toEqual([]);

    // ---- 必须断言：这张图本身不产生请求 ----
    expect(
      externalRequests(sandbox.requests),
      '渲染这张图不应发出任何请求',
    ).toEqual([]);
  }, 180_000);
});

/* -------------------------------------------------------------------------- */
/* T065-C04 错误清理                                                           */
/* -------------------------------------------------------------------------- */

describe('T065-C04 错误清理：失败路径也清理资源，随后有效图正常画出', () => {
  it('渲染失败不留临时节点，连续失败不堆积，错误可读且随后切换有效图成功', async () => {
    await sandbox.resetPage();

    const result = await sandbox.page.evaluate(async () => {
      const api = globalThis.FlowSandbox;
      const flagKey = api.FLOW_RENDER_FAILURE_FLAG;
      const flags = window as unknown as Record<string, unknown>;

      /**
       * Mermaid 的临时节点形如 `d<id>` 且挂在 `<body>` 下。数的是**直接子节点**，
       * 因为产品只清理这一种，也只有这一种会被遗留。
       */
      const scratch = (): string[] =>
        [...document.body.children]
          .filter((node) => /^d[A-Za-z0-9_-]*$/u.test(node.id))
          .map((node) => node.id || '(无 id)');

      const baseline = scratch();

      const attempt = async (id: string): Promise<string | null> => {
        try {
          await api.renderFlowSvg({ source: 'flowchart LR\n  N0["甲"]', id });
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };

      flags[flagKey] = true;
      const firstFailure = await attempt('t065-fail-1');
      const afterFirst = scratch();
      const secondFailure = await attempt('t065-fail-2');
      const afterSecond = scratch();
      flags[flagKey] = false;

      // 失败之后换到另一张有效图：必须真的画出来，且同样不留残留。
      const compiled = api.compileFlow({
        title: '有效图',
        direction: 'LR',
        nodes: [
          { id: 'n0', label: '有效图的节点', itemIds: ['3f1a6b0e-8f4c-4b1d-9f2e-1a2b3c4d5e6f'] },
          { id: 'n1', label: '第二个节点', itemIds: ['3f1a6b0e-8f4c-4b1d-9f2e-1a2b3c4d5e6f'] },
        ],
        edges: [
          {
            source: 'n0',
            target: 'n1',
            kind: 'sequence',
            label: '顺序：然后',
            itemIds: ['3f1a6b0e-8f4c-4b1d-9f2e-1a2b3c4d5e6f'],
            relationIds: [],
          },
        ],
      });
      if (!compiled.ok || !compiled.compiled) {
        return {
          baseline,
          firstFailure,
          secondFailure,
          afterFirst,
          afterSecond,
          svg: null,
          afterSuccess: scratch(),
          drawnText: '',
          compileIssues: (compiled.issues ?? []).map((i) => i.message),
        };
      }

      const svg = await api.renderFlowSvg({ source: compiled.compiled.source, id: 't065-ok' });
      const host = document.createElement('div');
      host.innerHTML = svg;
      document.body.appendChild(host);

      return {
        baseline,
        firstFailure,
        secondFailure,
        afterFirst,
        afterSecond,
        svg,
        afterSuccess: scratch(),
        drawnText: (host.textContent ?? '').replace(/\s+/gu, ' '),
        compileIssues: [] as string[],
      };
    });

    // ---- 必须断言：失败可读（这是降级提示的来源）----
    expect(result.compileIssues, '有效图不应编译失败').toEqual([]);
    expect(result.firstFailure, '失败必须被上报，且原因可读').toContain('渲染器被要求失败');
    expect(result.secondFailure, '第二次失败同样被上报').toContain('渲染器被要求失败');

    // ---- 必须断言：旧临时节点不残留 ----
    expect(result.afterFirst, '失败后不应残留临时节点').toEqual(result.baseline);
    expect(result.afterSecond, '连续失败也不应堆积临时节点').toEqual(result.baseline);

    // ---- 必须断言：切换到另一有效图后正常 ----
    expect(result.svg, '失败之后的有效图必须渲染成功').not.toBeNull();
    expect(result.afterSuccess, '成功渲染后同样不应残留').toEqual(result.baseline);
    expect(result.drawnText, '有效图必须真的画出来').toContain('有效图的节点');
  }, 180_000);
});

/* -------------------------------------------------------------------------- */
/* T065-C03 多图实例（函数层）                                                  */
/* -------------------------------------------------------------------------- */

describe('T065-C03 多图实例：SVG ID 不冲突，删掉一张不影响另一张', () => {
  it('两张图各自带唯一 id 与自己的站内引用，移除第一张后第二张完好', async () => {
    await sandbox.resetPage();

    const result = await sandbox.page.evaluate(async () => {
      const api = globalThis.FlowSandbox;
      const seed = (title: string, label: string): Record<string, unknown> => ({
        title,
        direction: 'LR',
        nodes: [
          { id: 'n0', label, itemIds: ['3f1a6b0e-8f4c-4b1d-9f2e-1a2b3c4d5e6f'] },
          { id: 'n1', label: '尾巴', itemIds: ['3f1a6b0e-8f4c-4b1d-9f2e-1a2b3c4d5e6f'] },
        ],
        edges: [
          {
            source: 'n0',
            target: 'n1',
            kind: 'sequence',
            label: '然后',
            itemIds: ['3f1a6b0e-8f4c-4b1d-9f2e-1a2b3c4d5e6f'],
            relationIds: [],
          },
        ],
      });

      const compiledA = api.compileFlow(seed('A', '第一张图的节点'));
      if (!compiledA.ok || !compiledA.compiled) {
        return { ok: false as const, issues: (compiledA.issues ?? []).map((i) => i.message) };
      }

      // 两个不同的渲染 id —— 这正是 `useMermaidRender` 用 `useId()` 做的事。
      const svgA = await api.renderFlowSvg({ source: compiledA.compiled.source, id: 'inst-a' });
      const svgB = await api.renderFlowSvg({ source: compiledA.compiled.source, id: 'inst-b' });

      const hostA = document.createElement('div');
      hostA.setAttribute('data-diagram', 'a');
      hostA.innerHTML = svgA;
      const hostB = document.createElement('div');
      hostB.setAttribute('data-diagram', 'b');
      hostB.innerHTML = svgB;
      document.body.append(hostA, hostB);

      const rootId = (host: HTMLElement): string =>
        host.querySelector('svg')?.getAttribute('id') ?? '';
      const allIds = (host: HTMLElement): string[] =>
        [...host.querySelectorAll('[id]')].map((node) => node.getAttribute('id') ?? '');
      const markerRefs = (host: HTMLElement): string[] =>
        [
          ...host.querySelectorAll(
            '[marker-end], [marker-start], [clip-path], [filter], [mask]',
          ),
        ].map((node) =>
          [
            node.getAttribute('marker-end'),
            node.getAttribute('marker-start'),
            node.getAttribute('clip-path'),
            node.getAttribute('filter'),
            node.getAttribute('mask'),
          ]
            .filter((value): value is string => value !== null)
            .join(' '),
        );

      const before = {
        aRootId: rootId(hostA),
        bRootId: rootId(hostB),
        aIds: allIds(hostA),
        bIds: allIds(hostB),
        aMarkers: markerRefs(hostA),
        bMarkers: markerRefs(hostB),
        bText: (hostB.textContent ?? '').replace(/\s+/gu, ' '),
      };
      const overlap = before.aIds.filter((id) => before.bIds.includes(id));

      hostA.remove();

      return {
        ok: true as const,
        before,
        overlap,
        afterBId: rootId(hostB),
        afterBText: (hostB.textContent ?? '').replace(/\s+/gu, ' '),
        afterBMarkers: markerRefs(hostB),
      };
    });

    expect(result.ok, `两张图都应能编译：${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) return;

    // ---- 必须断言：SVG ID 不冲突 ----
    expect(result.before.aRootId, '第一张图应有根 id').not.toBe('');
    expect(result.before.bRootId, '第二张图应有根 id').not.toBe('');
    expect(result.before.aRootId, '两张图的根 id 必须不同').not.toBe(result.before.bRootId);
    expect(
      result.overlap,
      `两张图不应共享任何 DOM id（相同 id 会让 url(#…) 引用错乱）：${JSON.stringify(result.overlap)}`,
    ).toEqual([]);
    expect(result.before.bMarkers.length, '第二张图应有站内引用').toBeGreaterThan(0);
    for (const marker of result.before.bMarkers) {
      expect(marker, '第二张图的站内引用应指向自己的 id').toContain(result.before.bRootId);
    }

    // ---- 必须断言：另一张正常 ----
    expect(result.afterBId, '移除第一张后第二张根 id 不变').toBe(result.before.bRootId);
    expect(result.afterBText, '移除第一张后第二张文字不变').toBe(result.before.bText);
    expect(result.afterBMarkers, '移除第一张后第二张的站内引用不变').toEqual(
      result.before.bMarkers,
    );
    expect(result.afterBText, '第二张画的应是自己的标签').toContain('第一张图的节点');

    // 撞 id 的真正后果是「引用指向别人的节点」。两张图的 id 集合完全不重叠，所以
    // 这一条已经排除；再确认「同一张图内」的引用都能解析到自己家里。
    const dangling = await sandbox.page.evaluate(() =>
      [...document.querySelectorAll('[data-diagram="b"] [href], [data-diagram="b"] [xlink\\:href]')]
        .length,
    );
    expect(dangling, '净化后的图里不应留下 href 引用（箭头靠 marker-end 的 # 引用）').toBe(0);
  }, 180_000);
});

/* -------------------------------------------------------------------------- */
/* T068-C03 导出侧的净化（同一个函数的第二个调用点）                            */
/* -------------------------------------------------------------------------- */

describe('T068-C03 SVG 恶意资源：导出的字节来自净化结果，不是原始渲染返回', () => {
  it('同一份净化结果既能安全插入页面、也能安全写进文件', async () => {
    /*
     * 这条用例补的是本轮审计发现的一个覆盖缺口，不是新功能。
     *
     * `ExportFlow` 只在浏览器侧提供 SVG，交给用户的字符串是
     * `useMermaidRender` 发布上来的 `render.svg`——也就是 `sanitizeSvgString`
     * 的返回值，并在写文件前再用 `findUnsafeSvgMarkup` 判一次（T068-R04/R05、
     * T065-C06）。这条链路此前**没有本层的断言**：e2e 里的
     * `tests/e2e/flow-security.spec.ts` 走真实下载字节，但那需要生产构建；而
     * 净化器本身的行为只有这里在真实 Chromium 里度量过。
     *
     * 所以这里直接断言「净化产物」这一个字符串的两条用途，也就是导出所依赖的
     * 性质：它是安全的**字节**，安全性与它被放进 DOM 与否无关。
     */
    await sandbox.resetPage();

    const result = await sandbox.page.evaluate(async () => {
      const api = globalThis.FlowSandbox;
      const compiled = api.compileFlow({
        title: '导出净化样本',
        direction: 'LR',
        nodes: [
          {
            id: 'n0',
            label: '<img src=x onerror=alert(1)> 与 <script>alert(2)</script> 与 <a href="javascript:alert(3)">点我</a>',
            itemIds: ['3f1a6b0e-8f4c-4b1d-9f2e-1a2b3c4d5e6f'],
          },
          {
            id: 'n1',
            label: '第二个节点 <iframe src="http://evil.example/x"></iframe>',
            itemIds: ['3f1a6b0e-8f4c-4b1d-9f2e-1a2b3c4d5e6f'],
          },
        ],
        edges: [
          {
            source: 'n0',
            target: 'n1',
            kind: 'hypothesis',
            label: '也许：<use href="http://evil.example/x#a"/>',
            itemIds: ['3f1a6b0e-8f4c-4b1d-9f2e-1a2b3c4d5e6f'],
            relationIds: [],
          },
        ],
      });
      if (!compiled.ok || !compiled.compiled) {
        return { ok: false as const, issues: (compiled.issues ?? []).map((i) => i.message) };
      }

      // 产品发布给导出的那个字符串，来源与 `MermaidRenderer` 完全相同。
      const exported = await api.renderFlowSvg({
        source: compiled.compiled.source,
        id: 't068-export',
      });

      // 导出前的那道只读闸门（`ExportFlow.isSanitizedSvgSafe`）。
      const findings = api.findUnsafeSvgMarkup(exported);

      // 写进文件之后再读回来，模拟使用者拿到的那份字节。
      const blob = new Blob([exported], { type: 'image/svg+xml; charset=utf-8' });
      const bytes = await blob.text();

      // 同一串字节放进活页面：不得产生请求，也不得留下可执行标记。
      const host = document.createElement('div');
      host.setAttribute('data-exported', '1');
      host.innerHTML = bytes;
      document.body.appendChild(host);
      await new Promise((resolve) => setTimeout(resolve, 700));

      const names = [...host.querySelectorAll('*')].flatMap((element) =>
        [...element.attributes].map((attribute) => attribute.name.toLowerCase()),
      );

      /*
       * The reference-bearing attribute values, not the raw string.
       *
       * Same distinction as T065-C01: a label whose own words are
       * `href="javascript:alert(3)"` renders that as *text*, and a whole-string
       * regex would flag the correct output. What must not exist is an attribute
       * that points the browser somewhere.
       */
      const REFERENCE_ATTRS = new Set([
        'href',
        'xlink:href',
        'src',
        'filter',
        'clip-path',
        'mask',
        'marker',
        'marker-start',
        'marker-mid',
        'marker-end',
        'fill',
        'stroke',
        'style',
      ]);
      const referenceValues = [...host.querySelectorAll('*')].flatMap((element) =>
        [...element.attributes]
          .filter((attribute) => REFERENCE_ATTRS.has(attribute.name.toLowerCase()))
          .map((attribute) => ({ name: attribute.name, value: attribute.value })),
      );

      return {
        ok: true as const,
        bytes,
        findings,
        roundTripped: bytes === exported,
        referenceValues,
        counts: {
          script: host.querySelectorAll('script').length,
          handlers: names.filter((name) => name.startsWith('on')).length,
          anchors: host.querySelectorAll('a[href], a[xlink\\:href]').length,
          foreignObject: host.querySelectorAll('foreignObject').length,
          iframe: host.querySelectorAll('iframe').length,
          svg: host.querySelectorAll('svg').length,
        },
        drawnText: (host.textContent ?? '').replace(/\s+/gu, ' '),
      };
    });

    expect(result.ok, `编译不应失败：${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) return;

    // ---- 必须断言：净化移除或拒绝（导出前那道闸门必须放行）----
    expect(result.findings, '导出前的只读检查必须通过，否则按钮会拒绝导出').toEqual([]);

    // ---- 必须断言：导出字节里没有可执行的**引用** ----
    //
    // 与 T065-C01 同样只检查引用属性的值。导出文件里 `javascript:` 这几个字确实
    // 还会出现——它在 `<tspan>` 的文字里（标签原文就是这么写的），而文字不能变成
    // URL。对整串做正则会把正确实现判成失败，这正是本轮修掉的那个误报类别。
    expect(result.bytes, '导出字节应是 SVG').toContain('<svg');
    expect(result.bytes, '导出字节不应含 script 元素').not.toMatch(/<\s*script\b/iu);
    expect(result.bytes, '导出字节不应含 on* 处理器').not.toMatch(/\son[a-z]+\s*=/iu);
    expect(result.bytes, '导出字节不应含 foreignObject').not.toMatch(/<\s*foreignobject\b/iu);
    expect(result.bytes, '导出字节不应含 @import').not.toMatch(/@import/iu);
    for (const reference of result.referenceValues) {
      const value = reference.value.trim();
      expect(
        /^javascript\s*:/iu.test(value),
        `导出字节里属性 ${reference.name} 不应写入 javascript:：${value}`,
      ).toBe(false);
      expect(
        /^(?:https?:)?\/\//iu.test(value),
        `导出字节里属性 ${reference.name} 不应指向外部地址：${value}`,
      ).toBe(false);
      if (reference.name.toLowerCase() === 'href' || reference.name.toLowerCase() === 'xlink:href') {
        expect(
          value.startsWith('#') || /^data:image\/(?:png|jpe?g|gif|webp);base64,/iu.test(value),
          `属性 ${reference.name} 只应指向本图内的 #fragment：${value}`,
        ).toBe(true);
      }
    }

    // ---- 必须断言：插入页面也不产生请求 ----
    expect(result.counts.script, '插入页面后不应留下 script').toBe(0);
    expect(result.counts.handlers, '插入页面后不应留下 on* 属性').toBe(0);
    expect(result.counts.anchors, '插入页面后不应留下可导航的 <a href>').toBe(0);
    expect(result.counts.foreignObject, '插入页面后不应留下 foreignObject').toBe(0);
    expect(result.counts.iframe, '插入页面后不应留下 iframe').toBe(0);
    expect(
      externalRequests(sandbox.requests),
      `导出的字节插入页面后不应发出任何请求，实际 ${JSON.stringify(externalRequests(sandbox.requests))}`,
    ).toEqual([]);

    // ---- 反向约束：导出的是可读的图，不是被删空的文件 ----
    expect(result.roundTripped, 'Blob 往返不应改变字节').toBe(true);
    expect(result.counts.svg, '导出文件必须真的含一张图').toBeGreaterThan(0);
    expect(result.drawnText, '注入片段应作为可读文字留下').toContain('点我');
    expect(result.drawnText, '正常文字必须可读').toContain('第二个节点');
  }, 180_000);
});

/* -------------------------------------------------------------------------- */
/* T065-R03 畸形与非法输入：走降级，不是渲染出来                                 */
/* -------------------------------------------------------------------------- */

describe('T065-R03 畸形输入：净化器不抛，渲染器对非法源码拒绝而不是画出半张图', () => {
  /**
   * 这一段补的是本轮审计发现的一个覆盖缺口。
   *
   * 用户明确要求「非法或畸形 SVG 应走降级而不是渲染出来」。此前所有断言用的都是
   * **结构良好**的输入（攻击载荷也是合法的 SVG），所以「净化器遇到畸形输入会怎样」
   * 没有任何证据。下面两条分开度量两件事：
   *
   *  1. `sanitizeSvgString` 是**总函数**：任何字符串都不抛，并且输出通过只读谓词。
   *     这是必要的，因为它在渲染链路上，抛异常会把整张图变成白屏而不是降级。
   *  2. `renderFlowSvg` 对畸形**Mermaid 源码**必须拒绝（reject），而不是返回一张
   *     半成品 SVG。降级由 `MermaidRenderer` 的 `render.error` → `FlowFallback`
   *     承担，那个路径在 `tests/e2e/flow-lifecycle.spec.ts` 走真实页面。
   */
  it('净化器对畸形/非 SVG 输入保持总体性，输出仍过只读检查', async () => {
    await sandbox.resetPage();

    const cases: Record<string, string> = {
      empty: '',
      plainText: '这不是 SVG，只是一句话',
      htmlFragment: '<div>hello</div>',
      unclosedSvg: '<svg><text>没有闭合',
      unclosedTag: '<svg><g><text>甲</svg>',
      strayAngles: '<>][',
      nullByte: '<svg><text>甲\u0000乙</text></svg>',
      // 嵌套到浏览器解析器会自行截断的深度，确认不会栈溢出。
      deepNesting: `<svg>${'<g>'.repeat(400)}<text>深</text>${'</g>'.repeat(400)}</svg>`,
      // 声明为 SVG 但内容是 HTML 的那类「看起来像图」的输入。
      htmlPretendingSvg: '<svg><p>段落</p><table><tr><td>x</td></tr></table></svg>',
    };

    const out = await sandbox.page.evaluate((inputs: Record<string, string>) => {
      const api = globalThis.FlowSandbox;
      const results: Record<string, { threw: string | null; type: string; findings: string[] }> = {};
      for (const [name, svg] of Object.entries(inputs)) {
        try {
          const clean = api.sanitizeSvgString(svg);
          results[name] = {
            threw: null,
            type: typeof clean,
            findings: api.findUnsafeSvgMarkup(clean),
          };
        } catch (error) {
          results[name] = {
            threw: String(error instanceof Error ? error.message : error).slice(0, 160),
            type: '',
            findings: [],
          };
        }
      }
      return results;
    }, cases);

    for (const [name, result] of Object.entries(out)) {
      // ---- 必须断言：不抛 ----
      expect(result.threw, `${name} 不应让净化器抛异常：${result.threw}`).toBeNull();
      expect(result.type, `${name} 必须仍返回字符串`).toBe('string');
      // ---- 必须断言：输出仍安全（畸形输入不能从检查里溜过去）----
      expect(result.findings, `${name} 的净化结果不应含被拒标记`).toEqual([]);
    }

    // 反向约束：这一组不是「全部返回空串」也能通过。声明为 SVG 的输入必须仍然
    // 解析成 SVG 元素，而不是被整体丢掉——否则上面的「安全」是以丢弃用户内容换来的。
    const shapes = await sandbox.page.evaluate((inputs: Record<string, string>) => {
      const api = globalThis.FlowSandbox;
      const parsed: Record<string, { hasSvgRoot: boolean; textLength: number }> = {};
      for (const [name, svg] of Object.entries(inputs)) {
        const host = document.createElement('div');
        host.innerHTML = api.sanitizeSvgString(svg);
        parsed[name] = {
          hasSvgRoot: host.querySelector('svg') !== null,
          textLength: (host.textContent ?? '').trim().length,
        };
      }
      return parsed;
    }, cases);

    for (const name of ['unclosedSvg', 'nullByte', 'deepNesting']) {
      expect(shapes[name]!.hasSvgRoot, `${name} 是声明为 SVG 的输入，不应被整体删掉`).toBe(true);
    }
    expect(shapes.nullByte!.textLength, '文字内容应保留下来').toBeGreaterThan(0);
  }, 180_000);

  it('渲染器对畸形 Mermaid 源码拒绝而不是返回半张图', async () => {
    await sandbox.resetPage();

    const sources: Record<string, string> = {
      notMermaid: '这不是 mermaid',
      empty: '',
      brokenArrow: 'flowchart LR\n  N0["甲"] -->',
      unclosedQuote: 'flowchart LR\n  N0["甲',
    };

    const out = await sandbox.page.evaluate(async (inputs: Record<string, string>) => {
      const api = globalThis.FlowSandbox;
      const results: Record<string, { ok: boolean; hasSvg: boolean; message: string }> = {};
      for (const [name, source] of Object.entries(inputs)) {
        try {
          const svg = await api.renderFlowSvg({ source, id: `malformed-${name}` });
          results[name] = { ok: true, hasSvg: svg.includes('<svg'), message: '' };
        } catch (error) {
          results[name] = {
            ok: false,
            hasSvg: false,
            message: String(error instanceof Error ? error.message : error).slice(0, 200),
          };
        }
      }
      return results;
    }, sources);

    // ---- 必须断言：非法源码走失败，而不是渲染出来 ----
    for (const name of ['notMermaid', 'empty', 'brokenArrow', 'unclosedQuote']) {
      expect(out[name]!.ok, `${name} 必须被拒绝，而不是画出一张图`).toBe(false);
      // 理由必须可读——它是 fallback 上给用户的提示。
      expect(out[name]!.message.length, `${name} 的失败原因必须可读`).toBeGreaterThan(0);
    }

    // ---- 必须排除：拒绝之后没有临时节点残留（T065-R05 的清理侧）----
    const leftover = await sandbox.page.evaluate(() =>
      [...document.body.children]
        .filter((node) => /^d[A-Za-z0-9_-]*$/u.test(node.id))
        .map((node) => node.id || '(无 id)'),
    );
    expect(leftover, `非法源码渲染失败后不应残留临时节点：${JSON.stringify(leftover)}`).toEqual([]);

    // 反向约束：合法源码仍然正常——不能靠「一律拒绝」通过上面那一组。
    const good = await sandbox.page.evaluate(async () => {
      const api = globalThis.FlowSandbox;
      const compiled = api.compileFlow({
        title: '对照',
        direction: 'LR',
        nodes: [
          { id: 'n0', label: '对照节点', itemIds: ['3f1a6b0e-8f4c-4b1d-9f2e-1a2b3c4d5e6f'] },
        ],
        edges: [],
      });
      if (!compiled.compiled) return { ok: false as const, text: '' };
      const svg = await api.renderFlowSvg({ source: compiled.compiled.source, id: 'malformed-good' });
      const host = document.createElement('div');
      host.innerHTML = svg;
      return { ok: true as const, text: (host.textContent ?? '').trim() };
    });
    expect(good.ok, '合法源码必须仍能渲染').toBe(true);
    expect(good.text, '合法源码画的文字必须可读').toContain('对照节点');
  }, 180_000);
});
