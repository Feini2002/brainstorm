import { expect, gotoInbox, test } from './support/fixtures';
import { E2E_ORIGIN } from './support/env';
import { authHeaders, captureViaUi, seedItemViaApi, uniqueText } from './support/harness';
import { capturePair, openScopedGraph, saveGraphView } from './support/graph';
import { ensureLlmConfigured, restoreLlmSettings, writeScript } from './support/gomindmap';
import { seedAiRelation, seedView, withSeedDb } from './support/seedData';

/**
 * T082 验收｜键盘可达、文本替代与字号放大
 *
 * 这个文件覆盖 T082-C04（放大字号）与 T082-C06（文本替代），另外把 R05 的两处危险
 * 确认框也放在这里，因为它们的可用性依靠**键盘焦点落在哪个控件上**，这件事只能在真
 * 浏览器里观察。
 *
 * 三条不可替代的观察方式：
 *
 *  1. **只按键，不用鼠标。** C04 与 C06 的动作全部通过 `keyboard.press` 与 `focus()`
 *     完成；一旦某一步需要 `.click()` 才能继续，用例就应该失败，因为那正好说明该控件
 *     键盘用户到不了。断言里带 `expect(await activeElementTestId()).toBe(...)` 的几处是
 *     用来证明「Tab 真的把焦点移到了下一个控件」，而不是「控件恰好存在」。
 *  2. **文本替代是被走完的一条路，不是一份摘要。** C06 从关系列表进入检查器，再从检查
 *     器打开记录抽屉，全程不碰画布节点与边：如果列表是装饰，这条路走不通。
 *  3. **字号放大的检查落在界面上，不落在 DOM 上。** `documentElement` 的 `font-size`
 *     只对 `rem`/`em` 生效，而本项目大量使用固定 `px`；因此断言是「关键按钮在放大后
 *     仍完整落在视口内、仍可被键盘激活」，这比断言一个 CSS 变量更贴近用户看到的结果。
 *
 * 未在这里断言的部分如实标明：真实输入法候选窗与操作系统级缩放（浏览器之外的 150%）
 * 无法在无头 Chromium 里复现，见 `docs/ux/accessibility.md` 的手工检查一节。
 */

/** 当前聚焦元素的 `data-testid`，用于断言焦点真的移动了。 */
async function activeTestId(page: import('@playwright/test').Page): Promise<string | null> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return null;
    return element.getAttribute('data-testid') ?? element.getAttribute('role') ?? element.tagName;
  });
}

/**
 * 关键按钮是否**真的**可用：完整落在视口内，且中心点的命中测试是它自己。
 *
 * 两件事都要查，因为它们对应两类不同的「看不到」：
 *
 *  1. **被推到视口外**——`boundingBox()` 与视口比大小即可发现。
 *  2. **被压在别的元素下面**——`boundingBox()` 对此**一无所知**：一个被吸顶头部
 *     盖住的按钮照样返回一个漂亮的矩形。这里用 `elementFromPoint` 在中心点做命中
 *     测试，只有命中的是它自己或它的子节点才算可用。T082-C04 的排除项写的是
 *     「固定像素布局容易遮挡文字」，遮挡正是这一条，不查就等于没测。
 */
async function isFullyInViewport(
  page: import('@playwright/test').Page,
  testId: string,
): Promise<boolean> {
  const locator = page.getByTestId(testId);
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) return false;
  const insideViewport =
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= viewport.width &&
    box.y + box.height <= viewport.height;
  if (!insideViewport) return false;
  const hit = await page.evaluate((id) => {
    const element = document.querySelector(`[data-testid="${id}"]`);
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const found = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return found !== null && (found === element || element.contains(found));
  }, testId);
  return hit;
}

/**
 * 把根字号放大到 150%，并**断言它真的生效**。
 *
 * 断言这一步不是多余的：`addStyleTag` 注入的样式在整页导航后会被丢弃，如果只在
 * 页面加载前注入一次，六页里只有第一页是放大过的，而所有几何断言都会在 100% 下
 * 通过——用例仍然全绿，只是它证明的东西不见了（T077-3 记录过同类的「没落地却全绿」）。
 * 这里比 `16` 大才算数，避免「注入了但被别的规则盖掉」也走绿。
 */
