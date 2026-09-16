import { expect, gotoInbox, test } from './support/fixtures';
import { seedItemViaApi, uniqueText } from './support/harness';
import { seedView, withSeedDb } from './support/seedData';

/**
 * T057 验收｜Markmap 挂载、净化与本地资源
 *
 * The G4 renderer's own spec. It runs a real browser against the real page,
 * because every rule here is about what a browser does with a third-party
 * renderer and none of them can be observed from a unit test:
 *
 *  1. **T057-C01/C02 are about the DOM, not about calls.** "A mountable SVG
 *     appeared" and "a repeat mount left nothing behind" are counted on the real
 *     element tree — `document.querySelectorAll('svg.markmap')` and the presence
 *     of the library's own `<style>` and node groups. Asserting that a React
 *     effect ran would pass while two SVGs sat on top of each other.
 *
 *  2. **T057-C03 is about the network.** The suite's traffic observer records
 *     every request and aborts anything off loopback, so "no external resource"
 *     is a list that stayed empty rather than an assumption. The case seeds a
 *     label that *tries* to embed a remote image, so the assertion is made
 *     against content that is actively hostile rather than merely benign.
 *
 *  3. **T057-C04/C05 are about the zoom transform.** Both cases read
 *     `transform` off the library's own `<g>` after a real `d3-zoom` scale, which
 *     is the only place the viewport lives (`handleZoom` is its sole writer). A
 *     remount or a container resize that reset the viewport would change this
 *     string, and nothing else would.
 *
 *  4. **T057-C06 is about degradation, not failure.** The malformed row is seeded
 *     directly into the suite's throwaway database (T011-C03 forbids a shipped
 *     test endpoint), and the case asserts the *recovery* path: a readable error,
 *     the outline still populated, and sources still reachable. It also asserts
 *     the whole route did not blank, which is the failure mode a render-phase
 *     throw produces.
 *
 * Baseline: each case pins its read to one saved view whose selection is an
 * explicit id list, so a shared accumulated database cannot change the numbers a
 * case asserts (docs/05_tests/G4 公共测试装置).
 */

interface MindmapContentLike {
  title: string;
  nodes: { id: string; parentId: string | null; label: string; itemIds: string[]; kind: string }[];
}

/**
 * A small, valid tree over the given item ids.
 *
 * Built here rather than in a shared fixture because each case wants a different
 * label set: one embeds a remote image, one is plain, and the malformed case
 * deliberately is not a tree at all. A shared "sample tree" would have to grow
 * options until it was a second schema.
 */
function treeFor(labels: { root: string; children: string[] }, itemIds: string[]): MindmapContentLike {
  return {
    title: labels.root,
    nodes: [
      {
        id: 'm1',
        parentId: null,
        label: labels.root,
        itemIds: [...itemIds],
        kind: 'group',
      },
      ...labels.children.map((label, index) => ({
        id: `m${index + 2}`,
        parentId: 'm1',
        label,
        // Every leaf must resolve to a real source: the read path does not
        // re-validate, but a node with no sources would make the source panel look
        // broken for a reason unrelated to what the case is testing.
        itemIds: [itemIds[index % itemIds.length]!],
        kind: 'note',
      })),
    ],
  };
}

/**
 * Seed a mindmap view straight into the suite's own database.
 *
 * This is the only honest path for content the UI cannot produce: a mindmap is
 * written by the generation route, which needs a live model (T011-C03 rules out a
 * test-mode endpoint that would fabricate one). The database written to is
 * `tests/e2e/.data` and `seedView` refuses any other directory.
 */
function seedMindmapView(name: string, itemIds: string[], content: unknown): string {
  return withSeedDb((db) => seedView(db, { name, kind: 'mindmap', itemIds, content }));
}

/** Open `/mindmap` with one view selected, so the read is a known id list. */
async function openMindmap(
  page: import('@playwright/test').Page,
  viewId: string,
): Promise<void> {
  await page.goto('/mindmap');
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await page.getByTestId('mindmap-view-select').selectOption(viewId);
}

