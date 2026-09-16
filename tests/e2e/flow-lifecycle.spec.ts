/**
 * T066 验收｜异步渲染竞争、尺寸和降级。
 *
 * 用例原文：`docs/05_tests/G5/T066_cases.md`。规则原文：`docs/04_tasks/G5/T066_flow_lifecycle.md`
 * 的 T066-R01…R06。
 *
 * 本文件取代了早先的 `zz-probe-race.spec.ts`。那个文件只有一个全程 `console.log`
 * 的探针：它没有 `expect`，会往共享库里塞 item 和 view 却不清理，还会被每次全量 e2e
 * 收集。规格明确要求「不把预期行为写成无断言的占位测试」，所以这里把同一件事写成真实
 * 断言，文件名也回到 `tasks.json` 的 `targetFiles` 里点名的那个。
 *
 * ## 每一组为什么必须走真实页面
 *
 * T066 的三条核心性质都是**关于 React 生命周期的**，函数层观察不到：
 *
 *  - **C01 旧图晚到**：`page.tsx` 的 `viewSeq` 与 `useMermaidRender` 的 `currentToken`
 *    都是在「新选择已经落地」之后才比较的，只有真点击、真网络顺序才能制造这个顺序。
 *    制造方法是真的延迟 `GET /api/views/:id`（`page.route` 拖 2s），而不是造假数据。
 *  - **C02 卸载晚回**：要知道晚到的响应有没有写已卸载的 DOM，必须真的导航离开页面。
 *  - **C03/C04/C05/C06**：重试按钮、ResizeObserver、文本降级、两个实例的配置隔离，
 *    都长在组件的挂载与卸载上。
 *
 * 函数层能覆盖的并发/串图性质在 `tests/browser/flow-render-security.test.ts`（那里用真
 * Chromium 跑生产 `renderFlowSvg`）。
 *
 * ## 记账
 *
 * 「重试不计费」「尺寸变化不重新分析」这两个判据都是**外部请求计数**，所以本文件自己
 * 用 `page.on('request')` 记账（`traffic` fixture 仍在，负责「外部主机必须不可达」）。
 * 用 `page.on` 而不是 `page.route` 处理器：请求事件同步分发，计数不会因为 handler 的
 * 异步时机而读到 0 或多读。
 */
import type { Page } from '@playwright/test';

import { expect, gotoInbox, test } from './support/fixtures';
import { seedItemViaApi, uniqueText } from './support/harness';
import { seedView, withSeedDb } from './support/seedData';

/** 顺序类型，保证画出来的是实线箭头而不是虚线推测。 */
const SEQUENCE = 'sequence';

interface FlowSeed {
  name: string;
  nodeLabels: string[];
}

/** 往套件自己的临时库里放一张保存好的流程图，返回它的 id。 */
function seedFlow(itemId: string, seed: FlowSeed): string {
  const labels = seed.nodeLabels;
  return withSeedDb((db) =>
    seedView(db, {
      name: seed.name,
      kind: 'flow',
      itemIds: [itemId],
      content: {
        title: seed.name,
        direction: 'LR',
        nodes: labels.map((label, index) => ({
          id: `n${index}`,
          label,
          itemIds: [itemId],
        })),
        edges: labels.slice(1).map((_, index) => ({
          source: `n${index}`,
          target: `n${index + 1}`,
          kind: SEQUENCE,
          label: `然后第 ${index + 2} 步`,
          itemIds: [itemId],
          relationIds: [],
        })),
      },
    }),
  );
}

/** 打开 `/flow`，等读取结束（选择框可用）。 */
async function openFlowPage(page: Page): Promise<void> {
  await page.goto('/flow');
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await expect(page.getByTestId('flow-view-select')).toBeEnabled();
}

