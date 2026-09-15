/**
 * T065 验收｜SVG 净化与严格渲染的**可在 Node 中断言的**那一半。
 *
 * 用例规格：docs/05_tests/G5/T065_cases.md；规则：docs/04_tasks/G5/T065_mermaid_renderer.md。
 *
 * ## 为什么这个文件不直接调用 `sanitizeSvgString`
 *
 * 因为在本仓库的运行环境里它**跑不起来**，这不是推测，是实测：
 *
 * ```
 * $ npx vitest run --project unit tests/unit/__probe-sanitize.test.ts
 * PROBE_SANITIZE=THREW:__vite_ssr_import_0__.default.addHook is not a function
 * ```
 *
 * `dompurify` 的 CJS 导出在 ESM 互操作下拿到的是 `createDOMPurify` 工厂，
 * 它只有在有真实 DOM（`window`/`document`）时才会把 `sanitize` 装上去：
 * `isSupported === false`、`typeof D.sanitize === 'undefined'`。本仓库的
 * `vitest.config.ts` 三个 project 全是 `environment: 'node'`，依赖树里也没有
 * jsdom / happy-dom（实测 `node_modules` 里 0 个匹配），**所以「用 Node 单测
 * 调用真实净化器」这件事在当前工程条件下不成立**。给 sanitizeSvg 补一个假
 * 净化器来让断言通过，只会证明那个假货能被调用。
 *
 * 因此这里断言的是净化器**真实导出、真实被导出路径使用**的那部分逻辑：
 *
 *  - `SVG_ALLOWED_TAGS` / `SVG_ALLOWED_ATTR` / `SVG_FORBIDDEN_TAGS`：
 *    白名单是否真的把执行/嵌入/导航能力排除在外。它们不是注释，是
 *    `sanitizeSvgString` 的输入，也是 T065-C01「没有脚本执行或外部请求」的判据来源。
 *  - `findUnsafeSvgMarkup`：**只读谓词**，导出的 SVG 在交给用户之前由它做最后一道
 *    检查（T065-C06、T068-C03），并且 `renderFlowSvg` 在净化后会调用它，发现问题就
 *    抛错（失败关闭）。它是纯字符串函数，没有 DOM 依赖，可以在 Node 里逐条断言。
 *  - `MERMAID_CONFIG`：T065-C02「配置保持 strict」的**常量**判据。渲染器把它交给
 *    `mermaid.initialize`，而没有任何字段来自视图内容。
 *
 * ## 净化后的真实 DOM 结果在哪里证明
 *
 * `sanitizeSvgString` 与 `MermaidRenderer` 的真断言在
 * `tests/e2e/flow-security.spec.ts`：那里把 `src/features/flow/sanitizeSvg.ts` 与
 * `useMermaidRender.ts` 用 esbuild 打成浏览器包，交给真实 Chromium 执行，因此
 * DOMPurify 有 DOM、Mermaid 被真正调用、`dangerouslySetInnerHTML` 的结果被逐条
 * 断言。规格也要求这一点（T065-C01 的观察方法是「没有脚本执行或外部请求」，
 * 那只能在实际渲染里观察）。
 */
import { describe, expect, it } from 'vitest';

import {
  SVG_ALLOWED_ATTR,
  SVG_ALLOWED_TAGS,
  SVG_FORBIDDEN_ATTR_PATTERN,
  SVG_FORBIDDEN_TAGS,
  findUnsafeSvgMarkup,
} from '@/features/flow/sanitizeSvg';
import { MERMAID_CONFIG } from '@/features/flow/useMermaidRender';

/* -------------------------------------------------------------------------- */
/* 白名单本身                                                                  */
/* -------------------------------------------------------------------------- */

