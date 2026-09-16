import { expect, gotoInbox, test } from './support/fixtures';
import { authHeaders } from './support/harness';
import { E2E_ORIGIN } from './support/env';

/**
 * T078-R05：窄屏与中文输入法。
 *
 * 这个文件里的用例带 `@narrow` 标记，所以会在 `chromium-narrow`（1280×720 的**小桌面**，
 * 不是手机——本项目是桌面专用）这个 project 下再跑一遍。它们断言的都是**依赖布局**的行为：
 * 控件在变窄之后还在不在、点不点得到、键盘走不走得通。桌面宽度下也跑一次，两条 project 的
 * 结果都算证据。
 *
 * 输入法的处理分两层，因为两层能证明的事情不同（T078-R05 要求「用适当事件模拟并辅以人工检查」
 * 并「辅以人工检查记录」）：
 *
 *  - **事件层（可自动断言）**：`compositionstart` 之后按 Enter，不得提交；`compositionend`
 *    之后再按 Ctrl+Enter 才提交。这直接驱动产品自己的 `captureShortcuts` 规则，浏览器是真的
 *    在派发 composition 事件，不是绕过组件调用函数。
 *  - **人工层（只能记录，不能冒充自动化）**：真实输入法的候选窗、拼音上屏、全角标点这些
 *    行为本机无法在无头 Chromium 里复现。`docs/browser-test-map.md` 的 T078-C05 一节逐条
 *    记录实际人工检查的步骤与结果；**未做的项如实标注未做**，不写成已通过。
 */

test.describe('T078 窄屏与中文输入', () => {
  test('T078-C05 @narrow 窄屏下保存并打开详情：键盘可完成，控件没有被推出视口', async ({
    page,
  }) => {
    await gotoInbox(page);

    const viewport = page.viewportSize();
    expect(viewport, '必须能读到视口尺寸').toBeTruthy();

    // 保存入口在窄屏下必须仍可点：先断言它完整落在视口内，再真的点它。
    const save = page.getByTestId('capture-save');
    await save.scrollIntoViewIfNeeded();
    const saveBox = await save.boundingBox();
    expect(saveBox, '保存按钮应有可点区域').toBeTruthy();
    expect(
      saveBox!.x >= 0 &&
        saveBox!.y >= 0 &&
        saveBox!.x + saveBox!.width <= viewport!.width &&
        saveBox!.y + saveBox!.height <= viewport!.height,
      `保存按钮必须完整落在视口内（按钮 ${JSON.stringify(saveBox)}，视口 ${viewport!.width}x${viewport!.height}）`,
    ).toBe(true);

    // 用键盘而不是点击：填字 → Ctrl+Enter，走产品自己的快捷键规则。
    const text = `窄屏键盘输入-${Date.now()}`;
    const input = page.getByTestId('capture-input');
    await input.click();
    await input.fill(text);
    await page.keyboard.press('Control+Enter');
    await expect(page.getByTestId('save-phase')).toContainText('已保存');
    await expect(input).toHaveValue('');

    // 详情抽屉在窄屏下也要能打开并读到内容（核心功能可用，不是「页面还在」）。
    await page.getByTestId('knowledge-card').filter({ hasText: text }).first().getByRole('button').first().click();
    const drawer = page.getByTestId('knowledge-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText(text);

    // 清理：删掉这条记录，窄屏 project 与桌面 project 都会跑本用例，不留下累积状态。
    await page.getByTestId('drawer-delete').click();
    await expect(page.getByTestId('delete-dialog')).toBeVisible();
    await page.getByTestId('delete-confirm').click();
    await expect(drawer).toBeHidden();
  });

  test('T078-C05 @narrow 六个页面在窄屏下都能打开导航并渲染主区域', async ({ page }) => {
    const routes = ['/inbox', '/library', '/graph', '/mindmap', '/flow', '/settings'];
    for (const route of routes) {
      await page.goto(route);
      // 页面身份：导航与主区域都在，且是当前这个路由而不是上一页残留。
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
      await expect(page.locator('main')).toBeVisible();
      // 没有横向溢出到把内容推走：文档宽度不得超过视口宽度太多。
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${route} 在窄屏下不应横向溢出（多出 ${overflow}px）`).toBeLessThanOrEqual(1);
    }
  });

  test('T078-C05 IME 组合期间的回车不提交，组合结束后 Ctrl+Enter 才提交', async ({ page }) => {
    await gotoInbox(page);

    const input = page.getByTestId('capture-input');
    const text = `输入法组合-${Date.now()}`;
    await input.click();
    await input.fill(text);

    // 记录这一轮发出的创建请求：组合期间必须一次都没有。
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/items')) {
        writes.push(request.url());
      }
    });

    // 组合期间的 **Ctrl+Enter**：这才是 `isComposingKey` 真正在守的那一条。
    //
    // 必须是 Ctrl+Enter 而不是裸 Enter：裸 Enter 本来就只换行，去掉守卫它也不会提交，
    // 于是用例会空过（变异去掉 `isComposingKey` 后仍全绿——这是实测出来的，不是推测）。
    // 用户按着 Ctrl 确认候选时，只有守卫能拦住这次提交。
    await page.evaluate(() => {
      const element = document.querySelector('[data-testid="capture-input"]');
      if (!(element instanceof HTMLTextAreaElement)) throw new Error('找不到采集输入框');
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
          isComposing: true,
        }),
      );
    });
    await page.waitForTimeout(300);
    expect(writes, '组合期间带 isComposing 的 Ctrl+Enter 不得提交').toEqual([]);
    // 半截候选不能被当成成品：草稿原样留着，一个字都没少。
    await expect(input).toHaveValue(text);

    // 组合结束之后，同样的 Ctrl+Enter 必须真的提交——否则「不提交」可能只是因为
    // 提交路径整个坏了。这一步是上一步的对照。
    await page.evaluate(() => {
      const element = document.querySelector('[data-testid="capture-input"]');
      if (!(element instanceof HTMLTextAreaElement)) throw new Error('找不到采集输入框');
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
          isComposing: false,
        }),
      );
    });
    await expect(page.getByTestId('save-phase')).toContainText('已保存');
    expect(writes.length, '组合结束后的 Ctrl+Enter 应恰好提交一次').toBe(1);

    // 服务端确实有这条记录（不是只弹了提示）。
    const headers = await authHeaders(page);
    const found = await page.request.get(`${E2E_ORIGIN}/api/items`, {
      headers,
      params: { q: text, limit: 5 },
    });
    const body = (await found.json()) as { data: { items: { id: string; rawText: string }[] } };
    const match = body.data.items.find((entry) => entry.rawText.includes(text));
    expect(match, '提交后应能从服务端读回这条记录').toBeTruthy();

    // 清理。
    await page.request.delete(`${E2E_ORIGIN}/api/items/${match!.id}`, {
      headers,
      data: { expectedRevision: 1 },
    });
  });
});
