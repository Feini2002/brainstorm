/**
 * T075-C03｜图标签攻击：Markmap 与 Mermaid 的信任边界。
 *
 * 用例规格：`docs/05_tests/G6/T075_cases.md`；规则 T075-R03。
 *
 * ## 这一半断言什么，另一半在哪里
 *
 * T075-C03 的观察方法是「没有执行与未声明出站请求」——那只能在真实页面里观察。
 * 所以本文件只钉住**可在 Node 里诚实断言**的那部分：标签白名单与事件属性规则本身，
 * 以及「生产渲染器确实调用了净化器、且净化发生在交给库之前」这条接线。
 *
 * 真实的执行与请求观察已经在 G5 就有归属，本文件**不重写第二份**：
 *
 *  - `tests/browser/flow-render-security.test.ts`（Mermaid/SVG，真 Chromium + 真 DOMPurify）
 *    逐条把攻击面按 `innerHTML` 放进活页面，数真实请求。
 *  - `tests/e2e/markmap.spec.ts` T057-C03 走真实 `/mindmap` 页面，断言标签里的远端
 *     图片不产生任何外部请求。
 *
 * ## 本文件补的真实缺口
 *
 * 本轮盘点发现 `src/features/mindmap/sanitizeContent.ts` **在此之前没有任何测试
 * 引用**（`MINDMAP_ALLOWED_TAGS` / `MINDMAP_FORBIDDEN_ATTR_PATTERN` / `sanitizeNodeContent`
 * 全仓库 0 命中）。那是 Markmap 侧的信任边界：Markmap 把节点 `content` 当 HTML 用
 * `.html()` 注入 `foreignObject`。DSL 的 Mermaid 侧有完备矩阵，Markmap 侧一个都没有。
 *
 * ## 为什么不在 Node 里调用 `sanitizeNodeContent`
 *
 * 实测：本仓库 Node 环境下 `DOMPurify.isSupported === false`，
 * `typeof DOMPurify.sanitize === 'undefined'`，调用会抛
 * `default.addHook is not a function`。给净化器塞一个假 DOM 只会让断言变成关于假货的
 * 断言。本文件因此断言**导出契约**（数组与模式，它们是 `DOMPurify.sanitize` 的真实输入），
 * 运行时结果由上面的浏览器/e2e 用例负责。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MINDMAP_ALLOWED_ATTR,
  MINDMAP_ALLOWED_TAGS,
  MINDMAP_FORBIDDEN_ATTR_PATTERN,
} from '@/features/mindmap/sanitizeContent';

const projectRoot = path.resolve(import.meta.dirname, '../..');

describe('T075-C03 Markmap 标签白名单排除执行、嵌入与导航能力', () => {
  /**
   * 每一个都能「加载东西」或「执行东西」，因此都不允许出现在节点内容里。
   *
   * `a` 也在列：契约（`03_dto_and_version_rules.md`）说链接在脑图节点里被移除，
   * 而一个净化过的 `href` 仍然是一次用户没要求的导航。
   */
  const DANGEROUS_TAGS = [
    'script',
    'style',
    'iframe',
    'object',
    'embed',
    'img',
    'svg',
    'video',
    'audio',
    'source',
    'link',
    'base',
    'form',
    'input',
    'button',
    'a',
    'foreignObject',
    'math',
    'template',
  ] as const;

  it.each(DANGEROUS_TAGS)('白名单不含 <%s>', (tag) => {
    const allowed = MINDMAP_ALLOWED_TAGS.map((entry) => entry.toLowerCase());
    expect(allowed).not.toContain(tag.toLowerCase());
  });

  it('属性白名单只留 class，href/src/style 都不在', () => {
    // href/src 是加载资源的两条路，style 能带 url()/@import，id 能造成选择器冲突。
    const allowed = MINDMAP_ALLOWED_ATTR.map((entry) => entry.toLowerCase());
    expect(allowed).toEqual(['class']);

    for (const attribute of ['href', 'src', 'xlink:href', 'style', 'id', 'srcset']) {
      expect(allowed, `${attribute} 不应出现在白名单属性里`).not.toContain(attribute);
    }
  });

  it('on* 事件属性按前缀匹配，覆盖平台新增的名字', () => {
    // 按名字枚举会在浏览器加一个新事件时静默失效，所以规则必须是模式。
    for (const name of ['onload', 'onerror', 'onclick', 'onbegin', 'onanimationend', 'ONLOAD', 'OnX']) {
      expect(MINDMAP_FORBIDDEN_ATTR_PATTERN.test(name), `${name} 应被判定为事件属性`).toBe(true);
    }
    for (const name of ['class', 'id', 'role', 'href', 'data-x']) {
      expect(MINDMAP_FORBIDDEN_ATTR_PATTERN.test(name), `${name} 不应被判定为事件属性`).toBe(false);
    }
  });

  it('白名单仍然够画一个脑图节点，不是空集合', () => {
    // 反向约束：把白名单删空也能让上面几条全绿，所以必须证明它保留了标签真正需要的
    // 行内格式。模型整理出来的标签可能带粗体、行内代码与删除线。
    const allowed = MINDMAP_ALLOWED_TAGS.map((entry) => entry.toLowerCase());
    for (const tag of ['strong', 'em', 'code', 'del', 'sub', 'sup', 'mark', 'span', 'br']) {
      expect(allowed, `脑图标签需要 ${tag}`).toContain(tag);
    }
    for (const tag of ['p', 'blockquote', 'ul', 'ol', 'li']) {
      expect(allowed, `多行标签需要 ${tag}`).toContain(tag);
    }
  });
});

describe('T075-C03 净化接线：生产渲染器先净化再交给 Markmap', () => {
  const renderer = readFileSync(
    path.join(projectRoot, 'src/features/mindmap/MindmapRenderer.tsx'),
    'utf8',
  );

  it('调用的是 sanitizeTree，且结果才进入 setData', () => {
    // 断言的是接线，不是「模块里有这个函数」：`sanitizeTree(result.root)` 必须出现在
    // `setData` 之前，否则不安全字符串已经先被赋值给活元素了。
    const sanitizeIndex = renderer.indexOf('sanitizeTree(result.root)');
    const setDataIndex = renderer.indexOf('setData(tree)');

    expect(sanitizeIndex, '渲染器必须调用 sanitizeTree').toBeGreaterThan(-1);
    expect(setDataIndex, '渲染器必须调用 setData').toBeGreaterThan(-1);
    expect(sanitizeIndex, '净化必须发生在 setData 之前').toBeLessThan(setDataIndex);
  });

  it('不接受 transformer 报告的待加载资源，出现即拒绝', () => {
    // Markmap 的插件机制可以声明要加载的样式/脚本。当前用 `new Transformer([])` 且
    // 显式断言为空，所以一个「以后加了插件」的改动会在这里被拦住，而不是静默去外网。
    expect(renderer).toContain('getUsedAssets');
    expect(renderer).toMatch(/assets\.styles|assets\.scripts/u);
    expect(renderer).toContain('脑图渲染器试图加载外部资源，已拒绝');
  });

  it('sanitizeContent 模块本身不引用任何出站原语', () => {
    const source = readFileSync(
      path.join(projectRoot, 'src/features/mindmap/sanitizeContent.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/(?<![\w.])fetch\s*\(/u);
    expect(source).not.toMatch(/from\s+['"]node:(https?|net|tls)['"]/u);
  });
});