describe('T065-C01 SVG 白名单把可执行/可嵌入/可导航的能力排除在外', () => {
  /**
   * 契约逐字点名的标签，以及 `style`。
   *
   * `style` 也在里面：它可以靠 `@import` 或 `url()` 加载外部资源，而 T065-C01
   * 的判据是「没有外部请求」——一个能加载远程字体/样式的元素就是在开这个口子。
   */
  const DANGEROUS_TAGS = [
    'script',
    'foreignObject',
    'iframe',
    'object',
    'embed',
    'style',
    'a',
    'image',
    'use',
  ] as const;

  it.each(DANGEROUS_TAGS)('白名单不含 <%s>', (tag) => {
    // 断言的是模块声明的契约（数组内容）。运行时是否真的拦住，见浏览器侧矩阵：
    // 实测 `USE_PROFILES` 让 DOMPurify 重建这两个集合，所以「数组里没有」不等于
    // 「出不来」。模块注释写明了这一点，`findUnsafeSvgMarkup` 是真正的闸门。
    const allowed = SVG_ALLOWED_TAGS.map((entry) => entry.toLowerCase());
    expect(allowed).not.toContain(tag.toLowerCase());
  });

  it('契约点名的五个标签同时出现在显式禁止表里', () => {
    // 与白名单冗余是有意的：契约点名了它们，规则就要写在一个读者会去找的地方，
    // 而不是只靠「白名单里没有」这种隐含表达。
    expect([...SVG_FORBIDDEN_TAGS].sort()).toEqual(
      ['embed', 'foreignobject', 'iframe', 'object', 'script'].sort(),
    );
  });

  it('引用类属性不在白名单里', () => {
    // href / xlink:href / src 是 SVG 加载资源的三条路；style 能带 url()/@import。
    const allowed = SVG_ALLOWED_ATTR.map((entry) => entry.toLowerCase());
    for (const attribute of ['href', 'xlink:href', 'src', 'style']) {
      expect(allowed, `${attribute} 不应出现在白名单属性里`).not.toContain(attribute);
    }
  });

  it('on* 事件属性按前缀匹配，覆盖平台新增的名字', () => {
    // 按名字枚举会在浏览器加一个新事件时静默失效，所以规则必须是模式。
    for (const name of ['onload', 'onerror', 'onclick', 'onbegin', 'onanimationend', 'ONLOAD']) {
      expect(SVG_FORBIDDEN_ATTR_PATTERN.test(name), `${name} 应被判定为事件属性`).toBe(true);
    }
    for (const name of ['fill', 'id', 'role', 'font-size', 'marker-end']) {
      expect(SVG_FORBIDDEN_ATTR_PATTERN.test(name), `${name} 不应被判定为事件属性`).toBe(false);
    }
  });

  it('白名单仍然是「够画一张流程图」的集合，不是空集合', () => {
    // 反向约束：把白名单删空也能让上面几条全部通过，所以必须证明它保留了
    // Mermaid flowchart 真正会输出的形状、文字与箭头标签。
    //
    // 注意这一组断言的是**契约本身**（这个数组是模块声明的意图）。它是否等同于
    // 运行时真正生效的集合，由浏览器侧的净化矩阵回答——那里实测到的差异写在
    // `sanitizeSvg.ts` 的模块注释里（`USE_PROFILES` 会覆盖这两个数组）。
    const allowed = SVG_ALLOWED_TAGS.map((entry) => entry.toLowerCase());
    for (const tag of ['svg', 'g', 'path', 'rect', 'text', 'tspan', 'defs', 'marker']) {
      expect(allowed, `画流程图需要 ${tag}`).toContain(tag);
    }
    const attributes = SVG_ALLOWED_ATTR.map((entry) => entry.toLowerCase());
    for (const attribute of ['d', 'transform', 'marker-end', 'text-anchor']) {
      expect(attributes, `画流程图需要 ${attribute}`).toContain(attribute);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* findUnsafeSvgMarkup：导出前的最后一道只读检查                                */
/* -------------------------------------------------------------------------- */

describe('T065-C06 findUnsafeSvgMarkup 拒绝可执行标记', () => {
  /** 每一行：一段必须被拒绝的 SVG，以及它必须给出的那条理由（片段）。 */
  const HOSTILE: readonly (readonly [string, string, string])[] = [
    [
      'script 标签',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '包含 <script> 标签',
    ],
    [
      '带命名空间的 script',
      '<svg><svg:script>alert(1)</svg:script></svg>',
      '包含 <script> 标签',
    ],
    [
      'foreignObject',
      '<svg><foreignObject><div>x</div></foreignObject></svg>',
      '包含 <foreignobject> 标签',
    ],
    ['iframe', '<svg><iframe src="/x"></iframe></svg>', '包含 <iframe> 标签'],
    ['object', '<svg><object data="/x"></object></svg>', '包含 <object> 标签'],
    ['embed', '<svg><embed src="/x"></svg>', '包含 <embed> 标签'],
    ['onload', '<svg onload="alert(1)"></svg>', '包含 on* 事件属性'],
    ['onerror', '<svg><rect onerror="alert(1)"/></svg>', '包含 on* 事件属性'],
    ['onbegin（动画事件）', '<svg><rect onbegin="alert(1)"/></svg>', '包含 on* 事件属性'],
    [
      'javascript: 协议',
      '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>',
      '使用了 javascript: 协议',
    ],
    [
      '大小写与空白伪装的 javascript:',
      '<svg><a href="  JaVaScRiPt :alert(1)"><text>x</text></a></svg>',
      '使用了 javascript: 协议',
    ],
    [
      '实体编码伪装的 javascript:',
      '<svg><a href="jav&#x61;script:alert(1)"><text>x</text></a></svg>',
      '使用了 javascript: 协议',
    ],
    [
      '不写引号的 javascript:',
      '<svg><a href=javascript:alert(1)><text>x</text></a></svg>',
      '使用了 javascript: 协议',
    ],
    [
      'SMIL 往 href 写 javascript:',
      '<svg><set attributeName="href" to="javascript:alert(1)"/></svg>',
      '动画把 href 写成 javascript: 协议',
    ],
    [
      'http 外链',
      '<svg><image href="http://evil.example/x.png"/></svg>',
      '引用了外部资源：http://evil.example/x.png',
    ],
    [
      '协议相对外链',
      '<svg><image href="//evil.example/x.png"/></svg>',
      '引用了外部资源：//evil.example/x.png',
    ],
    [
      'src 外链',
      '<svg><image src="https://evil.example/x.png"/></svg>',
      '引用了外部资源：https://evil.example/x.png',
    ],
    [
      'data:text/html 伪装的资源',
      '<svg><a href="data:text/html;base64,PHNjcmlwdD4="><text>x</text></a></svg>',
      '引用了外部资源：data:text/html',
    ],
    [
      '样式里的 @import',
      '<svg><style>@import url("https://evil.example/x.css");</style></svg>',
      '包含外部样式引用',
    ],
    [
      '样式里的绝对 url()',
      '<svg><style>rect{fill:url(https://evil.example/x.svg#p)}</style></svg>',
      '包含外部样式引用',
    ],
    [
      '样式里的协议相对 url()',
      '<svg><style>rect{fill:url(//evil.example/x.svg#p)}</style></svg>',
      '包含外部样式引用',
    ],
  ];

  it.each(HOSTILE)('%s 被拒绝', (_name, svg, reason) => {
    const findings = findUnsafeSvgMarkup(svg);
    expect(findings.length, `应至少给出一条理由，实际 ${JSON.stringify(findings)}`).toBeGreaterThan(0);
    expect(findings.join(' | ')).toContain(reason);
  });

  it('这个谓词的判据是「属性里的引用」，不是「整段文本里的关键词」', () => {
    // 这一条记录的是本轮修掉的一个真实缺陷，边界两侧都要钉住。
    //
    // 缺陷侧：原来的实现对整段文档搜 `javascript\s*:`，于是**标签正文**里提到
    // `javascript:alert(1)` 的笔记会被判成不安全。`renderFlowSvg` 在校验失败时
    // fail-closed，结果是整张图打不开——把安全规则误当成「谁提到就拒绝谁」。
    expect(
      findUnsafeSvgMarkup('<svg><text>见 javascript:alert(1) 这段</text></svg>'),
      '正文提到 javascript: 是文字，不是引用',
    ).toEqual([]);
    expect(
      findUnsafeSvgMarkup('<svg><text>见 http://evil.example/x 这个地址</text></svg>'),
      '正文提到 URL 是文字，不是引用',
    ).toEqual([]);

    // 能力侧：`url()` 里的无协议相对地址**按设计**被拒。它对浏览器是本站地址而不是外部
    // 主机，旧实现因此放行；但它仍然是一次加载，而 Mermaid 只用 `url(#…)`，所以拒绝它
    // 不损失任何画面，同时把「净化后不再产生请求」变成不需要域名知识的性质。
    expect(
      findUnsafeSvgMarkup('<svg><style>rect{fill:url(evil.example/x.svg#p)}</style></svg>'),
      '相对 url() 也是一次加载，按设计拒绝',
    ).toContain('包含外部样式引用');
    expect(
      findUnsafeSvgMarkup('<svg><rect filter="url(evil.example/x.svg#f)"/></svg>'),
      '相对 url() 作为属性值同样拒绝',
    ).toContain('属性 filter 引用了外部资源：url(evil.example/x.svg#f)');

    // 而站内 # 引用与惰性样式必须继续放行，否则图会画不出来。
    expect(findUnsafeSvgMarkup('<svg><path marker-end="url(#m)"/></svg>')).toEqual([]);
    expect(
      findUnsafeSvgMarkup('<svg><style>#a{fill:#fff;}@keyframes d{to{stroke-dashoffset:0;}}</style></svg>'),
      '不含引用的样式表是惰性的，必须放行（Mermaid 配色靠它）',
    ).toEqual([]);
  });

  /**
   * 合法输入必须通过。
   *
   * 这一组是防止「全部拒绝」也能骗过上面那组的反向约束——一个永远返回
   * `['包含 <script> 标签']` 的实现在上一组里会全绿。
   */
  const ACCEPTED: readonly (readonly [string, string])[] = [
    [
      '真实 Mermaid 输出里的形状与文字',
      '<svg id="v1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" aria-roledescription="flowchart-v2">' +
        '<g class="node"><rect width="5" height="5" fill="#ececff" stroke="#9370db"/></g>' +
        '<text y="-10.1" text-anchor="middle"><tspan>第一步写清目标</tspan></text>' +
        '<path d="M0 0L5 5" marker-end="url(#v1_flowchart-v2-pointEnd)"/></svg>',
    ],
    [
      'marker/clipPath 的站内 # 引用必须放行',
      '<svg><defs><marker id="m"><path d="M0 0"/></marker></defs><path marker-end="url(#m)"/></svg>',
    ],
    [
      '文字里出现 href 字样但不是属性',
      '<svg><text>打开 href 看看</text></svg>',
    ],
    [
      '内联 data:image 仍算安全引用',
      '<svg><image href="data:image/png;base64,iVBORw0KGgo="/></svg>',
    ],
    [
      '被转义成实体的标签字样是文字，不是标签',
      '<svg><text>&lt;script&gt;alert(1)&lt;/script&gt;</text></svg>',
    ],
  ];

  it.each(ACCEPTED)('%s 通过', (_name, svg) => {
    expect(findUnsafeSvgMarkup(svg)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* T065-C02 配置注入                                                           */
/* -------------------------------------------------------------------------- */

describe('T065-C02 Mermaid 固定配置', () => {
  it('securityLevel 是 strict，且 HTML 标签能力关闭', () => {
    // T065-C02 的判据「配置保持 strict」在这里是可断言的常量：配置对象是模块级
    // 常量，没有任何字段由视图内容、标题或意图派生。
    expect(MERMAID_CONFIG.securityLevel).toBe('strict');
    expect(MERMAID_CONFIG.htmlLabels).toBe(false);
    expect(MERMAID_CONFIG.flowchart.htmlLabels).toBe(false);
    expect(MERMAID_CONFIG.startOnLoad).toBe(false);
  });

  it('配置里没有来自视图内容的字段名', () => {
    // 一个把视图文本拼进配置的实现在上一条里也可能通过，所以再断言一次
    // 「配置只由固定字面量构成」：键集合恰好是这几个，没有容纳用户文本的位置。
    expect(Object.keys(MERMAID_CONFIG).sort()).toEqual(
      ['flowchart', 'htmlLabels', 'maxEdges', 'maxTextSize', 'securityLevel', 'startOnLoad', 'theme'].sort(),
    );
    expect(Object.keys(MERMAID_CONFIG.flowchart).sort()).toEqual(
      ['curve', 'htmlLabels', 'useMaxWidth'].sort(),
    );
  });
});