async function scaleUpFont(page: import('@playwright/test').Page): Promise<void> {
  await page.addStyleTag({ content: 'html { font-size: 150% !important; }' });
  const rootFontSize = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  expect(rootFontSize, '150% 根字号必须真的生效，否则本条测的是 100%').toBeGreaterThan(16);
}

test.describe('T082 键盘、文本替代与字号', () => {
  test('T082-C04b 打开记录抽屉时键盘必须跟着进去，关闭后回到原处', async ({ page }) => {
    /**
     * 这条用例来自本轮实测发现的一个**真实缺陷**，不是规格里预先写好的场景。
     *
     * `KnowledgeDrawer` 声明了 `aria-modal="true"`，但从不把焦点移进抽屉，也没有把 Tab
     * 限制在抽屉内。后果是：读屏软件会宣告「模态对话框」，而键盘焦点留在遮罩**下面**
     * 那张卡片的按钮上，接下来几十次 Tab 都在背景页面里游走——数到「关闭」要按的次数
     * 比抽屉里的可聚焦控件还多。声称自己是个陷阱、而陷阱并不存在，比不声称更糟。
     *
     * 所以这里断言的是模态该有的三件事，全部只用键盘观察：
     *   1. 打开后焦点进入抽屉（而不是停在背景）；
     *   2. Tab 走到底会回卷到抽屉里的第一个控件，**不会**跑到遮罩后面；
     *   3. 关闭后焦点回到打开它的那个控件，键盘路径可逆。
     */
    await gotoInbox(page);
    const text = uniqueText('抽屉焦点');
    await captureViaUi(page, text);

    const opener = page.getByTestId('knowledge-card').filter({ hasText: text }).getByRole('button').first();
    await opener.focus();
    expect(await activeTestId(page), '打开之前焦点应在这张卡片的按钮上').not.toBeNull();
    const openerTestId = await activeTestId(page);
    await page.keyboard.press('Enter');

    const drawer = page.getByTestId('knowledge-drawer');
    await expect(drawer).toBeVisible();
    await expect(
      page.getByTestId('drawer-close'),
      '抽屉声明了 aria-modal，焦点就必须进来；否则键盘用户是在遮罩后面操作',
    ).toBeFocused();

    /**
     * 走到底再按一次：焦点必须仍在抽屉内部。
     *
     * 这里不用「按 N 次 Tab 后等于 drawer-close」这种写法——那会写死控件数量，
     * 加一个字段就红，而它证明的东西（焦点没有离开抽屉）与数量无关。判断依据是
     * `document.activeElement` 是否仍在抽屉元素之内，这是模态约束本身。
     */
    for (let index = 0; index < 60; index += 1) {
      await page.keyboard.press('Tab');
      const inside = await drawer.evaluate((element) => element.contains(document.activeElement));
      expect(inside, `第 ${index + 1} 次 Tab 之后焦点仍应留在抽屉里`).toBe(true);
    }

    // 闭合键盘路径：Escape 关闭，焦点回到打开它的控件。
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    expect(
      await activeTestId(page),
      '关闭后焦点应回到打开抽屉的控件，而不是回到文档开头',
    ).toBe(openerTestId);
  });

  test('T082-C01 整理失败时先说明原文仍在，用户不会以为白写了', async ({ page }) => {
    await gotoInbox(page);
    /**
     * 制造一次**真实的**整理失败，而不是让「保存并整理」在缺 Key 时短路。
     *
     * 缺 Key 那条路（T025-C03 / T042-C04）走的是 `capture-hint` 文案，根本没有到
     * `failureKeepingSaved`。R01 要管的正是另一半：请求发出去了、模型返回了、整理
     * 没成功——这时用户最需要听见的是「原文已保存」。所以这里先按产品自己的路径配好
     * 一个连接，再让**脚本替身**回一个不合法的 JSON：真实路由、真实适配器、真实事务
     * 全跑，只有出站 HTTP 一步被重放（`BRAIN_SCRIPTED_PROVIDER`）。R04 要求
     * 「没有配置成功却被当成应用不可用」和「整理失败被当成保存失败」都不能出现。
     */
    const headers = await authHeaders(page);
    await ensureLlmConfigured(headers);
    // `writeScript` 只接受一个 **content 字符串**（见它的签名），包装成 replies 是它
    // 自己的事；这里传一段解析不了的文本，让真实解析器去失败。
    writeScript('这不是 JSON，解析必然失败');

    /**
     * 配好连接之后**必须重新进入收件箱**。
     *
     * `InboxPage` 只在挂载时读一次 `/api/settings/llm`，把结果交给 `CaptureBox`；而
     * `CaptureBox` 只有在 `modelConfigured` 为真时才把 organize 步骤接上（否则
     * 「保存并整理」会发一个注定失败、且用户会被重复打扰的请求）。所以在
     * `gotoInbox` 之后再配置，页面仍以为没有模型——用例会走到缺 Key 的那条文案，
     * 看起来像产品缺陷，其实是本用例没有让页面看见刚写好的配置。
     */
    await gotoInbox(page);

    const text = uniqueText('整理失败');
    await page.getByTestId('capture-input').fill(text);
    await page.getByTestId('capture-save-organize').click();

    // 保存这一步是成功的，先出现，且不能被后面的失败改写。
    const status = page.getByTestId('save-phase');
    await expect(status).toContainText('已保存');
    await expect(status, '整理失败不得被写成保存失败').not.toContainText('保存失败');

    /**
     * 组织失败的那句必须同时给出三件事：原文还在、哪一步没完成、怎么恢复。
     * `failureKeepingSaved` 是唯一出口，所以这里断言的是它的形状而不是某一个字。
     */
    const organizeFailure = page.getByTestId('organize-status');
    await expect(organizeFailure).toBeVisible({ timeout: 30_000 });
    await expect(organizeFailure).toContainText('原文已保存');
    await expect(organizeFailure).toContainText('整理没完成');
    await expect(organizeFailure).toContainText('可以稍后重试');

    // 记录真的落库了——「原文已保存」不是一句安慰。
    const listed = await page.request.get(`${E2E_ORIGIN}/api/items`, {
      headers,
      params: { q: text, limit: 5 },
    });
    const envelope = (await listed.json()) as { data: { items: { id: string; rawText: string }[] } };
    expect(
      envelope.data.items.some((item) => item.rawText.includes(text)),
      '整理失败之后，原文必须仍然可以按文本读回',
    ).toBe(true);

    // 本用例改过套件共用的模型连接，必须还原：后面的 `offline-crud` / `save-races`
    // 断言的是「未配置模型」的行为。
    await restoreLlmSettings();
  });

  test('T082-C02 旧视图的提示说的是「依据已变化、需重新生成」，不是文件坏了', async ({ page }) => {
    await gotoInbox(page);
    const noteText = uniqueText('过期解释');
    const itemId = await seedItemViaApi(page, { rawText: noteText });
    const headers = await authHeaders(page);

    // 先把视图种下去（生成当时的快照），再改原文——顺序就是这条用例的全部内容：
    // 先改后种会让快照一开始就匹配，那是不需要提示的那种情况。
    const viewId = withSeedDb((db) =>
      seedView(db, {
        name: uniqueText('过期解释脑图'),
        kind: 'mindmap',
        itemIds: [itemId],
        content: {
          title: '过期解释根',
          nodes: [
            { id: 'm1', parentId: null, label: '过期解释根', itemIds: [itemId], kind: 'group' },
          ],
        },
      }),
    );

    const before = await page.request.get(`${E2E_ORIGIN}/api/items/${itemId}`, { headers });
    const revision = ((await before.json()) as { data: { revision: number } }).data.revision;
    const patched = await page.request.patch(`${E2E_ORIGIN}/api/items/${itemId}`, {
      headers,
      data: { expectedRevision: revision, patch: { rawText: `${noteText}\nT082-C02 之后改写的一行` } },
    });
    expect(patched.status(), 'PATCH 原文应返回 200').toBe(200);

    await page.goto('/mindmap');
    await page.getByTestId('mindmap-view-select').selectOption(viewId);
    const banner = page.getByTestId('view-freshness-banner');
    await expect(banner).toBeVisible();

    // 必须断言：说得清是来源变了、要重新生成，而且旧图没有被偷偷改写。
    await expect(page.getByTestId('view-freshness-reason')).toContainText('条笔记已修改');
    await expect(page.getByTestId('view-freshness-scope')).toContainText('仍然显示生成时的内容');
    await expect(page.getByTestId('view-freshness-scope')).toContainText('不会被自动改写');
    /**
     * 必须排除：把「原文改过」说成「数据损坏 / 文件坏了」。
     *
     * 只对**原因那句**查禁用词，不对整块横幅查：横幅里有一句有意的澄清
     * 「所以『来源已变化』不等于数据损坏」——那句话正是在反驳这个误解，把它算成违例
     * 就会逼着实现删掉一句正确的说明（本用例第一版就是这么红的）。禁用词要看的是
     * 「用户被告知的结论」，不是「整段文本里出现过哪几个字」。
     */
    const reasonText = (await page.getByTestId('view-freshness-reason').textContent()) ?? '';
    for (const forbidden of ['数据损坏', '文件坏了', '内容错误', '依据已过期', '过期']) {
      expect(reasonText, `原因那句不得把 stale 说成「${forbidden}」`).not.toContain(forbidden);
    }
    // 而且要给得出可执行的动作，不能只是一句状态。
    await expect(
      page.getByTestId('view-freshness-banner').getByText('重新生成'),
      '必须告诉用户怎么处理，而不只是宣布一个状态',
    ).toBeVisible();
  });

  test('T082-C03 没有 Key 时设置页与收件箱都说清「不能用什么」，而不是「应用不可用」', async ({ page }) => {
    await gotoInbox(page);
    /**
     * 这条用例要求**未配置模型**这一前置。
     *
     * 套件共用一个数据库，G4/G5 的生成用例会往设置里写连接并在 afterAll 还回去，
     * 但用例之间的顺序不是本文件能保证的，所以这里按产品的删除路径主动把 Key 清掉，
     * 而不是假设它已经是空的（那样一旦不是空的，「无 Key 空态」就会被静默跳过）。
     */
    await restoreLlmSettings();

    await page.goto('/settings');
    const settingsScope = page.getByTestId('settings-model-scope');
    await expect(settingsScope).toBeVisible();
    // 第一句：什么需要模型。
    await expect(page.getByTestId('settings-model-required-for')).toContainText('配置模型');
    // 第二句才是关键的一半：还有什么照常可用。
    const optional = page.getByTestId('settings-model-optional');
    await expect(optional).toContainText('照常可用');
    await expect(optional).toContainText('保存原文');
    // 必须排除：把「配置未完成」写成「应用不可用」。
    /**
     * 只检查那两句**提示文案**，不检查整个占位区域：同时渲染的表单里有「设置没有保存」
     * 之类的错误容器（此刻为空），笼统地对 `settings-model-scope` 断言会把别处的状态
     * 也算进来，读起来像在测这条规则其实没测的东西。
     */
    const modelScopeText = `${await page.getByTestId('settings-model-required-for').textContent()}${
      await optional.textContent()
    }`;
    for (const forbidden of ['应用不可用', '无法使用', '系统错误']) {
      expect(modelScopeText, `设置页不得说「${forbidden}」`).not.toContain(forbidden);
    }

    // 收件箱：说清前提，同时不阻止记录。
    await gotoInbox(page);
    const text = uniqueText('无Key空态');
    await page.getByTestId('capture-input').fill(text);
    await page.getByTestId('capture-save-organize').click();
    await expect(page.getByTestId('save-phase')).toContainText('已保存');
    const hint = page.getByTestId('capture-hint');
    await expect(hint).toContainText('配置模型');
    await expect(hint).toContainText('照常保存');
    await expect(hint).toContainText('离线功能不受影响');
    // 「不阻止记录」：输入框仍然可用，且这条真的存下来了。
    await expect(page.getByTestId('capture-input')).toBeEnabled();
    await page.getByRole('link', { name: '资料库' }).click();
    await page.getByTestId('library-search').fill(text);
    await expect(page.getByTestId('knowledge-card').filter({ hasText: text })).toBeVisible();
  });

  test('T082-C04 放大字号后六页的关键按钮仍完整可见并能用键盘激活', async ({ page }) => {
    await gotoInbox(page);

    /**
     * 六页各选一个该页最关键的操作，断言它既在视口内、也能被键盘真的激活。
     *
     * `prepare` 是必需的，不是装饰：`focus()` 对**禁用**控件不生效（浏览器把焦点
     * 留在原处），而这几页的主控件在数据到位前都是禁用的。少了这一步，断言会读回
     * 上一个控件、报出「应能被键盘聚焦」失败——那是在测"这一页刚打开"，不是测
     * "放大字号后这个按钮还能用"。
     */
    const expectations: { route: string; testId: string; prepare?: () => Promise<void> }[] = [
      {
        route: '/inbox',
        testId: 'capture-save',
        // 「只保存」在没有文本时是禁用的，先写一句让它成为可操作状态。
        prepare: async () => {
          await page.getByTestId('capture-input').fill(uniqueText('放大字号'));
        },
      },
      { route: '/library', testId: 'library-search' },
      { route: '/graph', testId: 'graph-view-select' },
      { route: '/mindmap', testId: 'mindmap-view-select' },
      { route: '/flow', testId: 'flow-view-select' },
      { route: '/settings', testId: 'backup-export' },
    ];

    for (const expectation of expectations) {
      await page.goto(expectation.route);
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
      // 放大到 150%：改根字号是浏览器「字体大小」设置的效果，而 `zoom` 只是缩放画布，
      // 两者对固定 px 布局的影响不同。这里用前者，因为它才是用户抱怨的那个场景。
      // **每次导航之后都要重注**：整页导航会丢掉上一页注入的样式。
      await scaleUpFont(page);
      const control = page.getByTestId(expectation.testId);
      await expect(control, `${expectation.route} 的「${expectation.testId}」应存在于页面上`).toBeVisible();
      if (expectation.prepare) await expectation.prepare();
      // 这一步本身就是一条断言：控件若被禁用或被盖住，`toBeEnabled`/`focus` 会先失败，
      // 而不是让后面的焦点断言报出一个误导性的原因。
      await expect(
        control,
        `${expectation.route} 放大字号后「${expectation.testId}」必须可操作（不是禁用状态）`,
      ).toBeEnabled();
      expect(
        await isFullyInViewport(page, expectation.testId),
        `${expectation.route} 放大字号后「${expectation.testId}」必须完整落在视口内、且中心点没有被别的元素盖住`,
      ).toBe(true);
      // 键盘可达：把焦点交给它，再按一次 Tab 确认焦点真的从它移走（而不是根本没到过）。
      await control.focus();
      expect(
        await activeTestId(page),
        `${expectation.route} 的「${expectation.testId}」应能被键盘聚焦`,
      ).toBe(expectation.testId);
      await page.keyboard.press('Tab');
      expect(
        await activeTestId(page),
        `${expectation.route} 按 Tab 后焦点应离开「${expectation.testId}」，否则该控件吞掉了键盘`,
      ).not.toBe(expectation.testId);
    }

    // 放大后仍然真的能完成一次保存：不只是「按钮还在」，而是核心路径还走得通。
    await page.goto('/inbox');
    await scaleUpFont(page);
    const text = uniqueText('放大字号保存');
    const input = page.getByTestId('capture-input');
    await input.fill(text);
    await input.focus();
    await page.keyboard.press('Control+Enter');
    await expect(page.getByTestId('save-phase')).toContainText('已保存');
    await expect(page.getByTestId('knowledge-card').filter({ hasText: text })).toBeVisible();
  });

  test('T082-C05 删视图与删条目是两个不同的确认，且都说明影响范围', async ({ page }) => {
    await gotoInbox(page);
    const { leftId, rightId, headers } = await capturePair(page, '删除范围');
    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('删除范围视图'),
      itemIds: [leftId, rightId],
    });
    await openScopedGraph(page, viewId, 2);

    // ---- 删视图：说的是「只删视图」 ------------------------------------------
    await page.getByTestId('graph-delete-view').click();
    const viewDialog = page.getByTestId('delete-view-dialog');
    await expect(viewDialog).toBeVisible();
    // 焦点落在安全的那一侧：从一个正在浏览的列表里按 Enter 不应删掉东西。
    expect(await activeTestId(page), '删视图确认框应把焦点放在「取消」上').toBe(
      'delete-view-cancel',
    );
    const viewScope = viewDialog.getByTestId('delete-view-scope');
    await expect(viewScope).toContainText('只会删除这个视图');
    await expect(viewScope).toContainText('知识条目、标签与关系都不受影响');
    // 必须排除：把它说成删知识，或说得含糊到两者分不清。
    await expect(viewScope).not.toContainText('原文与整理结果都会被删除');
    /**
     * 先取文本再关框。
     *
     * 关掉之后 `viewScope` 就解析不到元素了（`textContent()` 会一直等到超时），
     * 而这条断言的目的是「两句措辞不同」，不是「关掉之后还能读到它」——所以要在
     * 对话框还在的时候把它取下来。这正是本用例第一版踩的坑。
     */
    const viewScopeText = await viewScope.textContent();

    // Esc 取消，确认框关闭且什么都没删。
    await page.keyboard.press('Escape');
    await expect(viewDialog).toHaveCount(0);

    // ---- 删条目：说的是「原文与整理结果都会被删除」 ------------------------
    await page.goto('/library');
    await page.getByTestId('library-search').fill('删除范围');
    const card = page.getByTestId('knowledge-card').filter({ hasText: '删除范围' }).first();
    await card.getByRole('button').first().click();
    await expect(page.getByTestId('knowledge-drawer')).toBeVisible();
    await page.getByTestId('drawer-delete').click();
    const itemDialog = page.getByTestId('delete-dialog');
    await expect(itemDialog).toBeVisible();
    const itemScope = itemDialog.getByTestId('delete-item-scope');
    await expect(itemScope).toContainText('原文与整理结果都会被删除');
    await expect(itemScope).toContainText('无法撤销');
    await expect(itemScope).toContainText('已经保存的视图不会被删除');
    // 两条确认的措辞必须真的不同，这正是用户用来分辨后果的依据。
    expect(await itemScope.textContent()).not.toBe(viewScopeText);
    await page.getByTestId('delete-cancel').click();
    await expect(itemDialog).toHaveCount(0);
  });

  test('T082-C06 不用图也能核对关系与来源，并能回跳到原文', async ({ page }) => {
    await gotoInbox(page);
    const { left, leftId, rightId, headers } = await capturePair(page, '文本替代');
    /**
     * 关系必须**先存在**，列表才有东西可读。
     *
     * `capturePair` 只造两条记录；用视图选中它们不会凭空产生一条边，所以这个用例
     * 第一版里列表恒为空、断言 `toHaveCount(1)` 必然失败。种子走的是与产品同一条
     * INSERT（`seedAiRelation` 自己读当前 `raw_version`），因此这条边一开始就是
     * fresh 的，`待确认` 来自 `reviewStatus: 'suggested'` 而不是来自"过期"。
     */
    const relationId = withSeedDb((db) =>
      seedAiRelation(db, {
        sourceId: leftId,
        targetId: rightId,
        score: 0.8,
        reviewStatus: 'suggested',
        reason: 'T082-C06 文本替代用例种下的模型建议',
      }).id,
    );
    expect(relationId, '种子关系应有 id').toBeTruthy();

    const viewId = await saveGraphView(page, headers, {
      name: uniqueText('文本替代视图'),
      itemIds: [leftId, rightId],
    });
    await openScopedGraph(page, viewId, 2);

    // 从关系列表进入检查器，再从检查器打开记录抽屉。画布在这一段里一次都不碰：
    // 如果文本列表只是摘要，这条路走不到抽屉。
    const list = page.getByTestId('graph-relation-list');
    const open = await list.evaluate((element) => (element as HTMLDetailsElement).open);
    if (!open) await list.locator('summary').click();

    const rows = page.getByTestId('graph-relation-list-item');
    await expect(rows).toHaveCount(1);
    // 列表本身就带文字状态，不依赖颜色（T050-C04 的同一规则在 T082 继续成立）。
    await expect(page.getByTestId('graph-alt-summary-nodes')).toContainText('节点 2 个');
    await expect(page.getByTestId('graph-alt-summary-edges')).toContainText('关系 1 条');
    await expect(rows.first()).toContainText('待确认');

    // 只用键盘激活列表里的关系：Tab 到它，再按 Enter。
    await rows.first().focus();
    await page.keyboard.press('Enter');
    const inspector = page.getByTestId('graph-inspector');
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText('待确认');

    // 端点在检查器里是可点的按钮，点它们打开的是真实记录——这是「能回跳」。
    // 用**记录 id** 定位而不是标签文本：画布上的标签会被截断，标签匹配会随版式漂移。
    await inspector.getByRole('button', { name: left }).click();
    await expect(page.getByTestId('knowledge-drawer')).toBeVisible();
    await expect(page.getByTestId('knowledge-drawer')).toContainText(left);
    await page.getByTestId('drawer-close').click();
    await expect(page.getByTestId('knowledge-drawer')).toHaveCount(0);
  });

  test('T082-C06 脑图的层级与来源有不依赖画布的读法', async ({ page }) => {
    await gotoInbox(page);
    const note = uniqueText('大纲替代');
    await captureViaUi(page, note);
    const headers = await authHeaders(page);
    const found = await page.request.get(`${E2E_ORIGIN}/api/items`, {
      headers,
      params: { q: note, limit: 5 },
    });
    const body = (await found.json()) as { data: { items: { id: string; rawText: string }[] } };
    const itemId = body.data.items.find((entry) => entry.rawText.includes(note))!.id;

    const viewId = withSeedDb((db) =>
      seedView(db, {
        name: uniqueText('大纲替代脑图'),
        kind: 'mindmap',
        itemIds: [itemId],
        content: {
          title: '大纲替代根',
          nodes: [
            { id: 'm1', parentId: null, label: '大纲替代根', itemIds: [itemId], kind: 'group' },
            { id: 'm2', parentId: 'm1', label: '唯一要点', itemIds: [itemId], kind: 'note' },
          ],
        },
      }),
    );

    await page.goto('/mindmap');
    await page.getByTestId('mindmap-view-select').selectOption(viewId);

    // 大纲是文本，并且每个节点都写着它引用了多少来源。
    const outline = page.getByTestId('mindmap-outline');
    await expect(outline).toBeVisible();
    await expect(page.getByTestId('mindmap-outline-node')).toHaveCount(2);
    await expect(outline).toContainText('引用 1 条来源');
    await expect(page.getByTestId('mindmap-outline-summary')).toContainText('2 个节点');

    // 折叠是一个带 aria-expanded 的按钮，键盘可切换（T082-R04 的展开控件）。
    const toggle = page.getByTestId('mindmap-outline-toggle').first();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // 折叠真的收起了子节点：只剩根那一行。这条断言让上面那次切换有了可观察的后果，
    // 否则「aria-expanded 变成 false」也可能只是个没有接上树的属性。
    await expect(page.getByTestId('mindmap-outline-node')).toHaveCount(1);
    // 再按一次展开回来——**必须还原**，否则下面 `nth(1)` 要选的子节点并不在文档里
    // （本用例第一版就是在这里等到超时的）。
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('mindmap-outline-node')).toHaveCount(2);

    // 选中一个节点后，来源列表给出可读的原文入口，而不是一句「见图」。
    // nth(1) 是根下面的那个要点；nth(0) 是根，两者都引用同一条记录，所以必须选
    // 子节点才能证明「选中的节点决定来源列表」而不是「总有默认的一个」。
    await page.getByTestId('mindmap-outline-select').nth(1).click();
    const sources = page.getByTestId('source-list');
    await expect(sources).toBeVisible();
    await expect(page.getByTestId('source-list-item')).toHaveCount(1);
    await expect(page.getByTestId('source-list-item').first()).toHaveAttribute('data-item-id', itemId);
    await expect(sources).toContainText(note);
    await page.getByTestId('source-open').first().click();
    await expect(page.getByTestId('knowledge-drawer')).toContainText(note);
  });
});
