import { expect, gotoInbox, test } from './support/fixtures';
import { authHeaders, captureViaUi, uniqueText, WORKSPACE_ROUTES, revealDiagnostics } from './support/harness';
import { E2E_HOST, E2E_ORIGIN, E2E_PORT } from './support/env';

/**
 * T074 验收｜图空白（C03）与无遥测（C06）
 *
 * 这两条必须有真实浏览器，理由各不相同：
 *
 *  - **C03 的「容器高度为零但 API 成功」只有在真实布局里才成立。** `getBoundingClientRect`
 *    返回 0 是排版结果，进程内没有渲染引擎可以产生它。而且这条规则要防的是
 *    「网络成功即当作可视化成功」，所以必须让真实的 200 响应先到达，再把容器压扁，
 *    然后观察面板是否仍然把它报成问题——手写 DOM stub 只会让断言变成关于 stub 的断言。
 *  - **C06 的「没有未声明的第三方统计请求」要真发请求才算数。** `traffic` fixture
 *    （`tests/e2e/support/fixtures.ts`）在构造上就记录每一条请求，所以「没有外部请求」
 *    是有清单支撑的结论，而不是「没看见」。
 *
 * 这里不复述 C01/C02/C04/C05：它们由 `tests/integration/diagnostics.test.ts` 在真实
 * 路由上覆盖（本文件末尾只做一次「设置页真的接上了诊断面板」的接线检查）。
 */
test.describe('T074-C03 图空白', () => {
  test('T074-C03 容器高度为零但 API 成功时，客户端诊断报渲染尺寸问题', async ({ page }) => {
    await page.goto('/settings');
    await revealDiagnostics(page);
    const panel = page.getByTestId('diagnostics-panel');
    await expect(panel).toBeVisible();
    // 前置：接口确实成功了，并且数据已经渲染出来。若这里是错误态，下面的
    // 断言就变成在测一条失败的请求，而不是在测「成功但看不见」。
    await expect(page.getByTestId('diagnostics-version')).toContainText('feini-brain');
    await expect(page.getByTestId('diagnostics-lock-probe')).toBeVisible();

    // 把被测的内容区压成 0 高度：内容与数据都在，只是没有可绘制区域。
    const surface = page.getByTestId('diagnostics-surface');
    await surface.evaluate((element) => {
      (element as HTMLElement).style.height = '0px';
      (element as HTMLElement).style.overflow = 'hidden';
    });

    // 「动作：查看客户端诊断」——显式重新测量，而不是依赖某个时机。
    await page.getByTestId('diagnostics-recheck').click();

    const issue = page.getByTestId('diagnostics-render-issue');
    await expect(issue).toBeVisible();
    await expect(issue).toContainText('渲染尺寸问题');
    // 「必须排除：网络成功不代表可视化成功」——面板把这句话直接写出来。
    await expect(issue).toContainText('网络成功不代表可视化成功');
    await expect(page.getByTestId('diagnostics-layer-render')).toBeVisible();

    // 恢复样式后问题消失：这证明上一条不是恒真断言。
    await surface.evaluate((element) => {
      (element as HTMLElement).style.height = '';
      (element as HTMLElement).style.overflow = '';
    });
    await page.getByTestId('diagnostics-recheck').click();
    await expect(page.getByTestId('diagnostics-render-issue')).toHaveCount(0);
  });

  test('T074-C03 被标记为绘制面的容器塌陷时也会被报出来，并被写进复制摘要', async ({ page }) => {
    await page.goto('/settings');
    await revealDiagnostics(page);
    const panel = page.getByTestId('diagnostics-panel');
    await expect(panel).toBeVisible();

    // 一个「像图容器那样」被标记的绘制面，全部内容都在、只是没有高度。
    await page.evaluate(() => {
      const surface = document.createElement('div');
      surface.setAttribute('data-diagnostic-surface', '知识图容器');
      surface.style.height = '0px';
      surface.style.width = '640px';
      surface.setAttribute('data-testid', 'fake-graph-surface');
      document.body.appendChild(surface);
    });

    await page.getByTestId('diagnostics-recheck').click();
    const issue = page.getByTestId('diagnostics-render-issue');
    await expect(issue).toBeVisible();
    await expect(issue).toContainText('知识图容器');
    await expect(issue).toContainText('640×0');

    // 渲染尺寸问题必须进入可粘贴的摘要，否则用户分享出去的是一份「一切正常」。
    const preview = page.getByTestId('diagnostics-export-preview');
    await expect(preview).toContainText('知识图容器');
    await expect(preview).toContainText('"render"');
  });

  test('T074-C03 正常尺寸下不报渲染问题，接口也能正常读到报告', async ({ page, traffic }) => {
    await page.goto('/settings');
    await revealDiagnostics(page);
    await expect(page.getByTestId('diagnostics-panel')).toBeVisible();
    await expect(page.getByTestId('diagnostics-version')).toContainText('feini-brain');

    // 反例：没有塌陷容器时不应出现渲染层问题。
    await page.getByTestId('diagnostics-recheck').click();
    await expect(page.getByTestId('diagnostics-render-issue')).toHaveCount(0);

    // 诊断读取本身是应用自己的接口，且只读。
    const diagnosticsCalls = traffic
      .apiRequests()
      .filter((request) => request.url.includes('/api/diagnostics'));
    expect(diagnosticsCalls.length, '设置页应真的读了 /api/diagnostics').toBeGreaterThan(0);
  });

  test('诊断未展开时不请求诊断报告', async ({ page, traffic }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
    await expect(page.getByTestId('diagnostics-panel')).toHaveCount(0);
    const before = traffic
      .apiRequests()
      .filter((request) => request.url.includes('/api/diagnostics'));
    expect(before, '未打开诊断时不应请求 /api/diagnostics').toEqual([]);
    await revealDiagnostics(page);
    await expect(page.getByTestId('diagnostics-panel')).toBeVisible();
    const after = traffic
      .apiRequests()
      .filter((request) => request.url.includes('/api/diagnostics'));
    expect(after.length).toBeGreaterThan(0);
  });
});

