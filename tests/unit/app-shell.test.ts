/**
 * T005 验收：六页应用骨架与导航状态（可纯测部分）。
 *
 * 用例规格：docs/05_tests/G0/T005_cases.md。审计结论是「只有 e2e 证据」。骨架布局、
 * 窄窗口表现、Tab 焦点顺序、图形库懒加载都与真实渲染耦合，node 环境无法断言。
 *
 * 但 T005 里有两类可纯测的真实规则，而且都曾经是真实缺陷形态：
 *   - **路由表与导航表必须一致**：`src/features/shared/navigation.ts` 的一份清单同时驱动
 *     侧栏与高亮，只要有一页不在清单里，那一页就只能靠手输地址访问；
 *   - **最长前缀匹配**：`/library/xxx` 这类嵌套路由必须仍高亮「资料库」，否则用户在
 *     子页面会看到没有当前项的侧栏。
 * 另外补两条服务端可断言的：根路径不是一个落地页、六个页面都真实存在（404 不等于页面）。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_ROUTE, NAV_DESTINATIONS, findDestination } from '@/features/shared/navigation';

const projectRoot = path.resolve(import.meta.dirname, '../..');

describe('T005-C01/C02 六个页面都真实存在', () => {
  it('T005-C01 根路径是重定向到收件箱，不是一个需要先配置模型的落地页', () => {
    const source = readFileSync(path.join(projectRoot, 'src/app/page.tsx'), 'utf8');

    // 根路径必须直接发送到默认路由：先拦住用户要 Key 会违反 T005-C01 的排除项。
    expect(source).toContain('DEFAULT_ROUTE');
    expect(source).toMatch(/redirect\s*\(/u);
    expect(DEFAULT_ROUTE).toBe('/inbox');
  });

  it('T005-C02 导航里的每个目的地都有对应的 page.tsx，直达不会 404', () => {
    expect(NAV_DESTINATIONS.length).toBe(6);

    const missing: string[] = [];
    for (const destination of NAV_DESTINATIONS) {
      // `/inbox` → `src/app/(workspace)/inbox/page.tsx`
      const candidates = [
        path.join(projectRoot, 'src/app', destination.href, 'page.tsx'),
        path.join(projectRoot, 'src/app/(workspace)', destination.href, 'page.tsx'),
      ];
      if (!candidates.some((candidate) => existsSync(candidate))) missing.push(destination.href);
    }
    // 侧栏点得到、手输却 404，正是 T005-C02 要排除的形态。
    expect(missing).toEqual([]);
  });

  it('T005-C02 反向也成立：六个页面目录没有一个是游离在导航之外的', () => {
    const fromNav = new Set(NAV_DESTINATIONS.map((destination) => destination.href));
    for (const href of ['/inbox', '/library', '/graph', '/mindmap', '/flow', '/settings']) {
      expect(fromNav.has(href), `${href} 不在导航清单里`).toBe(true);
    }
    // flow 属于并行 worker 的范围，本文件只做「存在且在导航里」这一层断言。
    expect(NAV_DESTINATIONS.map((destination) => destination.label)).toEqual([
      '收件箱',
      '资料库',
      '关系图',
      '脑图',
      '流程图',
      '设置',
    ]);
  });

  it('T005-C01 六个目的地各自有独立 href，没有两个导航项指向同一页', () => {
    const hrefs = NAV_DESTINATIONS.map((destination) => destination.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    // 描述用于页面头与空态，空描述会让头部出现空白。
    for (const destination of NAV_DESTINATIONS) {
      expect(destination.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('T005-C02/C03 当前页辨认（最长前缀匹配）', () => {
  it('T005-C02 直达每个路由都能找到当前项，侧栏有明确高亮', () => {
    for (const destination of NAV_DESTINATIONS) {
      expect(findDestination(destination.href)?.href).toBe(destination.href);
    }
  });

  it('T005-C02 嵌套子路由仍高亮所属的父级，而不是丢失当前项', () => {
    // 详情页 / 子页面打开时侧栏不该显示「没有当前页」。
    expect(findDestination('/library/item/abc')?.href).toBe('/library');
    expect(findDestination('/graph/xyz')?.href).toBe('/graph');
    expect(findDestination('/settings/llm')?.href).toBe('/settings');
  });

  it('T005-C02 匹配不是「前缀字符串相等」：/inboxing 不属于收件箱', () => {
    // 只判断 startsWith('/inbox') 会把 /inboxing 也点亮，这是最容易犯的实现错误。
    expect(findDestination('/inboxing')).toBeNull();
    expect(findDestination('/librarian')).toBeNull();
    expect(findDestination('/unknown')).toBeNull();
    expect(findDestination('/')).toBeNull();
  });

  it('T005-C02 根路径与未匹配路径都不报错，返回 null 由调用方决定表现', () => {
    expect(() => findDestination('')).not.toThrow();
    expect(findDestination('')).toBeNull();
  });
});