/** 本页发出的 API 请求，按方法+URL 记录。 */
function trackApi(page: Page): {
  all: () => string[];
  generate: () => string[];
  reset: () => void;
} {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (!request.url().includes('/api/')) return;
    requests.push(`${request.method()} ${request.url()}`);
  });
  return {
    all: () => [...requests],
    generate: () => requests.filter((entry) => entry.includes('/api/views/mermaid/generate')),
    reset: () => {
      requests.length = 0;
    },
  };
}

/** 等这张图真的画出来，并返回它画在画面上的文字。 */
async function drawnText(page: Page): Promise<string> {
  const svg = page.getByTestId('flow-svg').locator('svg');
  await expect(svg).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('flow-canvas')).toHaveAttribute('data-phase', 'ready');
  return (await svg.textContent()) ?? '';
}

/** 画面上的节点文字（来自始终存在的文本替代列表，与图无关）。 */
async function fallbackLabels(page: Page): Promise<string[]> {
  return page.getByTestId('flow-fallback-node-select').allInnerTexts();
}

test.describe('T066-C01 旧图晚到', () => {
  test('慢图的响应晚于新选择落地时不得覆盖它：最终显示的是后选的那张', async ({ page }) => {
    await gotoInbox(page);
    const itemId = await seedItemViaApi(page, { rawText: uniqueText('T066C01来源') });
    const slowId = seedFlow(itemId, { name: uniqueText('慢图'), nodeLabels: ['慢图独有的节点'] });
    const fastId = seedFlow(itemId, { name: uniqueText('快图'), nodeLabels: ['快图独有的节点'] });

    // 真把慢图那一张的读取拖住 2 秒，制造「旧请求后到」。
    await page.route(`**/api/views/${slowId}`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await route.continue();
    });

    await openFlowPage(page);
    const select = page.getByTestId('flow-view-select');
    await expect(select.locator(`option[value="${slowId}"]`)).toHaveCount(1);
    await expect(select.locator(`option[value="${fastId}"]`)).toHaveCount(1);

    // 先选慢图（它要 2 秒），150ms 之内换成快图。
    await select.selectOption(slowId);
    await page.waitForTimeout(150);
    await select.selectOption(fastId);

    // 等过慢图那一份响应到达的时刻，再看结果。
    await page.waitForTimeout(3_000);

    // ---- 必须断言：最终显示的是后选的那一张 ----
    await expect(select, '选择框必须停在最后选的那张').toHaveValue(fastId);
    expect(await drawnText(page), '画面必须是快图的文字').toContain('快图独有的节点');
    expect(await drawnText(page), '慢图的文字不得出现').not.toContain('慢图独有的节点');

    // ---- 必须断言：来源面板不能串位 ----
    // 两边的节点来源指向同一批材料，所以「来源正确」在这里的判据是面板里的节点
    // 目录跟着当前那张图走——串位的话它会列出慢图那个节点的名字。
    await expect(page.getByTestId('flow-source-node')).toHaveValue('n0');
    await expect(
      page.getByTestId('flow-source-node').locator('option'),
      '面板的节点目录应只属于当前这张图',
    ).toHaveText(['快图独有的节点']);
    await expect(page.getByTestId('flow-source-panel')).toHaveAttribute('aria-label', '流程图来源与依据');

    // 文本列表也不得残留慢图的节点。
    expect((await fallbackLabels(page)).join('|'), '文本替代应是快图的节点').toContain(
      '快图独有的节点',
    );
    expect((await fallbackLabels(page)).join('|'), '文本替代不得残留慢图的节点').not.toContain(
      '慢图独有的节点',
    );
  });

  test('取消选择也会取消在途读取：清空之后不得被晚到的响应拉回一张图', async ({ page }) => {
    await gotoInbox(page);
    const itemId = await seedItemViaApi(page, { rawText: uniqueText('T066C01取消') });
    const slowId = seedFlow(itemId, { name: uniqueText('慢图取消'), nodeLabels: ['不应出现的节点'] });

    await page.route(`**/api/views/${slowId}`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await route.continue();
    });

    await openFlowPage(page);
    const select = page.getByTestId('flow-view-select');
    await select.selectOption(slowId);
    await page.waitForTimeout(150);
    // 空 value 就是「不打开已保存的流程图」，它也是一次选择（page.tsx 的 selectView）。
    await select.selectOption('');
    await page.waitForTimeout(3_000);

    await expect(select, '清空之后应保持清空').toHaveValue('');
    expect(
      await page.getByTestId('flow-fallback-node-select').count(),
      '不应被晚到的响应拉回一张图',
    ).toBe(0);
    await expect(page.getByTestId('flow-renderer')).toHaveCount(0);
  });
});