/** Wait until the renderer actually drew the map, and return the canvas state. */
async function waitForMount(page: import('@playwright/test').Page): Promise<void> {
  // The library's own node groups are the signal that `setData` finished, and this
  // is deliberately the *only* thing waited on. The canvas container is visible from
  // the first render, so its visibility proves nothing; and an earlier helper also
  // waited on it and then on the groups, which read as "the map is ready" while the
  // container had merely been laid out. Node groups cannot be faked that way: they
  // exist only once the tree has been drawn (T057-R05).
  await expect(page.getByTestId('mindmap-svg').locator('g.markmap-node').first()).toBeVisible({
    timeout: 30_000,
  });
  // Visible is not the same as laid out: a node group whose ancestors carry a
  // `scale(NaN)` transform is present in the DOM and reports a zero-area box. Every
  // case here depends on a fitted map, so that is asserted rather than assumed.
  await expect
    .poll(async () => page.getByTestId('mindmap-svg').evaluate((svg) => svg.querySelector('g')?.getAttribute('transform') ?? ''), {
      timeout: 30_000,
    })
    .toMatch(/^translate\(-?[\d.]+,-?[\d.]+\) scale\([\d.]+\)$/u);
}

/** The library's zoom transform, the single place the viewport is stored. */
async function zoomTransform(page: import('@playwright/test').Page): Promise<string> {
  return page
    .getByTestId('mindmap-svg')
    .evaluate((svg) => svg.querySelector('g')?.getAttribute('transform') ?? '');
}

/** Zoom the map with a real trackpad/wheel gesture over the canvas. */
async function zoomIn(
  page: import('@playwright/test').Page,
  { dx = 0, dy = 0, steps = 6 } = {},
): Promise<void> {
  const canvas = page.getByTestId('mindmap-svg');
  // A wheel gesture lands at a *viewport* coordinate, so the canvas must be on
  // screen first — the same thing a user does before zooming. A tall canvas can
  // have its centroid below the fold (there is a header, a scope row and the
  // generate section above it), and Playwright would then deliver the wheel events
  // to whatever is at that point: the gesture would do nothing and a working
  // renderer would look frozen.
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  expect(box, '脑图画布应有可缩放区域').toBeTruthy();
  const centerX = box!.x + box!.width / 2 + dx;
  const centerY = box!.y + box!.height / 2 + dy;
  const viewport = page.viewportSize();
  if (viewport) {
    expect(
      centerY > 0 && centerY < viewport.height && centerX > 0 && centerX < viewport.width,
      `缩放手势的落点必须在视口内（点 ${centerX},${centerY}，视口 ${viewport.width}x${viewport.height}）`,
    ).toBe(true);
  }
  await page.mouse.move(centerX, centerY);
  // d3-zoom scales on wheel with `ctrlKey` held (or on a pinch gesture, which
  // Playwright cannot synthesise), so the modifier is what makes this a zoom
  // rather than a pan.
  await page.keyboard.down('Control');
  for (let index = 0; index < steps; index += 1) {
    await page.mouse.wheel(0, -120);
  }
  await page.keyboard.up('Control');
  await page.waitForTimeout(300);
}

