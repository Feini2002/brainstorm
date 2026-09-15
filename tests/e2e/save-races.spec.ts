import { expect, gotoInbox, test } from './support/fixtures';
import { captureViaUi, uniqueText } from './support/harness';

/**
 * T025 验收｜保存反馈、草稿与未知完成状态
 *
 * These cases are about what the UI claims, so most of them assert on a *message*
 * and then on the stored fact that message is about. A test that only saw "已保存"
 * would not distinguish an honest status line from an optimistic one, which is the
 * whole point of the task (T025-R01).
 *
 * The suite deliberately does not use a mocked API: the interesting states are
 * produced by slowing or failing the *real* endpoint with `page.route`, so the
 * code path under test is the same one a user hits.
 */
test.describe('T025 保存反馈、草稿与未知完成状态', () => {
  test('T025-C01 提交后服务端未返回时只显示正在保存', async ({ page }) => {
    await gotoInbox(page);

    // Hold the create request open so the in-flight state is observable.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/items', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      await held;
      await route.continue();
    });

    const text = uniqueText('进行中');
    await page.getByTestId('capture-input').fill(text);
    await page.getByTestId('capture-save').click();

    // T025-R01: "已保存" must not appear before the server said so.
    await expect(page.getByTestId('save-phase')).toContainText('正在保存');
    await expect(page.getByTestId('save-phase')).not.toContainText('已保存');

    release?.();
    await expect(page.getByTestId('save-phase')).toContainText('已保存');

    await page.unroute('**/api/items');
  });

  test('T025-C02 响应丢失时显示完成状态未知，重试复用同一请求键', async ({ page }) => {    await gotoInbox(page);

    // Only the first POST is dropped; the retry must be allowed through, and the
    // test observes the key it carried.
    const keys: string[] = [];
    let dropFirst = true;
    await page.route('**/api/items', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') {
        await route.continue();
        return;
      }
      const body = request.postDataJSON() as { captureRequestId: string };
      keys.push(body.captureRequestId);
      if (dropFirst) {
        dropFirst = false;
        await route.abort('connectionreset');
        return;
      }
      await route.continue();
    });

    const text = uniqueText('未知完成');
    await page.getByTestId('capture-input').fill(text);
    await page.getByTestId('capture-save').click();

    await expect(page.getByTestId('save-phase')).toContainText('保存结果未知');
    // T025-R02: the user is told the retry is safe, not merely offered one.
    await expect(page.getByTestId('save-phase')).toContainText('同一次请求');

    await page.getByRole('button', { name: '用同一次请求重试' }).click();
    await expect(page.getByTestId('save-phase')).toContainText('已保存');

    // The replay reused the key, so the server could only ever have one record.
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);

    await page.unroute('**/api/items');
  });

  test('T025-C03 保存成功但整理失败时保留已保存状态', async ({ page }) => {
    await gotoInbox(page);

    // No model is configured in this suite, so "保存并整理" is the real
    // "create succeeded, organize cannot run" path (T025-R04).
    const text = uniqueText('整理未完成');
    await page.getByTestId('capture-input').fill(text);
    await page.getByTestId('capture-save-organize').click();

    const status = page.getByTestId('save-phase');
    await expect(status).toContainText('已保存');
    // T025-C03「必须排除：不能把整个组合动作称为保存失败」.
    await expect(status).not.toContainText('保存失败');

    // The hint names the concrete next step, and it survives *client-side* route
    // changes because it lives with the draft rather than in a transient status
    // line (T024-R04). It deliberately does not survive a full page reload — the
    // draft store is memory-only so nothing is written to browser storage
    // (T025-R03) — so this uses nav links, which is what a user does.
    await expect(page.getByTestId('capture-hint')).toContainText('配置模型');
    await page.getByRole('link', { name: '资料库' }).click();
    await expect(page.getByTestId('library-search')).toBeVisible();
    await page.getByRole('link', { name: '收件箱' }).click();
    await expect(page.getByTestId('capture-hint')).toContainText('配置模型');

    // And the record really is stored.
    await page.getByRole('link', { name: '资料库' }).click();
    await page.getByTestId('library-search').fill(text);
    await expect(page.getByTestId('knowledge-card').filter({ hasText: text })).toBeVisible();
  });

  test('T025-C04 未提交文本在切换路由后保留，并在离开时提示风险', async ({ page }) => {
    await gotoInbox(page);

    const draft = uniqueText('未提交草稿');
    await page.getByTestId('capture-input').fill(draft);

    // The warning is registered while unsaved text exists. `beforeunload` cannot
    // be observed through `page.on('dialog')` in Chromium, so the listener is
    // fired directly: `dispatchEvent` returns `false` exactly when a handler called
    // `preventDefault()`, which is the same signal the browser uses to decide
    // whether to prompt. A handler that did nothing returns `true`.
    const blocked = await page.evaluate(() => {
      // Fired on `window` because that is where the app registers the listener.
      return window.dispatchEvent(new Event('beforeunload', { cancelable: true })) === false;
    });
    expect(blocked, '有未保存草稿时 beforeunload 应被取消（浏览器据此提示）').toBe(true);

    // T025-C04「必须排除：简单路由跳转可能清空用户思路」. The draft lives in a
    // module-level in-memory store, so a route change must not discard it.
    await page.getByRole('link', { name: '资料库' }).click();
    await expect(page.getByTestId('library-search')).toBeVisible();
    await page.getByRole('link', { name: '收件箱' }).click();
    await expect(page.getByTestId('capture-input')).toHaveValue(draft);

    // After the draft is committed the warning is no longer registered: an
    // always-on prompt would train the user to dismiss it.
    await page.getByTestId('capture-save').click();
    await expect(page.getByTestId('save-phase')).toContainText('已保存');
    const stillBlocked = await page.evaluate(
      () => window.dispatchEvent(new Event('beforeunload', { cancelable: true })) === false,
    );
    expect(stillBlocked, '草稿清空后不应再拦截离开').toBe(false);
  });

  test('T025-C05 草稿只在内存，localStorage 里没有正文', async ({ page }) => {
    await gotoInbox(page);

    const secret = uniqueText('隐私正文');
    await page.getByTestId('capture-input').fill(secret);
    // Trigger whatever the app does on input, then read durable browser storage.
    await page.waitForTimeout(300);

    const storage = await page.evaluate(() => ({
      local: { ...window.localStorage },
      session: { ...window.sessionStorage },
    }));
    const serialized = JSON.stringify(storage);

    // T025-R03 / T025-C05「必须排除：浏览器持久副本扩大数据暴露面」.
    expect(serialized).not.toContain(secret);
    expect(serialized.toLowerCase()).not.toContain('x-brain-token');
    expect(Object.keys(storage.local)).toHaveLength(0);
    expect(Object.keys(storage.session)).toHaveLength(0);

    await captureViaUi(page, secret);
  });

  test('T025-C06 旧保存响应只清空被提交的快照，新输入继续显示', async ({ page }) => {
    await gotoInbox(page);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/items', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      await held;
      await route.continue();
    });

    const oldText = uniqueText('旧快照');
    const newText = uniqueText('新草稿');

    await page.getByTestId('capture-input').fill(oldText);
    await page.getByTestId('capture-save').click();
    await expect(page.getByTestId('save-phase')).toContainText('正在保存');

    // The user starts the next thought while the first save is still in flight.
    // This is only possible because the textarea is not disabled (T025-R06).
    await page.getByTestId('capture-input').fill(newText);
    await expect(page.getByTestId('capture-input')).toHaveValue(newText);

    // Let the slow response land. It may only clear the snapshot it submitted.
    release?.();
    await expect(page.getByTestId('save-phase')).toContainText('已保存');
    await expect(
      page.getByTestId('capture-input'),
      '旧响应不能清掉保存期间写下的新草稿',
    ).toHaveValue(newText);

    await page.unroute('**/api/items');
  });
});