test.describe('T066-C02 卸载晚回', () => {
  test('渲染中离开 Flow 页面：晚到的响应不写已卸载的 DOM，也不产生异常', async ({
    page,
    traffic,
    consoleWatch,
  }) => {
    await gotoInbox(page);
    const itemId = await seedItemViaApi(page, { rawText: uniqueText('T066C02来源') });
    const viewId = seedFlow(itemId, { name: uniqueText('卸载图'), nodeLabels: ['卸载前的节点'] });

    // 这一例原来自己装监听再看两个数组；现在监听统一在 `consoleWatch` fixture 里，
    // 它会在 teardown 断言同一件事（T078-R03），这里只读它的分类结果。
    // 本文件其余用例不再单独装监听，也不会因为缺席而漏掉异常。

    // 让读取停在半路，好让「离开页面」和「响应到达」有一个确定的先后。
    await page.route(`**/api/views/${viewId}`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await route.continue();
    });

    await openFlowPage(page);
    await page.getByTestId('flow-view-select').selectOption(viewId);
    // 读到一半就离开（渲染器此时已挂载并处于 pending）。
    await page.waitForTimeout(150);
    await page.goto('/mindmap');
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    // 等那份晚到的响应确实回来。
    await page.waitForTimeout(3_000);

    // ---- 必须断言：不写已卸载 DOM、不报意外警告 ----
    await expect(page, '应停在离开后的页面').toHaveURL(/\/mindmap$/u);
    // 分类后仍为空，与 fixture 的 teardown 断言同一事实：没有豁免掉任何一条。
    expect(
      consoleWatch.unexpectedConsoleErrors(),
      `不应有 React 的卸载告警或其它 console.error：${JSON.stringify(consoleWatch.unexpectedConsoleErrors())}`,
    ).toEqual([]);
    expect(
      consoleWatch.unexpectedPageErrors(),
      `不应有未捕获异常：${JSON.stringify(consoleWatch.unexpectedPageErrors())}`,
    ).toEqual([]);
    expect(consoleWatch.excused(), '这一例不应有任何被豁免的错误').toEqual([]);
    await expect(page.getByTestId('flow-renderer'), 'Flow 的渲染器不应还在文档里').toHaveCount(0);
    // 晚到的响应不能变成一次外部请求（这是同一个承诺的网络侧证据）。
    expect(traffic.externalRequests(), '离开页面之后也不应有外网请求').toEqual([]);
  });
});