test.describe('T074-C06 无遥测', () => {
  test('T074-C06 正常使用全部页面时没有未声明的第三方统计请求', async ({ page, traffic }) => {
    await gotoInbox(page);

    // 「前置：正常使用全部页面」——真的用一遍，包括记一条笔记与打开诊断。
    const text = uniqueText('T074遥测');
    await captureViaUi(page, text);

    for (const route of WORKSPACE_ROUTES) {
      await page.goto(route);
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
      await expect(page.locator('main h1')).toBeVisible();
    }

    // 特别看一遍设置页：诊断面板就在那里，遥测最可能藏在这里。
    await page.goto('/settings');
    await revealDiagnostics(page);
    await expect(page.getByTestId('diagnostics-panel')).toBeVisible();
    await expect(page.getByTestId('diagnostics-version')).toContainText('feini-brain');

    // 「必须断言：没有未声明的第三方统计请求」。traffic 记录了每一条尝试发出的
    // 请求，所以这是一份清单而不是一次缺席证明。
    const external = traffic.externalRequests();
    expect(
      external,
      `不应有任何外部请求，实际记录：${JSON.stringify(external.slice(0, 5))}`,
    ).toEqual([]);
    expect(traffic.blockedRequests(), '也不应有被拦下的外网尝试').toEqual([]);

    // 所有真正发生的请求都指向本机应用。
    expect(traffic.records.length).toBeGreaterThan(0);
    for (const entry of traffic.records) {
      expect(entry.host, `请求 ${entry.url} 应指向本机`).toBe(E2E_HOST);
    }

    // 诊断接口是**本地**接口，第三方遥测若有会是另一个 host；同时确认它真的被调用过，
    // 免得把「诊断面板根本没加载」误读成「没有遥测」。
    const diagnosticsCalls = traffic
      .apiRequests()
      .filter((request) => request.url.includes('/api/diagnostics'));
    expect(diagnosticsCalls.length).toBeGreaterThan(0);
  });

  test('T074-C06 诊断报告自己声明 telemetry 为 none，且没有统计平台域名痕迹', async ({
    page,
  }) => {
    const headers = await authHeaders(page);
    const response = await page.request.get(`${E2E_ORIGIN}/api/diagnostics`, { headers });
    expect(response.status(), 'GET /api/diagnostics 应返回 200').toBe(200);

    const envelope = (await response.json()) as {
      ok: true;
      data: { observability: { telemetry: string } };
    };
    expect(envelope.data.observability.telemetry).toBe('none');

    const raw = JSON.stringify(envelope);
    for (const vendor of ['sentry', 'posthog', 'mixpanel', 'google-analytics', 'gtag', 'plausible']) {
      expect(raw.toLowerCase()).not.toContain(vendor);
    }
  });

  test('T074-C01/R01 没有令牌时诊断读取被拒，浏览器不能旁路到环境资料', async ({ page }) => {
    // 真实 HTTP 层：带 Host/Origin 但不带令牌，必须 403 且不泄漏配置。
    const response = await page.request.get(`${E2E_ORIGIN}/api/diagnostics`, {
      headers: {
        host: `${E2E_HOST}:${E2E_PORT}`,
        origin: E2E_ORIGIN,
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(response.status()).toBe(403);

    const body = await response.text();
    for (const forbidden of ['schemaVersion', 'capabilities', 'node', 'apiKeyConfigured']) {
      expect(body, `拒绝响应不应包含 ${forbidden}`).not.toContain(forbidden);
    }
  });
});
