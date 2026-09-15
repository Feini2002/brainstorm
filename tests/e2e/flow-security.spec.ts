/**
 * T065 验收｜SVG 净化**页面层**：来源回跳与导出。
 *
 * 用例规格：`docs/05_tests/G5/T065_cases.md`；任务原文：
 * `docs/04_tasks/G5/T065_mermaid_renderer.md`。
 *
 * ## 文件名与契约里那个名字不同，这是有意的
 *
 * `docs/04_tasks/G5/T065_mermaid_renderer.md` 的允许修改表把验收入口写成
 * `tests/e2e/mermaid-security.spec.ts`。本仓库实际用的是
 * `tests/e2e/flow-security.spec.ts`：`flow-*` 是本 Gate 其余 spec 与 helper 的统一前缀
 * （`flow-intent`、`flow-lifecycle`、`tests/e2e/support/goflow.ts`），而
 * `tests/browser/flow-render-security.test.ts` 承担了 C01…C04。按前缀命名能让「哪些
 * 文件属于 T065」一眼可见，代价只是与规格里的一行字面不一致——在这里写明，而不是
 * 让读者以为规格里那条被漏掉了。
 *
 * ## 这个 spec 只放「必须有真实页面」的两条
 *
 * T065-C01…C04（恶意标签、配置注入、多图实例、错误清理）断言的是
 * `sanitizeSvgString` 与 `renderFlowSvg` 这两个**函数**的行为，它们在本仓库的
 * Node 环境里跑不起来（`dompurify` 无 DOM 时 `isSupported === false`、没有
 * `sanitize`；Mermaid 本身也是浏览器库），但也不需要整个应用。那四条放在
 * `tests/browser/flow-render-security.test.ts`：那里用 esbuild 把这两个生产函数
 * 打进真实 Chromium，因此是真实执行的，且不依赖 `next start` 与 `.next` 的新鲜度。
 *
 * 留在这里的两条必须走真实页面：
 *
 *  - **T065-C05**：来源面板是用**真实 Item ID** 回跳，而不是 SVG 里的任意链接。
 *    「面板里那一条是不是库里那条」只有当两侧都真的存在时才有意义。
 *  - **T065-C06**：导出的文件是**画面上那张净化后的图**。这条要看真实下载字节，
 *    并且要证明画面与文件同源（两次渲染之间不允许漂移）。
 */
import { readFileSync } from 'node:fs';

import { expect, gotoInbox, test } from './support/fixtures';
import { seedItemViaApi, uniqueText } from './support/harness';
import { seedView, withSeedDb } from './support/seedData';

/** 一张结构合法、标签里带注入片段的流程图。 */
function seedHostileFlow(itemId: string, name: string): string {
  return withSeedDb((db) =>
    seedView(db, {
      name,
      kind: 'flow',
      itemIds: [itemId],
      content: {
        title: '注入样本',
        direction: 'LR',
        nodes: [
          { id: 'n1', label: '<img src=x onerror=alert(1)> 与 <script>alert(2)</script>', itemIds: [itemId] },
          { id: 'n2', label: '第二个节点（括号）[方括号]', itemIds: [itemId] },
        ],
        edges: [
          {
            source: 'n1',
            target: 'n2',
            kind: 'hypothesis',
            label: '也许有先后',
            itemIds: [itemId],
            relationIds: [],
          },
        ],
      },
    }),
  );
}

/** 打开 `/flow` 并选中一张已保存的图，等它真的画出来。 */
async function openFlow(
  page: import('@playwright/test').Page,
  viewId: string,
): Promise<void> {
  await page.goto('/flow');
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  const select = page.getByTestId('flow-view-select');
  await expect(select.locator(`option[value="${viewId}"]`)).toHaveCount(1);
  await select.selectOption(viewId);
  await expect(page.getByTestId('flow-renderer')).toBeVisible();
  await expect(page.getByTestId('flow-svg')).toBeVisible();
}