test.describe('T066-C03 重试不计费', () => {
  test('渲染失败后点重试：只重跑本地渲染器，不新增任何模型请求', async ({ page }) => {
    await gotoInbox(page);
    const itemId = await seedItemViaApi(page, { rawText: uniqueText('T066C03来源') });
    const viewId = seedFlow(itemId, { name: uniqueText('重试图'), nodeLabels: ['重试前的节点'] });

    const api = trackApi(page);

    /*
     * Install the renderer seam **before the first render**, not after `openFlowPage`.
     *
     * Measured: `page.evaluate` after the page is open sets the flag too late. The
     * page adopts the newest saved flow on mount, so its one render has already
     * succeeded by then; re-selecting the same view changes nothing the render
     * effect depends on (`source` is the same compiled string), and T066-R04
     * requires exactly that — an unchanged source must not re-render. The result
     * was `data-attempts="1"` and `data-phase="ready"`, i.e. the seam was never
     * exercised. `addInitScript` is installed on the document before any page
     * script runs, so the mount-adopt render is the one that fails.
     */
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__feiniForceFlowRenderFailure = true;
    });

    await openFlowPage(page);
    await page.getByTestId('flow-view-select').selectOption(viewId);

    // ---- 必须断言：失败必须降级到 fallback 且给出可读提示 ----
    // `flow-fallback` 是**常驻**的文本替代（T066-R05），所以「它可见」本身证明不了
    // 失败路径走到了它；下面这几条才是失败态独有的证据。
    const fallback = page.getByTestId('flow-fallback');
    await expect(page.getByTestId('flow-canvas')).toHaveAttribute('data-phase', 'failed');
    await expect(
      page.getByTestId('flow-retry-render'),
      '降级必须给出本地重试入口，这只有失败态才有',
    ).toBeVisible();
    await expect(fallback).toContainText('流程图无法渲染');
    await expect(fallback).toContainText('渲染器被要求失败');
    await expect(page.getByTestId('flow-fallback-code')).toContainText('RENDER_FAILED');
    // 降级之后材料仍然可读（C05 的一半也在这里）。
    expect((await fallbackLabels(page)).join('|'), '文本替代仍要列出节点').toContain('重试前的节点');

    // 失败期间 SVG 导出入口不得存在（T068-C05 的假入口规则）。
    await expect(page.getByTestId('export-flow-svg')).toHaveCount(0);

    // ---- 必须断言：只重跑本地 Renderer ----
    const before = {
      attempts: Number(await page.getByTestId('flow-canvas').getAttribute('data-attempts')),
      total: api.all().length,
      generate: api.generate().length,
    };
    expect(before.generate, '打开保存的图不应产生任何生成请求').toBe(0);

    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__feiniForceFlowRenderFailure = false;
    });
    await page.getByTestId('flow-retry-render').click();

    // 重试之后必须真的画出来。
    expect(await drawnText(page), '重试成功后应画出图').toContain('重试前的节点');
    expect(
      Number(await page.getByTestId('flow-canvas').getAttribute('data-attempts')),
      '重试应增加本地渲染次数',
    ).toBeGreaterThan(before.attempts);

    // ---- 必须断言：零新增模型调用 ----
    expect(api.generate(), '重试不得重新调用模型').toEqual([]);
    const after = api.all();
    const added = after.slice(before.total);
    expect(
      added.filter((entry) => entry.includes('/api/views/mermaid/generate')),
      `重试不得新增生成请求，实际新增 ${JSON.stringify(added)}`,
    ).toEqual([]);
    // 重试也不该重新读一遍视图或跑任何写操作。
    expect(
      added.filter((entry) => !/^GET /u.test(entry)),
      `重试不应发出任何非读取请求，实际 ${JSON.stringify(added)}`,
    ).toEqual([]);
  });
});

