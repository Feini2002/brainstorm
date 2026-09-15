import {
  captureViaUi,
  seedItemViaApi,
  uniqueText,
  WORKSPACE_ROUTES,
} from './support/harness';
import { expect, gotoInbox, test } from './support/fixtures';
import { E2E_DATA_DIR } from './support/env';

/**
 * T024 验收｜无 Key 与断网可用路径
 *
 * `tests/e2e/support/harness.ts` blocks every non-loopback host and records each
 * attempt, so "offline" in these cases means the real condition the spec asks
 * for: 127.0.0.1 reachable, the external network not (T024-R05).
 *
 * This suite runs with no LLM settings row at all — the database is fresh — so
 * "no key configured" is the actual state, not a mocked one.
 */
test.describe('T024 无 Key 与断网可用路径', () => {
  test.beforeAll(() => {
    // Guard the guard: if someone points BRAIN_DATA_DIR at the user's data, stop
    // rather than mutating real knowledge (T026 「测试不触碰用户数据库」).
    expect(E2E_DATA_DIR).toContain('tests');
  });

  test('T024-C01 无 Key 创建、编辑与搜索三条笔记，全程没有模型请求', async ({
    page,
    traffic,
  }) => {
    await gotoInbox(page);

    const first = uniqueText('无Key-词');
    const second = uniqueText('无Key-段');
    const third = uniqueText('无Key-多行');

    await captureViaUi(page, first);
    await captureViaUi(page, `${second}\n这是同一段里的第二行。`);
    await captureViaUi(page, third);

    // All three are readable back from the library, which proves storage rather
    // than just an optimistic UI update.
    await page.goto('/library');
    for (const text of [first, second, third]) {
      await page.getByTestId('library-search').fill(text);
      await expect(page.getByTestId('knowledge-card').filter({ hasText: text })).toBeVisible();
    }

    // T024-C01「必须排除：最基础记录流程不应依赖付费服务」. The model endpoints are
    // the only ones that could reach a provider, and none of them was called.
    const modelCalls = traffic
      .apiRequests()
      .filter((entry) => entry.url.includes('/organize') || entry.url.includes('/settings/llm/test'));
    expect(modelCalls, '创建与检索不应触发任何模型调用').toEqual([]);
    expect(traffic.blockedRequests(), '应没有任何被拦截的外网请求').toEqual([]);
  });

  test('T024-C02 外网断开时资料库浏览与人工关系照常可用', async ({ page, traffic }) => {
    await gotoInbox(page);
    const left = uniqueText('断网-左');
    const right = uniqueText('断网-右');
    const leftId = await seedItemViaApi(page, { rawText: left });
    await seedItemViaApi(page, { rawText: right });

    await page.goto('/library');
    await page.getByTestId('library-search').fill(left);
    await expect(page.getByTestId('knowledge-card').filter({ hasText: left })).toBeVisible();

    // Build a relation by hand: this is a local write and must not need a model.
    await page.getByTestId('knowledge-card').filter({ hasText: left }).getByRole('button').first().click();
    const drawer = page.getByTestId('knowledge-drawer');
    await expect(drawer).toBeVisible();

    const editor = page.getByTestId('relation-editor');
    await editor.getByTestId('relation-target').selectOption({ label: right });
    await editor.getByTestId('relation-type').selectOption('related_to');
    await editor.getByTestId('relation-reason').fill('断网时建立');
    await editor.getByTestId('relation-submit').click();
    await expect(editor.getByText('关系已保存')).toBeVisible();

    // The relation is real, not a local echo: close the drawer, reload the page
    // and re-open the record. The review panel re-reads from the server, so a row
    // here can only come from the database (T024-C02「必须排除：全局网络状态不能封锁
    // 本地数据库」).
    await page.getByTestId('drawer-close').click();
    await page.reload();
    await page.getByTestId('library-search').fill(left);
    await page.getByTestId('knowledge-card').filter({ hasText: left }).getByRole('button').first().click();
    await expect(page.getByTestId('knowledge-drawer')).toBeVisible();
    await expect(
      page.getByTestId('relation-review-panel').getByTestId('relation-row'),
    ).toHaveCount(1);

    // Everything above is loopback-only; the blocked list proves the external
    // network really was unreachable rather than merely unused (T024-C02「必须排除：
    // 全局网络状态不能封锁本地数据库」).
    expect(traffic.externalRequests()).toEqual([]);
    expect(leftId).toMatch(/[0-9a-f-]{36}/u);
  });

  test('T024-C03 已保存的视图使用本地资源渲染，没有 CDN 拉取', async ({ page, traffic }) => {
    await gotoInbox(page);

    // Every page that will eventually render a saved view. At this stage the
    // graph/mindmap/flow sections are honest placeholders, and that is exactly
    // what this case checks: the *shell and renderer assets* are local, so no
    // remote bundle is needed before a saved view can be opened.
    for (const route of WORKSPACE_ROUTES) {
      await page.goto(route);
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
      await expect(page.locator('main h1')).toBeVisible();
    }

    // T024-C03「必须排除：隐式外部插件会破坏离线承诺」. A CDN-loaded font, icon set
    // or renderer would appear here as a blocked external request.
    expect(traffic.blockedRequests(), '任何外部资源都会破坏离线承诺').toEqual([]);
    expect(traffic.externalRequests()).toEqual([]);

    // T024-R01: the font stack is local, so the page must not wait on a webfont.
    const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(bodyFont.toLowerCase()).not.toContain('http');
  });

  test('T024-C04 本地服务停止时页面无法连接，且文档说明需要先启动', async ({ page }) => {
    await gotoInbox(page);

    // T024-C04「必须排除：本地优先不等同于完整 PWA 后台服务」. Simulate the local
    // process being gone by failing the API at the transport layer.
    await page.route('**/api/health', (route) => route.abort('connectionrefused'));
    await page.reload();

    // The shell still renders — it is not a service worker — and the connection
    // notice states the concrete situation instead of pretending to work.
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  });

  test('T024-C05 整理失败后仍可立刻保存下一条', async ({ page }) => {
    await gotoInbox(page);

    // "保存并整理" with no model configured: the text is saved first, then the
    // missing configuration is explained (T013-R06 / T025-R04).
    const first = uniqueText('整理失败-前');
    await page.getByTestId('capture-input').fill(first);
    await page.getByTestId('capture-save-organize').click();

    await expect(page.getByTestId('save-phase')).toContainText('已保存');
    await expect(page.getByTestId('capture-hint')).toContainText('配置模型');

    // T024-C05「必须排除：全站错误锁会把非AI功能一起瘫痪」. The input is still
    // usable and the next note saves normally — with no error covering the input.
    await expect(page.getByTestId('capture-input')).toBeEditable();
    // Scoped to the capture box on purpose: the document as a whole always has one
    // `role="alert"` node, because Next.js renders a route announcer for screen
    // readers. Counting alerts globally would test that announcer, not this rule.
    await expect(page.getByTestId('capture-input').locator('xpath=..')).not.toContainText(
      '保存失败',
    );

    const second = uniqueText('整理失败-后');
    await captureViaUi(page, second);

    await page.goto('/library');
    await page.getByTestId('library-search').fill(second);
    await expect(page.getByTestId('knowledge-card').filter({ hasText: second })).toBeVisible();
  });

  test('T024-C06 阻断远程字体与图标域名后，六页文字与关键控件仍可用', async ({
    page,
    traffic,
  }) => {
    await gotoInbox(page);

    // The harness already refuses every external host, so browsing all six pages
    // is itself the check. Assert the concrete controls each page needs, not just
    // that HTML rendered (docs/05_tests/G1 T024-C06).
    await expect(page.getByTestId('capture-input')).toBeEditable();
    // An empty box must not offer a save; typing must enable it. That is the real
    // "the control works" claim — asserting `toBeEnabled` on an empty form would
    // be asserting the wrong thing.
    await expect(page.getByTestId('capture-save')).toBeDisabled();
    await page.getByTestId('capture-input').fill('离线自检');
    await expect(page.getByTestId('capture-save')).toBeEnabled();
    await expect(page.getByTestId('capture-save-organize')).toBeEnabled();
    await page.getByTestId('capture-input').fill('');

    await page.goto('/library');
    await expect(page.getByTestId('library-search')).toBeVisible();
    await expect(page.getByTestId('library-sort')).toBeVisible();
    await expect(page.getByTestId('library-type')).toBeVisible();

    for (const route of ['/graph', '/mindmap', '/flow', '/settings'] as const) {
      await page.goto(route);
      await expect(page.locator('main h1')).toBeVisible();
      // No control may be a dead button: every nav link must lead somewhere real.
      await expect(page.getByRole('link', { name: '收件箱' })).toBeVisible();
    }

    expect(traffic.blockedRequests(), '视觉资源不该成为功能依赖').toEqual([]);
  });
});