test.describe('T057 Markmap 挂载、净化与本地资源', () => {
  test('T057-C01 首次显示：出现可缩放折叠的 SVG 与正确中文', async ({ page }) => {
    await gotoInbox(page);
    const first = await seedItemViaApi(page, { rawText: uniqueText('脑图首次显示-甲') });
    const second = await seedItemViaApi(page, { rawText: uniqueText('脑图首次显示-乙') });

    const viewId = seedMindmapView(
      uniqueText('首次显示脑图'),
      [first, second],
      treeFor({ root: '需求与自动化', children: ['问题定义', '自动化前提'] }, [first, second]),
    );

    await openMindmap(page, viewId);
    await waitForMount(page);

    const svg = page.getByTestId('mindmap-svg');
    // The library marks its own SVG, which is how a case distinguishes "our empty
    // container" from "a markmap instance drew here".
    await expect(svg).toHaveClass(/markmap/u);
    // The labels are the AST's own text, rendered as text — not as escaped
    // Markdown. This is the "correct Chinese" assertion: the compiler escapes the
    // labels for Markmap, and a bug there would show backslashes on screen.
    await expect(svg).toContainText('需求与自动化');
    await expect(svg).toContainText('问题定义');
    await expect(svg).toContainText('自动化前提');
    await expect(svg.locator('g.markmap-node')).toHaveCount(3);
    // Foldable: a branch with children gets the library's own toggle circle.
    await expect(svg.locator('circle').first()).toBeVisible();
    // Zoomable: d3-zoom is bound to the SVG, which is what T057-C04 then relies on.
    expect(await zoomTransform(page)).not.toBe('');

    // "A source text exists" is explicitly not enough (T057-C01「必须排除」): the
    // outline and the canvas must both be populated from the same AST.
    await expect(page.getByTestId('mindmap-outline-node')).toHaveCount(3);
  });

  test('T057-C02 重复挂载：多次切换页面后没有重复 SVG 或残留实例', async ({ page }) => {
    await gotoInbox(page);
    const item = await seedItemViaApi(page, { rawText: uniqueText('重复挂载') });
    const viewId = seedMindmapView(
      uniqueText('重复挂载脑图'),
      [item],
      treeFor({ root: '重复挂载根', children: ['唯一子节点'] }, [item]),
    );

    await openMindmap(page, viewId);
    await waitForMount(page);

    // Leave and come back four times. React development mode also mounts, cleans
    // up and mounts again, so this exercises both the route-level remount and the
    // Strict Mode double-invoke. A missing `destroy()` shows up here as a second
    // SVG, a second `<style>`, or a doubling node count.
    for (let round = 0; round < 4; round += 1) {
      await page.goto('/inbox');
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
      await openMindmap(page, viewId);
      await waitForMount(page);
    }

    const counts = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="mindmap-canvas"]');
      return {
        svgs: canvas?.querySelectorAll('svg').length ?? -1,
        markedSvgs: document.querySelectorAll('svg.markmap').length,
        styles: canvas?.querySelectorAll('style').length ?? -1,
        nodes: canvas?.querySelectorAll('g.markmap-node').length ?? -1,
      };
    });

    // Exactly one instance's worth of DOM, and the DOM is scoped to our canvas:
    // a leaked instance from a previous page would leave a second `svg.markmap`
    // somewhere in the document.
    expect(counts.svgs).toBe(1);
    expect(counts.markedSvgs).toBe(1);
    expect(counts.styles).toBe(1);
    expect(counts.nodes).toBe(2);
  });

  test('T057-C03 外部资源：标签试图嵌入远端图片也不发出任何外部请求', async ({ page, traffic }) => {
    await gotoInbox(page);
    const item = await seedItemViaApi(page, { rawText: uniqueText('外部资源') });
    const hostile = '![偷图](http://evil.example/tracker.png) 与 <img src="http://evil.example/x.png">';
    const viewId = seedMindmapView(
      uniqueText('外部资源脑图'),
      [item],
      treeFor({ root: '外部资源根', children: [hostile] }, [item]),
    );

    // Reset *after* the seed and before the render, so the recorded list is about
    // rendering rather than about setup.
    traffic.reset();

    await openMindmap(page, viewId);
    await waitForMount(page);

    const svg = page.getByTestId('mindmap-svg');
    // The label is present as literal text...
    await expect(svg).toContainText('偷图');
    // ...and produced no image element at all. `img` is the observable proof that
    // the escaping held: escaped Markdown renders as text, not as markup.
    expect(await svg.locator('img').count()).toBe(0);

    // The offline claim (T057-C03「已保存视图应离线可读」): not one request left
    // loopback while the map was built and drawn.
    const external = traffic.externalRequests();
    expect(
      external.map((entry) => entry.url),
      '渲染已保存脑图不应产生任何外部请求',
    ).toEqual([]);
    expect(traffic.blockedRequests()).toEqual([]);

    // And the page is still a working page afterwards, not a half-rendered one.
    await expect(page.getByTestId('mindmap-outline-node')).toHaveCount(2);
  });

  test('T057-C04 缩放保持：编辑旁侧字段不会重置视口', async ({ page }) => {
    await gotoInbox(page);
    const first = await seedItemViaApi(page, { rawText: uniqueText('缩放保持-甲') });
    const second = await seedItemViaApi(page, { rawText: uniqueText('缩放保持-乙') });
    const viewId = seedMindmapView(
      uniqueText('缩放保持脑图'),
      [first, second],
      treeFor({ root: '缩放根', children: ['子甲', '子乙'] }, [first, second]),
    );

    await openMindmap(page, viewId);
    await waitForMount(page);

    await zoomIn(page);
    const zoomed = await zoomTransform(page);
    // A real scale happened: without this the case would pass on a renderer that
    // ignored the wheel entirely.
    expect(zoomed, '滚轮缩放后 transform 应发生变化').not.toBe('');
    const scaleOf = (transform: string): number => {
      const match = /scale\(([\d.]+)\)/u.exec(transform);
      expect(match, `transform 应包含 scale()：${transform}`).toBeTruthy();
      return Number(match![1]);
    };
    const zoomedScale = scaleOf(zoomed);
    expect(zoomedScale).toBeGreaterThan(1);

    // "Edit an unrelated field": the expand-level control and node selection both
    // re-render the page around the canvas. Selecting a node is the sharpest form
    // of this — it is the interaction most likely to be implemented by remounting.
    await page.getByTestId('mindmap-outline-select').first().click();
    await expect(page.getByTestId('mindmap-outline-select').first()).toHaveAttribute(
      'aria-current',
      'true',
    );

    // The viewport is untouched: same transform, same scale. `fit` is one-per-mount
    // precisely so this holds (T057-R05).
    expect(await zoomTransform(page)).toBe(zoomed);
    expect(scaleOf(await zoomTransform(page))).toBe(zoomedScale);

    // The explicit "适应窗口" button is the *only* thing allowed to reset it, and
    // it must actually work when asked.
    await page.getByTestId('mindmap-fit').click();
    await expect
      .poll(async () => scaleOf(await zoomTransform(page)), { timeout: 15_000 })
      .not.toBe(zoomedScale);
  });

  test('T057-C05 容器变化：侧栏改变宽度后脑图仍可见且不抖动', async ({ page }) => {
    await gotoInbox(page);
    const first = await seedItemViaApi(page, { rawText: uniqueText('容器变化-甲') });
    const second = await seedItemViaApi(page, { rawText: uniqueText('容器变化-乙') });
    const viewId = seedMindmapView(
      uniqueText('容器变化脑图'),
      [first, second],
      treeFor({ root: '容器根', children: ['子一', '子二'] }, [first, second]),
    );

    await openMindmap(page, viewId);
    await waitForMount(page);
    await zoomIn(page);
    const beforeResize = await zoomTransform(page);

    // The gesture must have actually zoomed, otherwise this case compares a no-op
    // transform with itself and passes without exercising anything. That is not
    // hypothetical: while the generate section was added above the canvas the
    // centroid fell below the fold, the wheel events landed outside the viewport,
    // and every assertion below still held.
    const scaleBeforeResize = Number(/scale\(([\d.]+)\)/u.exec(beforeResize)?.[1] ?? Number.NaN);
    expect(scaleBeforeResize, '缩放后应有真实 scale').toBeGreaterThan(1);

    const canvas = page.getByTestId('mindmap-canvas');
    const widthBefore = (await canvas.boundingBox())!.width;

    // Drive a genuine container width change the way the layout does, by resizing
    // the viewport. The library's own `ResizeObserver` reacts to this, which is the
    // chain T057-C05「Resize触发链可能造成抖动」is about.
    //
    // The viewport is made *wider* rather than narrower because at the desktop
    // breakpoint this app's sidebar is a fixed 13rem, and shrinking the window
    // below `md` folds that sidebar into a top bar and stacks the canvas above the
    // outline — a layout change, not a container resize, and it would leave the
    // canvas 704px wide instead of narrower. Widening keeps the sidebar beside the
    // content, so the canvas purely gets more room, which is the resize this case
    // means to exercise.
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: viewport.width + 320, height: viewport.height });
    await page.waitForTimeout(600);

    const widthAfter = (await canvas.boundingBox())!.width;
    expect(widthAfter, '容器宽度应确实发生了变化').toBeGreaterThan(widthBefore);

    // Still drawn, still in one piece: a resize that tore the map down would leave
    // no node groups.
    await expect(page.getByTestId('mindmap-svg').locator('g.markmap-node')).toHaveCount(3);
    await expect(canvas).toBeVisible();
    // A re-layout does not touch the zoom transform — `handleZoom` is its only
    // writer, and the observer calls `renderData`. So the viewport survives, and
    // no fit/observer feedback loop moved it.
    expect(await zoomTransform(page)).toBe(beforeResize);

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(600);
    await expect(page.getByTestId('mindmap-svg').locator('g.markmap-node')).toHaveCount(3);
    expect(await zoomTransform(page)).toBe(beforeResize);
  });

  test('T057-C06 渲染失败：结构异常时给出可读错误，大纲与来源仍可用', async ({ page }) => {
    await gotoInbox(page);
    const first = await seedItemViaApi(page, { rawText: uniqueText('渲染失败-甲') });
    const second = await seedItemViaApi(page, { rawText: uniqueText('渲染失败-乙') });

    // A tree with a duplicated node id. This is the shape the read path passes
    // through unchanged (`assembleView` casts the stored JSON) and the shape a
    // recursive renderer must never be handed. Structural, not merely ugly: the
    // same id appearing twice makes "the children of this node" undefined.
    const malformed = {
      title: '结构异常脑图',
      nodes: [
        { id: 'm1', parentId: null, label: '异常根', itemIds: [first], kind: 'group' },
        { id: 'm2', parentId: 'm1', label: '重复节点甲', itemIds: [first], kind: 'note' },
        { id: 'm2', parentId: 'm1', label: '重复节点乙', itemIds: [second], kind: 'note' },
      ],
    };
    const viewId = seedMindmapView(uniqueText('结构异常脑图'), [first, second], malformed);

    await openMindmap(page, viewId);

    // The page must not blank. This is the assertion that fails when the failure
    // is a render-phase exception: the whole route disappears instead of showing
    // the error.
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();

    // A readable error, in our own words, and specifically not a raw library
    // exception. `脑图无法渲染：` is the prefix T057-C06's "可读错误" requires.
    const error = page
      .getByRole('alert')
      .filter({ hasText: '脑图无法渲染' })
      .filter({ hasText: '重复' });
    await expect(error).toBeVisible({ timeout: 30_000 });
    // It names the reason in user terms rather than "undefined is not a function".
    await expect(error).toContainText('脑图无法渲染');
    await expect(error).toContainText('节点 id 重复');

    // The canvas is not left showing a broken half-drawn map.
    await expect(page.getByTestId('mindmap-canvas')).toBeHidden();

    // The outline is the safe fallback (T057-C06「显示安全大纲」): still rendered,
    // still readable, and it says the structure was incomplete rather than
    // silently showing a plausible-looking flat list.
    await expect(page.getByTestId('mindmap-outline')).toBeVisible();
    await expect(page.getByTestId('mindmap-outline-malformed')).toBeVisible();
    // Every stored row is listed, including both rows that share the duplicated id.
    // The flat fallback is required to lose nothing: a walk that deduplicates by id
    // would render three stored nodes as two rows and quietly drop one.
    await expect(page.getByTestId('mindmap-outline-node')).toHaveCount(3);
    for (const label of ['异常根', '重复节点甲', '重复节点乙']) {
      await expect(page.getByTestId('mindmap-outline-node').filter({ hasText: label })).toHaveCount(
        1,
      );
    }

    // And sources are still reachable from it — a picture that failed must not
    // take the evidence with it (T057-C06「必须排除」).
    await page.getByTestId('mindmap-outline-select').nth(1).click();
    await expect(page.getByTestId('source-list')).toBeVisible();
    await expect(page.getByTestId('source-list-item').first()).toBeVisible();
  });
});