test.describe('T066-C04 尺寸变化', () => {
  test('频繁调整窗口：没有新模型调用，容器尺寸重新测量且视图仍可读', async ({ page }) => {
    await gotoInbox(page);
    const itemId = await seedItemViaApi(page, { rawText: uniqueText('T066C04来源') });
    const viewId = seedFlow(itemId, {
      name: uniqueText('尺寸图'),
      nodeLabels: ['尺寸图第一个节点', '尺寸图第二个节点'],
    });

    const api = trackApi(page);
    await openFlowPage(page);
    await page.getByTestId('flow-view-select').selectOption(viewId);
    expect(await drawnText(page), '先确认图确实画出来了').toContain('尺寸图第一个节点');

    const canvas = page.getByTestId('flow-canvas');
    const attemptsBefore = await canvas.getAttribute('data-attempts');
    const sizeBefore = await canvas.getAttribute('data-size');
    const svgBefore = await page.getByTestId('flow-svg').innerHTML();
    api.reset();

    // 频繁调整：一连串不同尺寸，最后落在两个极端。
    for (const width of [1280, 1100, 900, 760, 1024, 640, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(120);
    }

    // ---- 必须断言：没有新模型调用 ----
    expect(api.generate(), '布局变化不得触发模型调用').toEqual([]);
    const added = api.all();
    expect(
      added.filter((entry) => !/^GET /u.test(entry)),
      `调整尺寸不应发出任何非读取请求，实际 ${JSON.stringify(added)}`,
    ).toEqual([]);

    // ---- 必须断言：不无条件重编译源数据（渲染次数不变，SVG 内容不变）----
    expect(
      await canvas.getAttribute('data-attempts'),
      '尺寸变化不得重新渲染/重编译',
    ).toBe(attemptsBefore);
    expect(await page.getByTestId('flow-svg').innerHTML(), 'SVG 内容不应因尺寸变化而变').toBe(
      svgBefore,
    );

    // ---- 必须断言：视图保持可读（容器确实被重新测量过）----
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect
      .poll(async () => canvas.getAttribute('data-size'), { timeout: 10_000 })
      .not.toBe(sizeBefore);
    expect(await drawnText(page), '调整之后图仍然可读').toContain('尺寸图第一个节点');
    await expect(canvas, '画布仍然可见').toBeVisible();
  });
});

test.describe('T066-C05 文本降级', () => {
  test('Mermaid 不可用时：节点、边与来源列表仍然可读', async ({ page }) => {
    await gotoInbox(page);
    // 原文的一个**独有**关键词，用来在资料库里认出刚采集的那一条。
    const keyword = uniqueText('T066C05原文');
    const itemId = await seedItemViaApi(page, { rawText: `${keyword} 的完整原文内容` });
    const viewId = seedFlow(itemId, {
      name: uniqueText('降级图'),
      nodeLabels: ['降级图的第一个节点', '降级图的第二个节点'],
    });

    /*
     * Same sequencing constraint as T066-C03: the seam must be installed *before*
     * the page's first render, because the page adopts the newest saved flow on
     * mount and an unchanged source is not re-rendered (T066-R04).
     */
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__feiniForceFlowRenderFailure = true;
    });

    await openFlowPage(page);
    await page.getByTestId('flow-view-select').selectOption(viewId);

    // ---- 必须断言：仍可读节点边与来源列表 ----
    // `flow-fallback` 常驻（T066-R05），所以不把「它可见」当证据；失败态的证据是
    // `data-phase="failed"` 与下面的节点/边清单内容。
    await expect(page.getByTestId('flow-canvas')).toHaveAttribute('data-phase', 'failed');
    await expect(page.getByTestId('flow-fallback-nodes-count')).toContainText('节点（2）');
    await expect(page.getByTestId('flow-fallback-edges-count')).toContainText('连接（1）');
    expect((await fallbackLabels(page)).join('|')).toContain('降级图的第一个节点');
    expect((await fallbackLabels(page)).join('|')).toContain('降级图的第二个节点');
    // 边必须写明类型词，而不是一条无言的箭头。
    await expect(page.getByTestId('flow-fallback-edge')).toContainText('顺序：然后第 2 步');

    // 来源列表由旁边的面板从视图自己的快照读出，不依赖 Mermaid。
    const sourceRows = page.getByTestId('flow-source-panel').getByTestId('source-list-item');
    await expect(sourceRows.first()).toHaveAttribute('data-item-id', itemId);
    await expect(page.getByTestId('flow-source-panel')).toContainText('来源材料');

    // 编译出来的源码也是可读的替代（图上画不出来，文字还在）。
    await page.getByTestId('flow-toggle-source').click();
    await expect(page.getByTestId('flow-source')).toContainText('flowchart LR');
    await expect(page.getByTestId('flow-source')).toContainText('降级图的第一个节点');

    // ---- 必须排除：可视化故障不能让知识不可访问 ----
    // 原文本身仍要在资料库里检索得到（T066-R06 / T069-C04 的 Requirement 侧）。
    // 走资料库自己的检索框，与其它 spec 的观察方式一致：它证明的是用户路径，
    // 而不是「某个元素在 DOM 里」。
    await page.goto('/library');
    await page.getByTestId('library-search').fill(keyword);
    await expect(page.getByTestId('knowledge-card').filter({ hasText: keyword })).toBeVisible();
  });
});