test.describe('T065-C05 来源点击', () => {
  test('来源面板用真实 Item ID，且画面里没有可导航的 <a>/href', async ({ page }) => {
    await gotoInbox(page);
    const itemId = await seedItemViaApi(page, { rawText: uniqueText('T065C05来源') });
    const viewId = seedHostileFlow(itemId, uniqueText('T065C05图'));

    await openFlow(page, viewId);

    // 「必须断言：使用真实 Item ID」——面板里那一条必须是库里这一条。
    //
    // 不写 `await expect(sourceRows.first()).toBeVisible()`：那样的断言对「面板指向
    // 了另一张图」是盲的，只证明有东西在屏幕上。真正的判据是这条行所带的
    // `data-item-id` 与刚采集的那条相等，以及节点目录属于当前这张图。
    const sourceRows = page.getByTestId('flow-source-panel').getByTestId('source-list-item');
    await expect(sourceRows).toHaveCount(1);
    await expect(sourceRows.first()).toHaveAttribute('data-item-id', itemId);
    await expect(page.getByTestId('flow-source-node')).toHaveValue('n1');

    // 「必须排除：来源交互不必扩大Mermaid可执行能力」——图本身不带导航能力。
    const svgHost = page.getByTestId('flow-svg');
    expect(await svgHost.locator('a').count(), 'SVG 里不应有 <a> 元素').toBe(0);
    expect(await svgHost.locator('[href]').count(), 'SVG 里不应有 href 属性').toBe(0);
    expect(await svgHost.locator('foreignObject').count(), 'SVG 里不应有 foreignObject').toBe(0);
    expect(await svgHost.locator('script').count(), 'SVG 里不应有 script').toBe(0);
    // 事件处理器：逐个元素看属性名，而不是只看 innerHTML 里有没有 "on"。
    const handlerCount = await svgHost.evaluate((host) =>
      [...host.querySelectorAll('*')].filter((element) =>
        [...element.attributes].some((attribute) => /^on/iu.test(attribute.name)),
      ).length,
    );
    expect(handlerCount, 'SVG 里不应有 on* 事件属性').toBe(0);

    // 点击节点行走的是真实记录：打开后才可能读到原文。
    await page.getByTestId('flow-fallback-node').first().getByTestId('flow-fallback-node-select').click();
    await expect(sourceRows.first()).toHaveAttribute('data-item-id', itemId);
  });
});

test.describe('T065-C06 净化后导出', () => {
  test('导出的 SVG 与画面同源，且字节里没有可执行标记', async ({ page }) => {
    await gotoInbox(page);
    const itemId = await seedItemViaApi(page, { rawText: uniqueText('T065C06导出') });
    const viewId = seedHostileFlow(itemId, uniqueText('T065C06图'));

    await openFlow(page, viewId);

    // 渲染成功之后入口才存在（T068-C05：不留假入口）。
    const svgButton = page.getByTestId('export-flow-svg');
    await expect(svgButton).toBeVisible();
    await expect(page.getByTestId('export-flow-hint-svg')).toContainText('经过净化');

    const downloadPromise = page.waitForEvent('download');
    await svgButton.click();
    const download = await downloadPromise;
    const file = await download.path();
    expect(file, '应真的产生一个下载文件').toBeTruthy();
    const bytes = readFileSync(file!, 'utf8');

    // 「必须断言：同样没有可执行标记」——断言的是下载**字节**，不是 DOM。
    expect(bytes, '导出文件应是 SVG').toContain('<svg');
    expect(bytes, '导出文件不应含 script').not.toMatch(/<\s*script\b/iu);
    expect(bytes, '导出文件不应含 foreignObject').not.toMatch(/<\s*foreignobject\b/iu);
    expect(bytes, '导出文件不应含 on* 处理器').not.toMatch(/\son[a-z]+\s*=/iu);
    expect(bytes, '导出文件不应含 javascript:').not.toMatch(/javascript\s*:/iu);
    expect(bytes, '导出文件不应含外部引用').not.toMatch(
      /(?:href|src)\s*=\s*["']?\s*(?:https?:)?\/\//iu,
    );
    expect(bytes, '导出文件不应含 @import').not.toMatch(/@import/iu);

    // 与画面同源：DOM 里的那张图也必须是净化过的，且文字仍然可读。
    const svgHost = page.getByTestId('flow-svg');
    const domHtml = await svgHost.innerHTML();
    expect(domHtml, '画面里不应含 script').not.toMatch(/<\s*script\b/iu);
    expect(domHtml, '画面里不应含 on* 处理器').not.toMatch(/\son[a-z]+\s*=/iu);
    expect(await svgHost.textContent(), '注入片段应是文字，不能被整段删掉').toBeTruthy();

    // 文件名来自 viewId 与安全日期，不是未清洗的 title。
    expect(download.suggestedFilename()).not.toMatch(/[\\/]/u);
  });
});