test.describe('T066-C06 并行实例', () => {
  test('快速连续切换多个保存的流程：配置与 SVG 不串图', async ({ page }) => {
    await gotoInbox(page);
    const itemId = await seedItemViaApi(page, { rawText: uniqueText('T066C06来源') });

    // 三张结构相同、标签各异的图，方便判断「画的是哪一张」。
    const a = seedFlow(itemId, { name: uniqueText('并行甲'), nodeLabels: ['并行甲独有'] });
    const b = seedFlow(itemId, { name: uniqueText('并行乙'), nodeLabels: ['并行乙独有'] });
    const c = seedFlow(itemId, { name: uniqueText('并行丙'), nodeLabels: ['并行丙独有'] });

    const api = trackApi(page);
    await openFlowPage(page);
    const select = page.getByTestId('flow-view-select');
    for (const id of [a, b, c]) {
      await expect(select.locator(`option[value="${id}"]`)).toHaveCount(1);
    }

    // 不等任何一次渲染完成就连续切换三次，让三次渲染重叠。
    await select.selectOption(a);
    await select.selectOption(b);
    await select.selectOption(c);

    // ---- 必须断言：最终结果只属于最后一次选择 ----
    expect(await drawnText(page), '最终必须画的是最后选的那张').toContain('并行丙独有');
    const finalSvg = await page.getByTestId('flow-svg').innerHTML();
    expect(finalSvg, '画面里不得有前两张的标签').not.toContain('并行甲独有');
    expect(finalSvg, '画面里不得有前两张的标签').not.toContain('并行乙独有');
    expect((await fallbackLabels(page)).join('|'), '文本替代也应是最后一张').toContain('并行丙独有');

    // ---- 必须断言：配置与 SVG 不串图 ----
    // 串图在 DOM 上的表现是「同一份 SVG 里出现两次根节点 / 两套 marker 引用」，或者
    // marker 引用指向另一张图的根 id。
    const dom = await page.getByTestId('flow-svg').evaluate((host) => {
      const roots = host.querySelectorAll('svg');
      const rootId = roots[0]?.getAttribute('id') ?? '';
      const markers = [...host.querySelectorAll('[marker-end], [marker-start]')].map(
        (node) => `${node.getAttribute('marker-end') ?? ''}${node.getAttribute('marker-start') ?? ''}`,
      );
      const ids = [...host.querySelectorAll('[id]')].map((node) => node.getAttribute('id') ?? '');
      return {
        rootCount: roots.length,
        rootId,
        markers,
        duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
      };
    });
    expect(dom.rootCount, '画布上只应有一张图').toBe(1);
    expect(dom.rootId, '图应有自己的根 id').not.toBe('');
    expect(dom.duplicateIds, `同一张图里不应出现重复 DOM id：${JSON.stringify(dom.duplicateIds)}`).toEqual(
      [],
    );
    for (const marker of dom.markers) {
      expect(marker, `箭头引用应指向本图：${marker}`).toContain(dom.rootId);
    }

    // 整个切换过程只允许读取，不允许任何生成请求。
    expect(api.generate(), '切换已保存的图不应产生生成请求').toEqual([]);
    expect(
      api.all().filter((entry) => entry.startsWith('GET ')),
      '切换应全部是读取',
    ).toEqual(api.all());
  });
});
