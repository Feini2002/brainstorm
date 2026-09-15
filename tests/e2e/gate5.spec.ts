import { expect, gotoInbox, test } from './support/fixtures';
import { authHeaders, uniqueText } from './support/harness';
import {
  captureFlowSource,
  drawnTexts,
  fetchFlowExport,
  listFlowViewIds,
  openSavedFlow,
  readFlowRun,
  scriptedFlowGeneration,
  seedFlowContent,
  seedFlowView,
  seedFlowViewIn,
  unsafeMarkupInCanvas,
  uniqueLabel,
  waitForDrawnSvg,
} from './support/goflow';
import { headersAt, restoreLlmSettings } from './support/gomindmap';
import { seedAiRelation, withSeedDb } from './support/seedData';
import {
  isPortFree,
  resetRestartDataDir,
  restartDataDir,
  restartOrigin,
  restartPort,
  startServer,
} from './support/restartServer';
import {
  flowCases,
  invalidAnswerBody,
  validAnswerBody,
  validExpectation,
  validLabels,
} from '../helpers/flowCases';

/**
 * T069 验收｜流程可视化与逻辑保真闭环验收
 *
 * This is the G5 gate report. Like `gate4.spec.ts` it differs from the per-task
 * specs on purpose: T062–T068 each prove one module's rule, and this file proves
 * that the modules agree with each other, with the database, and with a file that
 * leaves the application. Four decisions worth stating up front:
 *
 *  1. **The model answers are a fixture and travel the production path.**
 *     `tests/fixtures/flow-cases.json` holds the answers; `scriptedFlowGeneration`
 *     posts them to the real `/api/views/mermaid/generate`, so the strict schema,
 *     the evidence gate, the run registration and the insert all run for real and
 *     only the outbound HTTP step is replayed. Writing "is this causal claim
 *     supported" a second time inside a spec would prove the spec's idea of
 *     support, which is exactly what T069-C01 must not rest on.
 *
 *  2. **Where a case is about a view that already exists, the row is seeded and
 *     the reason is written down.** T069-C03 (which diagram is on screen after a
 *     fast switch) and C04 (does an asset survive a restart) are properties of a
 *     *stored* row plus the reader; neither becomes true or false depending on how
 *     the row was created. C01, C02 and C05 are about the creation, rendering and
 *     export paths, so they take no shortcut.
 *
 *  3. **Both ends of every loop are asserted.** "Saved" is checked by reading the
 *     view back over HTTP *and* by looking at the drawn SVG; "survived a restart"
 *     is checked by a new process answering with a new session token; "exported"
 *     is checked by parsing the bytes back and comparing them against the row. A
 *     DOM assertion alone cannot show what was written, and a database assertion
 *     alone cannot show the user saw it.
 *
 *  4. **The real-model half is named, not faked.** T069-C01's *semantic* half —
 *     whether a real model writes a cause it cannot support — needs the user's own
 *     credential and is reported as blocked. The half decidable without a model
 *     (the evidence gate, the downgrade warning, the drawn 「推测：」 word) is
 *     asserted here.
 *
 * Baseline: every case pins its reads to ids it created, so the suite's shared,
 * never-reset database cannot change what a case asserts.
 * (`docs/05_tests/G5 公共测试装置`.)
 */

/**
 * The `k` marker for "this line is not allowed to be anything but data".
 *
 * Mermaid directives live at the start of a line (`click`, `style`, `classDef`,
 * `linkStyle`, `subgraph`, `init`) or in a `%%{ … }%%` block. A compiled source that
 * contains one of those at a line start has stopped being a diagram of the material.
 * Text *inside* a quoted label may say anything at all — including the word `click`
 * and a URL — and that is inert text, which is why this looks only at line starts.
 */
const MERMAID_DIRECTIVE_LINE =
  /^[ \t]*(?:click|style|classDef|linkStyle|subgraph|init|accTitle|accDescr|graph|end)\b/imu;

/**
 * The compiled source's line grammar, asserted against the product's own output.
 *
 * `[^"]*` is the whole safety argument, and it is a stronger statement than any word
 * scan: `escapeFlowLabel` replaces every raw `"` (with the fullwidth form) and every
 * `<` `>` (with `&lt;` / `&gt;`), so a label **cannot close its own string**, and
 * therefore the remainder of the line cannot become syntax. A "does the file contain
 * `script`" scan would say nothing about that (and would wrongly fail a note that
 * merely mentioned the word), which is why the escaping claims in
 * `docs/03_contracts/09 §3` are checked by shape instead.
 */
const COMPILED_NODE_LINE = /^ {2}N\d+\["[^"]*"\]$/u;
const COMPILED_EDGE_LINE = /^ {2}N\d+ (?:-->|-\.->)\|"[^"]*"\| N\d+$/u;

/** Check every line of a compiled body against the grammar above. */
function assertLineGrammar(source: string, where: string): void {
  const lines = source.split('\n');
  expect(lines[0], `${where}：第一行必须是流程图头`).toMatch(/^flowchart (?:LR|TB)$/u);
  for (const line of lines.slice(1)) {
    if (line.trim().length === 0) continue;
    const shaped = COMPILED_NODE_LINE.test(line) || COMPILED_EDGE_LINE.test(line);
    expect(shaped, `${where}：这一行不符合受限模板：${line.slice(0, 80)}`).toBe(true);
  }
  /*
   * 标签不可能把 `<` `>` 变成标记 —— 但要按**实体感知 + 箭头感知**的方式断言。
   *
   * 两个实测出来的坑：
   *
   *  1. 「源码里没有 `<` 字符」不能写成对 `#60;` 的检查：正确的转义是把 `<` 写成
   *     `&lt;`，而 `&lt;` 这个四字符序列里**本来就没有** `<`，所以「不许有裸 `<`」
   *     是成立的，且正是转义生效的证据。
   *  2. 但 `>` 不行：边模板 `-->` / `-.->` 本身就带一个真的 `>`，全局扫 `>` 会把
   *     正常箭头判成失败。所以先把两种箭头 token 去掉，再断言没有任何尖括号残留 ——
   *     这恰好证明「源码里仅有的尖括号就是箭头本身」。
   */
  const withoutArrows = source.replace(/-\.?->/gu, '');
  expect(
    withoutArrows,
    `${where}：除箭头外不得出现尖括号（标签里的尖括号只能写成 &lt; / &gt;）`,
  ).not.toMatch(/[<>]/u);
}


/** One view, read back from the API, as this file needs to see it. */
interface FlowViewRead {
  id: string;
  kind: string;
  name: string;
  revision: number;
  generatedAt: string | null;
  contentHash: string | null;
  content: {
    title: string;
    direction: 'LR' | 'TB';
    nodes: { id: string; label: string; itemIds: string[] }[];
    edges: {
      source: string;
      target: string;
      kind: string;
      label: string;
      itemIds: string[];
      relationIds: string[];
    }[];
  };
  sourceSnapshot: {
    items: { id: string; rawVersion: number; revision: number }[];
    relations: { id: string; revision: number }[];
  };
}

/**
 * The drawn text with all whitespace removed, for substring assertions.
 *
 * Measured: Mermaid wraps a long label into several `tspan` rows and drops the space
 * at the wrap boundary, so `img src=x onerror` is readable on screen as
 * `imgsrc=xonerror`. That is a property of Mermaid's line-breaking, not of the
 * escaping under test, so the comparison normalises both sides instead of asserting a
 * spacing the renderer is free to change.
 */
function unwrapped(text: string): string {
  return text.replace(/\s+/gu, '');
}

async function readFlowView(
  page: import('@playwright/test').Page,
  headers: Record<string, string>,
  viewId: string,
): Promise<FlowViewRead> {
  const base = headers['origin']!;
  const response = await page.request.get(`${base}/api/views/${viewId}`, { headers });
  expect(response.status(), `GET /api/views/${viewId} 应返回 200`).toBe(200);
  const body = (await response.json()) as { data: FlowViewRead };
  return body.data;
}

test.describe('T069 流程可视化与逻辑保真验收', () => {
  /**
   * Give the suite's shared database back its starting condition.
   *
   * Several later specs assert how the app behaves with **no** model configured,
   * so leaving a stored connection behind would quietly move them onto a branch
   * they do not mean to test. Undone by the product's own settings route.
   */
  test.afterAll(async () => {
    await restoreLlmSettings();
  });

  test('T069-C01 因果审查：无依据的因果被降级并写明，有依据的因果保留', async ({ page }) => {
    await gotoInbox(page);
    const headers = await authHeaders(page);

    // Real records through the real capture endpoint.
    const first = await captureFlowSource(page, 'T069C01甲');
    const second = await captureFlowSource(page, 'T069C01乙');
    // A real row that exists but is *not* selected, so 「无效来源」 is about the
    // selection rule rather than about a nonexistent id.
    const unselected = await captureFlowSource(page, 'T069C01未选中');
    const slots = { selected: [first.id, second.id], unselected: unselected.id };

    // ---- 主场景：材料只有相关，模型声称因果 -------------------------------
    //
    // The relation is a *`related_to`* suggestion, not a `causes` one: 「相关不等于
    // 因果」 has to be decided by the evidence gate rather than by the absence of any
    // relation at all.
    const relatedId = withSeedDb(
      (db) =>
        seedAiRelation(db, {
          sourceId: first.id,
          targetId: second.id,
          type: 'related_to',
          reviewStatus: 'accepted',
          reason: 'T069-C01 相关而非因果',
        }).id,
    );
    expect(relatedId).toBeTruthy();

    const withoutEvidence = await scriptedFlowGeneration(page, headers, {
      itemIds: slots.selected,
      body: validAnswerBody('causalClaimedWithoutEvidence', slots),
    });
    expect(withoutEvidence.state, '主场景应成功生成').toBe('succeeded');
    expect(withoutEvidence.viewId).toBeTruthy();

    const stored = await readFlowView(page, headers, withoutEvidence.viewId!);
    const expectation = validExpectation('causalClaimedWithoutEvidence', slots);

    // 「必须断言：不能无依据标 causal，推测显式标出」——断言的是**落库的类型**，
    // 不是页面上的颜色或提示语。
    expect(stored.content.edges).toHaveLength(1);
    expect(stored.content.edges.map((edge) => edge.kind)).toEqual(expectation.edgeKinds);
    expect(stored.content.edges[0]!.kind).toBe('hypothesis');

    // 用户被告知为什么；run 是权威记录。
    const run = await readFlowRun(page, headers, withoutEvidence.runId);
    expect(run.state).toBe('succeeded');
    expect(withoutEvidence.warnings.join(''), '必须写明降级原因').toContain('因果');
    expect(withoutEvidence.warnings.join('')).toContain('推测');
    expect(expectation.warns).toBe(true);

    // 「必须排除：可视化会增强错误结论的说服力」——投影不写回知识库：生成了推测边
    // 之后，relations 表里不应多出任何一条自动关系。
    const relationCount = withSeedDb(
      (db) =>
        (
          db
            .prepare(
              'SELECT COUNT(*) AS n FROM relations WHERE source_id IN (?, ?) AND target_id IN (?, ?)',
            )
            .get(first.id, second.id, first.id, second.id) as { n: number }
        ).n,
    );
    expect(relationCount, '生成流程图不应自动写入新的知识关系').toBe(1);

    // ---- 屏幕这一端：推测必须在画面上看得见 ------------------------------
    await openSavedFlow(page, stored.id);
    await waitForDrawnSvg(page);
    const drawn = (await drawnTexts(page)).join(' | ');
    for (const label of validLabels('causalClaimedWithoutEvidence', slots)) {
      expect(drawn, `画面上应出现材料里的节点文字「${label}」`).toContain(label);
    }
    // 虚线边 + 「推测：」前缀，两者都要有：只有其中一个都会让猜测看起来像事实。
    expect(drawn, '推测边必须写明「推测：」').toContain('推测：');
    expect(await page.getByTestId('flow-svg').locator('path[marker-end]').count()).toBeGreaterThan(0);
    await expect(page.getByTestId('flow-legend')).toContainText('推测');

    // 来源面板把推测单独列出，并明确「没有引用的关系」。
    await expect(page.getByTestId('flow-hypothesis-row')).toHaveCount(1);
    await expect(page.getByTestId('flow-hypothesis-row')).toContainText('推测：');
    await expect(page.getByTestId('flow-relation-none')).toBeVisible();

    // ---- 对照组：有已确认 causes 依据时，同一条 causal 声明必须保住 --------
    //
    // 这个样本能保住 causal，才说明上一条的降级是「因为没依据」，而不是
    // 「程序一律不画因果」。
    const causeId = withSeedDb(
      (db) =>
        seedAiRelation(db, {
          sourceId: first.id,
          targetId: second.id,
          type: 'causes',
          reviewStatus: 'accepted',
          reason: 'T069-C01 已确认的因果依据',
        }).id,
    );

    const withEvidence = await scriptedFlowGeneration(page, headers, {
      itemIds: slots.selected,
      body: validAnswerBody('causalClaimedWithEvidence', { ...slots, relation: causeId }),
    });
    expect(withEvidence.state, '对照组应成功生成').toBe('succeeded');

    const justified = await readFlowView(page, headers, withEvidence.viewId!);
    expect(justified.content.edges.map((edge) => edge.kind)).toEqual(['causal']);
    expect(justified.content.edges[0]!.relationIds).toEqual([causeId]);
    expect(withEvidence.warnings.join(''), '有依据时不应报降级').not.toContain('改成');
    // 引用的关系进入了快照，所以「依据是什么」可追溯。
    expect(justified.sourceSnapshot.relations.map((entry) => entry.id)).toContain(causeId);

    // 屏幕上 causal 写「因果：」，不写「推测：」。
    await openSavedFlow(page, justified.id);
    await waitForDrawnSvg(page);
    const causalText = (await drawnTexts(page)).join(' | ');
    expect(causalText).toContain('因果：');
    expect(causalText, '有依据的因果边不应被标成推测').not.toContain('推测：');
    await expect(page.getByTestId('flow-hypothesis-none')).toBeVisible();
    await expect(page.getByTestId('flow-relation-row')).toHaveCount(1);
    await expect(page.getByTestId('flow-relation-row')).toHaveAttribute('data-relation-id', causeId);

    // ---- 语义那一半：真实模型是否克制，不由本用例裁决 ---------------------
    //
    // 断言的是**门槛**（无依据 → 降级），不是某个模型的措辞习惯。真实模型的语义
    // 质量需要用户自己的 Key，因此记为具名阻塞而不是在这里假称已通过。
    const semantic = 'BLOCKED_BY_EXTERNAL_CREDENTIAL';
    expect(semantic).toBe('BLOCKED_BY_EXTERNAL_CREDENTIAL');
  });

  test('T069-C02 安全全链：恶意标签经生成、编译、渲染、导出后都没有可执行标记', async ({
    page,
    traffic,
  }) => {
    // 「没有脚本执行」只有真跑才会 popup，所以监听是断言的一半。
    const dialogs: string[] = [];
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });

    await gotoInbox(page);
    const headers = await authHeaders(page);

    const first = await captureFlowSource(page, 'T069C02甲');
    const second = await captureFlowSource(page, 'T069C02乙');
    const slots = { selected: [first.id, second.id], unselected: first.id };

    // The hostile sample is *valid*: escaping is the compiler's job, not a reason to
    // refuse the answer. It goes through the real generation route, so the whole
    // chain (schema → evidence gate → compile → store → render → sanitize → export)
    // runs on the same document.
    const hostile = await scriptedFlowGeneration(page, headers, {
      itemIds: slots.selected,
      body: validAnswerBody('modelMarkedHypothesis', slots),
    });
    expect(hostile.state, '带注入片段的合法答案应被接受').toBe('succeeded');
    const stored = await readFlowView(page, headers, hostile.viewId!);
    // 前提确认：注入片段真的在**入库的**内容里，而不是在传输中被丢掉。
    expect(stored.content.nodes.some((node) => node.label.includes('<script>'))).toBe(true);
    expect(stored.content.nodes.some((node) => node.label.includes('onerror'))).toBe(true);
    expect(stored.content.edges[0]!.label).toContain('securityLevel');

    await openSavedFlow(page, stored.id);
    await waitForDrawnSvg(page);
    // 给任何「想加载点什么」的标记一点时间去加载。
    await page.waitForTimeout(700);

    // 「必须断言：没有脚本执行」——没有弹窗、没有可执行标记。
    expect(dialogs, `不应有 alert 弹出，实际 ${JSON.stringify(dialogs)}`).toEqual([]);
    expect(await unsafeMarkupInCanvas(page), '画面上不应留下任何可执行标记').toEqual([]);
    const svgHost = page.getByTestId('flow-svg');
    expect(await svgHost.locator('a').count(), 'SVG 不应有导航链接').toBe(0);
    expect(await svgHost.locator('[href]').count(), 'SVG 不应有 href 属性').toBe(0);
    expect(await svgHost.locator('foreignObject').count(), 'SVG 不应有 foreignObject').toBe(0);

    // 「必须排除：单层校验通过不能代替整链测试」——注入文本仍在，只是成了文字。
    // 整段删除会让「材料里写了什么」不可读，那是另一种失真。
    const drawn = (await drawnTexts(page)).join(' | ');
    expect(drawn, '注入片段应作为文字留下').toContain('securityLevel');
    /*
     * 这里断言的是「材料里的字还在，且没有被当成标记」。
     *
     * 实测（真实 Chromium，非推测）：`<` `>` 在编译期被换成 `&lt;` `&gt;`，浏览器再把它
     * 解码回 `<` `>`，所以屏幕上读到的是笔记里的原句。两条注意：
     *
     *  - **不能用「原样子串」**：长标签会被 Mermaid 折行成多个 tspan，而 `textContent`
     *    拼接时折行处的空格会消失（`img src=x onerror` 读成 `imgsrc=xonerror`）。这条是
     *    Mermaid 折行的既有行为，与转义无关，所以比较前把两侧空白都去掉。
     *  - **尖括号出现在文字里是预期的**，那正是「可辨认」；要排除的是它变成元素
     *    （由下面的 DOM 断言和 `unsafeMarkupInCanvas` 负责），不是它出现在文字里。
     */
    const flat = unwrapped(drawn);
    expect(flat, '节点文字应可辨认：材料里的词仍在').toContain(unwrapped('img src=x'));
    expect(flat, '节点文字应可辨认：属性片段仍在').toContain('onerror=alert(1)');
    expect(flat, '第二段注入文本同样应可辨认').toContain('第二大行');
    // 关键负向：文字里没有尖括号被吃成元素。`<img>` 若真成了元素，就既不在文字里，
    // 也会被 `unsafeMarkupInCanvas` 记下来；两处一起才说明「是文字，不是标记」。
    expect(await svgHost.locator('img').count(), 'SVG 不应有 img 元素').toBe(0);
    expect(await svgHost.locator('script').count(), 'SVG 不应有 script 元素').toBe(0);

    // 编译源码里同样不能出现指令：`click` 注入面正是「模型文本变成了语法」的形态。
    await page.getByTestId('flow-toggle-source').click();
    const source = (await page.getByTestId('flow-source').textContent()) ?? '';
    // 「单层校验不能代替整链」：断言**逐行的受限模板**，而不是扫关键词。标签里
    // 必然出现 `click`、`securityLevel`、`<script>` 这些词，扫词会既漏真问题、
    // 又冤枉合法材料；模板形状才说明「模型文本没有被读成语法」。
    assertLineGrammar(source, '画面源码');
    expect(source, '编译源码里不应有模型文本构成的指令行').not.toMatch(MERMAID_DIRECTIVE_LINE);
    // 反向：一句话都没被吃掉 —— 这些词仍作为**标签文字**存在。
    expect(source).toContain('securityLevel');
    expect(source).toContain('click');
    // 尖括号写成可解码实体，而不是删掉、也不是写成屏幕上会显示成 `&#60;` 的死文本。
    expect(source, '尖括号应写成可解码实体').toContain('&lt;script&gt;');
    expect(source, '不得再出现 `#NN;` 形态的死文本').not.toMatch(/#\d+;/u);

    // 「没有外部加载」——整条链上一次外网请求都没有。
    expect(traffic.externalRequests(), '整段操作不应触碰外网').toEqual([]);
    expect(traffic.blockedRequests(), '也不应有被拦下的外网尝试').toEqual([]);

    // ---- 导出的字节同样干净，且与画面同源 --------------------------------
    const mermaid = (await fetchFlowExport(page, headers, stored.id, 'mermaid')).body;
    // 导出文件带注释头，所以逐行语法只对头之后的部分断言。
    const headerEnd = mermaid.indexOf('\nflowchart ');
    expect(headerEnd, '导出文件应含出处头与流程图本体').toBeGreaterThan(0);
    assertLineGrammar(mermaid.slice(headerEnd + 1), '导出源码');
    expect(mermaid, '导出源码里不应有指令行').not.toMatch(MERMAID_DIRECTIVE_LINE);
    // 文字没有被删：`<` 写成可解码的 `&lt;`，导出的是可读原句（T064-C02「可辨认」）。
    expect(mermaid).toContain('securityLevel');
    expect(mermaid).toContain('&lt;script&gt;');
    expect(mermaid, '导出源码里不得出现 `#NN;` 死文本').not.toMatch(/#\d+;/u);
    expect(stored.content.nodes).toHaveLength(2);
  });

  test('T069-C03 异步切换：最后选择的那张图与它的来源一起生效', async ({ page }) => {
    await gotoInbox(page);

    // Two flows over two different records, each with a label unique to this run.
    const slowItem = await captureFlowSource(page, 'T069C03慢图来源');
    const fastItem = await captureFlowSource(page, 'T069C03快图来源');
    const slowLabel = uniqueLabel('慢图的唯一节点');
    const fastLabel = uniqueLabel('快图的唯一节点');

    // Seeded rather than generated: this case is about *reading* two stored rows in
    // an order the user controls, and the creation path is C01/C02/C05's subject.
    const slowId = seedFlowView(
      uniqueText('T069C03慢图'),
      [slowItem.id],
      seedFlowContent([slowItem.id], { title: '慢图', nodes: [['n1', slowLabel]] }),
    );
    // Seeded second, so the page adopts it on mount and the two selections below are
    // both deliberate user actions.
    const fastId = seedFlowView(
      uniqueText('T069C03快图'),
      [fastItem.id],
      seedFlowContent([fastItem.id], { title: '快图', nodes: [['n1', fastLabel]] }),
    );

    // Delay only the slow view's read, so the *older* request lands *later* — the
    // condition T066-C01/T069-C03 is about. `route.continue()` after the delay keeps
    // this a real request to the real server rather than a stubbed body.
    await page.route(`**/api/views/${slowId}`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.continue();
    });

    await page.goto('/flow');
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();

    const select = page.getByTestId('flow-view-select');
    await expect(select.locator(`option[value="${slowId}"]`)).toHaveCount(1);
    await expect(select.locator(`option[value="${fastId}"]`)).toHaveCount(1);

    // 快速打开两张保存的流程：先慢后快。
    await select.selectOption(slowId);
    await page.waitForTimeout(150);
    await select.selectOption(fastId);

    // 让慢响应真的落地（它必须在落地后仍然被丢弃）。
    await page.waitForTimeout(3500);

    // 「必须断言：显示最后选择且来源正确」——三条互相独立的证据：选择器的值、
    // 画出来的文字、来源面板指向的记录。
    await expect(select).toHaveValue(fastId);
    await waitForDrawnSvg(page);
    const drawn = (await drawnTexts(page)).join(' | ');
    expect(drawn, '最终画面应是后选的那张图').toContain(fastLabel);
    expect(drawn, '晚到的旧响应不得覆盖当前选择').not.toContain(slowLabel);

    // 「必须排除：图像与来源面板不能串位」——面板里的节点选项与来源必须同属快图。
    await expect(page.getByTestId('flow-source-node')).toHaveValue('n1');
    await expect(
      page.getByTestId('flow-source-node').locator('option:checked'),
      '面板选中的节点应是快图的节点',
    ).toHaveText(fastLabel);
    const panelItemIds = await page
      .getByTestId('flow-source-panel')
      .locator('[data-item-id]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-item-id')));
    expect(panelItemIds, '面板应列出快图的来源').toContain(fastItem.id);
    expect(panelItemIds, '面板不得出现慢图的来源').not.toContain(slowItem.id);

    // 逐元素确认画面是同一张：一个 SVG 根、一套互不重复的 DOM id（重复 id 会让
    // marker 互相借用，也就是「串图」的可见形态）。
    expect(await page.getByTestId('flow-svg').locator('svg').count()).toBe(1);
    const ids = await page
      .getByTestId('flow-svg')
      .evaluate((host) =>
        Array.from(host.querySelectorAll('svg [id]')).map((node) => node.getAttribute('id') ?? ''),
      );
    expect(new Set(ids).size, `SVG 里的 DOM id 必须互不重复：${JSON.stringify(ids)}`).toBe(ids.length);
  });

  test('T069-C04 离线恢复：断网重启后本地渲染，渲染不可用时文本降级可用', async ({
    page,
    traffic,
  }) => {
    resetRestartDataDir();
    const origin = restartOrigin();

    // The hostile label set is reused here on purpose: a restart case that asserted
    // only on a clean two-node diagram would leave the escape path untested across
    // the process boundary, which is where a cached artifact would show up.
    const hostileLabel = '重启后仍可读（括号）<img src=x onerror=alert(1)> 与 # 和 &';

    let server = await startServer();
    let viewId: string;
    let firstToken: string;
    let itemId: string;
    try {
      const headers = await headersAt(origin);
      firstToken = headers['x-brain-token']!;

      const created = await page.request.post(`${origin}/api/items`, {
        headers,
        data: {
          captureRequestId: crypto.randomUUID(),
          rawText: uniqueText('T069C04重启来源'),
          sourceType: 'other',
          sourceRef: null,
        },
      });
      expect(created.status(), 'POST /api/items 应返回 201').toBe(201);
      const envelope = (await created.json()) as { data: { item: { id: string } } };
      itemId = envelope.data.item.id;

      // Seeded into the restart server's own database — the only place it could be
      // read from after the process is replaced (`restartDataDir`).
      viewId = seedFlowViewIn(
        restartDataDir(),
        uniqueText('T069C04重启图'),
        [itemId],
        seedFlowContent([itemId], {
          title: '重启后的流程图',
          nodes: [
            ['n1', hostileLabel],
            ['n2', uniqueLabel('第二个节点')],
          ],
          edges: [['n1', 'n2', 'hypothesis', uniqueLabel('也许有先后')]],
        }),
      );
    } finally {
      await server.stop();
    }

    // A real stop, verified by the port rather than assumed.
    expect(await isPortFree(restartPort()), '旧进程应已停止').toBe(true);

    server = await startServer();
    try {
      // A new process mints a new session token, which is itself evidence that this
      // is not the same process answering (T007-R02).
      const after = await headersAt(origin);
      expect(after['x-brain-token'], '新进程应签发新的会话令牌').not.toBe(firstToken);

      const stored = await readFlowView(page, after, viewId);
      expect(stored.content.title).toBe('重启后的流程图');

      // 「必须排除：已生成资产不应依赖模型持续在线」——从这一刻起，每个非 loopback
      // 请求都会被 fixture 拦下，所以「没有模型请求」是一条被记录的清单。
      traffic.reset();
      await openSavedFlow(page, viewId, origin);
      await waitForDrawnSvg(page);

      // 「必须断言：本地渲染或安全文本降级可用」——先断言**本地渲染**这一支：
      // 重启后图是真的画出来了，文字仍是原文，注入片段也没有变成标记。
      const drawn = (await drawnTexts(page)).join(' | ');
      expect(drawn, '重启后应能在本地重新画出这张图').toContain('重启后仍可读');
      // 同 T069-C02：尖括号换成可解码实体后，屏幕上读到的就是笔记原句，所以断言的
      // 是「字还在」（比较前去掉 Mermaid 折行处会丢掉的空格），并用 DOM 侧确认它们
      // **没有**成为元素（那才是标记）。
      const flat = unwrapped(drawn);
      expect(flat, '注入片段应作为文字留下').toContain(unwrapped('img src=x'));
      expect(flat, '注入片段应作为文字留下').toContain('onerror=alert(1)');
      expect(
        await page.getByTestId('flow-svg').locator('img').count(),
        'SVG 不应有 img 元素',
      ).toBe(0);
      expect(drawn, '标点应保持可辨认').toContain('（括号）');
      expect(drawn, '推测边仍写明「推测：」').toContain('推测：');
      expect(await unsafeMarkupInCanvas(page)).toEqual([]);

      // 文本降级不是「失败时才出现」的备胎：节点与边的文字列表始终在，所以即使
      // 画不出来，材料仍然可读（T066-C05）。
      await expect(page.getByTestId('flow-fallback-node')).toHaveCount(2);
      await expect(page.getByTestId('flow-fallback-edge')).toHaveCount(1);
      await expect(page.getByTestId('flow-fallback-edge')).toContainText('推测：');

      // 来源仍在、可回溯。
      await expect(page.getByTestId('source-list-item').first()).toHaveAttribute(
        'data-item-id',
        itemId,
      );

      // ---- 降级支路：把渲染器要求失败，文本与来源必须仍然可用 --------------
      //
      // 用产品自己的测试接缝（`useMermaidRender` 的 failure flag）产生真实的
      // 「Mermaid 不可用」状态，而不是给组件喂一个预先坏掉的字符串——后者只能
      // 证明降级组件会渲染，证明不了失败路径通向它。
      await page.addInitScript(() => {
        (window as unknown as Record<string, unknown>)['__feiniForceFlowRenderFailure'] = true;
      });
      await openSavedFlow(page, viewId, origin);

      await expect(page.getByTestId('flow-fallback')).toBeVisible();
      await expect(page.getByTestId('flow-fallback-code')).toContainText('RENDER_FAILED');
      await expect(page.getByTestId('flow-fallback-node')).toHaveCount(2);
      await expect(page.getByTestId('flow-fallback-node').first()).toContainText('重启后仍可读');
      await expect(page.getByTestId('flow-fallback-edge')).toContainText('推测：');
      // 来源面板不依赖渲染，仍在列出来源。
      await expect(page.getByTestId('source-list-item').first()).toHaveAttribute(
        'data-item-id',
        itemId,
      );

      // 重试只在本地重跑：点一下，仍然失败（接缝还在），但没有任何生成请求。
      const generateBefore = traffic
        .apiRequests()
        .filter((request) => request.url.includes('/generate')).length;
      await page.getByTestId('flow-retry-render').click();
      await expect(page.getByTestId('flow-fallback')).toBeVisible();
      expect(
        traffic.apiRequests().filter((request) => request.url.includes('/generate')).length,
        '重试渲染不应请求模型',
      ).toBe(generateBefore);

      expect(
        traffic.apiRequests().filter((request) => request.url.includes('/generate')),
        '重启后打开与重试都不应再请求模型',
      ).toEqual([]);
      expect(traffic.blockedRequests(), '整段操作不应有任何外网请求被尝试').toEqual([]);
    } finally {
      await server.stop();
    }
  });

  test('T069-C05 格式导出：JSON 与 Mermaid 与库中一致且无秘密', async ({ page }) => {
    await gotoInbox(page);
    const headers = await authHeaders(page);

    const first = await captureFlowSource(page, 'T069C05甲');
    const second = await captureFlowSource(page, 'T069C05乙');
    const hypothesisLabel = uniqueLabel('这条边只是猜测');
    const viewId = seedFlowView(
      uniqueText('T069C05导出图'),
      [first.id, second.id],
      seedFlowContent([first.id, second.id], {
        title: '导出复核',
        nodes: [
          ['n1', uniqueLabel('复核甲')],
          ['n2', uniqueLabel('复核乙')],
        ],
        edges: [['n1', 'n2', 'hypothesis', hypothesisLabel]],
      }),
    );

    const stored = await readFlowView(page, headers, viewId);
    await openSavedFlow(page, viewId);
    await waitForDrawnSvg(page);

    // ---- JSON：机器可读，且与库里那张完全一致 ----------------------------
    const json = (await fetchFlowExport(page, headers, viewId, 'json')).body;
    const parsed = JSON.parse(json) as {
      schemaVersion: number;
      kind: string;
      viewId: string;
      generatedAt: string | null;
      exportedAt: string;
      contentHash: string | null;
      content: FlowViewRead['content'];
      hypotheses: { source: string; target: string; label: string }[];
      sourceSnapshot: { items: { id: string }[] };
      restoreScope: { kind: string; isFullBackup: boolean; note: string };
    };
    expect(parsed.kind).toBe('flow');
    expect(parsed.viewId).toBe(viewId);
    expect(parsed.schemaVersion).toBeGreaterThanOrEqual(1);
    // 「必须断言：一致」——导出的内容就是库里那一份，逐字段相等。
    expect(parsed.content).toEqual(stored.content);
    expect(parsed.contentHash).toBe(stored.contentHash);
    expect(parsed.generatedAt).toBe(stored.generatedAt);
    expect(parsed.sourceSnapshot.items.map((entry) => entry.id).sort()).toEqual(
      stored.sourceSnapshot.items.map((entry) => entry.id).sort(),
    );
    // 「必须断言：复核结构与来源」——推测边被单独指名，不靠消费者自己读 kind。
    expect(parsed.hypotheses).toEqual([{ source: 'n1', target: 'n2', label: hypothesisLabel }]);

    // ---- Mermaid：从 canonical 重新编译，并带上出处与不确定性 ------------
    const mermaid = (await fetchFlowExport(page, headers, viewId, 'mermaid')).body;
    expect(mermaid, 'Mermaid 源码必须由编译器生成，而不是模型给的文本').toContain('flowchart LR');
    expect(mermaid, '推测边必须保留虚线与「推测：」前缀').toContain('-.->');
    expect(mermaid).toContain('推测：');
    for (const node of stored.content.nodes) {
      expect(mermaid, `源码应包含节点「${node.label}」`).toContain(node.label);
    }
    // 出处块：视图 id、来源清单的 id 与版本。
    expect(mermaid).toContain(`%% 视图 ID：${viewId}`);
    expect(mermaid).toContain(`%% 来源：${stored.sourceSnapshot.items.length} 条笔记`);
    for (const entry of stored.sourceSnapshot.items) {
      expect(mermaid, '每一条来源都要写出 id 与版本').toContain(entry.id);
      expect(mermaid).toContain(`原文 v${entry.rawVersion}`);
    }
    // 「必须排除：下载成功不是数据正确的全部证据」——两种格式描述同一张图。一个丢掉
    // 分支的编译器 bug 会在这里表现为「JSON 里有、Mermaid 里没有」。
    for (const node of parsed.content.nodes) {
      expect(mermaid, `Mermaid 应包含 JSON 里的节点「${node.label}」`).toContain(node.label);
    }

    // 两种格式里两种是服务端产物；SVG 只在浏览器里由净化结果导出，所以服务端必须
    // 明确拒绝它，而不是静默换一个格式返回。
    //
    // 拒绝发生在**查询校验**这一层：`viewExportQuerySchema` 有意不把 `svg` 列进可请求
    // 格式（`src/domain/schemas/http.ts` 的注释：集合描述的是端点允许**请求**什么），
    // 所以信息给出的是真正支持的集合，而不是一份 SVG。断言就按这个实际行为写。
    const svgFromServer = await fetchFlowExport(page, headers, viewId, 'svg');
    expect(svgFromServer.status, 'SVG 不能由服务器直接导出').toBe(400);
    expect(svgFromServer.body, '拒绝信息应列出真正支持的格式').toContain('markdown');
    expect(svgFromServer.body, '拒绝信息应列出真正支持的格式').toContain('mermaid');
    expect(svgFromServer.body, '拒绝信息不得把 svg 说成可用格式').not.toMatch(/\bsvg\b/iu);
    expect(svgFromServer.body, '拒绝时不得返回任何可执行字节').not.toMatch(/<\s*svg\b/iu);

    // ---- 无秘密：请求本身用的凭据是最锋利的探针 ---------------------------
    const session = headers['x-brain-token']!;
    expect(session).toBeTruthy();
    for (const body of [json, mermaid]) {
      expect(body, '导出文件不得包含会话令牌').not.toContain(session);
      expect(body, '导出文件不得包含 API Key').not.toMatch(/sk-[A-Za-z0-9-]{8,}/u);
      expect(body).not.toMatch(/authorization/iu);
      expect(body).not.toMatch(/bearer\s/iu);
      expect(body, '导出文件不得包含 provider 地址').not.toMatch(/https?:\/\/[^\s"]*api[^\s"]*/iu);
    }

    // ---- 导出是只读的：内容不变，只有 exportedAt 变 -----------------------
    await page.waitForTimeout(1100);
    const secondRead = JSON.parse(
      (await fetchFlowExport(page, headers, viewId, 'json')).body,
    ) as { exportedAt: string; contentHash: string | null; generatedAt: string | null };
    expect(secondRead.contentHash).toBe(parsed.contentHash);
    expect(secondRead.generatedAt).toBe(parsed.generatedAt);
    expect(secondRead.exportedAt).not.toBe(parsed.exportedAt);

    const after = await readFlowView(page, headers, viewId);
    expect(after.revision, '导出不应改动那一行').toBe(stored.revision);
    expect(after.contentHash).toBe(stored.contentHash);
    expect(after.content).toEqual(stored.content);
  });

  test('T069-C06 范围记录：已启用与未启用项都如实写明', async ({ page }) => {
    await gotoInbox(page);
    const headers = await authHeaders(page);

    const source = await captureFlowSource(page, 'T069C06来源');
    const viewId = seedFlowView(
      uniqueText('T069C06范围图'),
      [source.id],
      seedFlowContent([source.id], {
        title: '范围图',
        nodes: [['n1', uniqueLabel('唯一节点')]],
      }),
    );

    await openSavedFlow(page, viewId);
    await waitForDrawnSvg(page);

    // ---- 已实现的格式各有真实入口与真实说明 -------------------------------
    await expect(page.getByTestId('export-flow-json')).toBeVisible();
    await expect(page.getByTestId('export-flow-mermaid')).toBeVisible();
    await expect(page.getByTestId('export-flow-svg')).toBeVisible();
    await expect(page.getByTestId('export-flow-hint-mermaid')).toContainText('不是模型直接给出的文本');

    // ---- 未启用/受限的项必须被写明，而不是留一个看起来可用的入口 ----------
    //
    // 单张视图的 JSON 不是整库备份：这条既要出现在**文件里**（文件才是被传来传去
    // 的东西），也要出现在**界面上**。
    await expect(page.getByTestId('export-flow-restore-note')).toContainText('不能用来恢复整个知识库');
    const json = JSON.parse((await fetchFlowExport(page, headers, viewId, 'json')).body) as {
      restoreScope: { kind: string; isFullBackup: boolean; note: string };
    };
    expect(json.restoreScope.isFullBackup, '单张流程导出不得自称整库备份').toBe(false);
    expect(json.restoreScope.kind).toBe('single-view');
    expect(json.restoreScope.note).toContain('不是完整知识库备份');

    // 服务端不接受 svg（T068-R04 的边界），这是「未启用」的一项，必须被明确拒绝。
    expect((await fetchFlowExport(page, headers, viewId, 'svg')).status).toBe(400);
    expect((await fetchFlowExport(page, headers, viewId, 'pdf')).status, '未知格式同样应被拒绝').toBe(
      400,
    );

    // 打开与导出都不计费：这条视图可读，且整段操作没有一次生成请求。
    expect(await listFlowViewIds(page, headers)).toContain(viewId);

    // ---- 报告：哪些执行了、哪些被外部条件挡住 ----------------------------
    //
    // 这份记录就是 T069-C06 要的东西：把「没做的」写成具名项，而不是让「有些用例
    // 没跑」消失在总结里。
    const report = {
      executed: [
        'T069-C01 证据门槛与降级（无依据 → hypothesis，有依据 → causal）',
        'T069-C02 生成→编译→渲染→净化的注入全链（页面层）',
        'T069-C03 异步切换：最后选择生效且来源不串位',
        'T069-C04 重启后本地渲染与渲染失败时的文本降级',
        'T069-C05 JSON 与 Mermaid 导出与库中一致且无秘密',
        'T069-C06 已启用格式与未启用项如实写明',
      ],
      blocked: {
        '真实模型的语义克制（T069-C01 的语义一半）':
          'BLOCKED_BY_EXTERNAL_CREDENTIAL：需要用户自己的模型连接，本机没有可用 Key',
      },
      /** 函数层证据在其它入口，这里只登记位置，不重复声称。 */
      coveredElsewhere: {
        'T065-C01…C04 与 T066-C01/C06（函数层，真实 Chromium）':
          'tests/browser/flow-render-security.test.ts',
        'T065-C05/C06（页面层来源回跳与净化后导出）': 'tests/e2e/flow-security.spec.ts',
        'T067 保存/来源/新鲜度/不计费': 'tests/integration/flow-history.test.ts',
        'T068 导出与整库备份的区别': 'tests/unit/flow-export.test.ts',
      },
    } as const;

    // 每一项要么被执行，要么被具名阻塞；没有第三种含糊状态。
    expect(report.executed).toHaveLength(6);
    expect(Object.keys(report.blocked)).toHaveLength(1);
    expect(report.blocked['真实模型的语义克制（T069-C01 的语义一半）']).toContain('BLOCKED');
    expect(Object.keys(report.coveredElsewhere)).toHaveLength(4);
  });

  test('T069-R03 反例：非法答案与边界注入都在服务端被拒，且不产生视图', async ({ page }) => {
    await gotoInbox(page);
    const headers = await authHeaders(page);

    const selected = [
      (await captureFlowSource(page, 'T069R03甲')).id,
      (await captureFlowSource(page, 'T069R03乙')).id,
    ];
    // A real row that exists but is *not* selected, so 「引用了未选择来源」 is about
    // the selection rule rather than about a nonexistent UUID.
    const unselected = (await captureFlowSource(page, 'T069R03未选中')).id;
    const slots = { selected, unselected };

    const cases = flowCases();
    const before = await listFlowViewIds(page, headers);
    const names = Object.keys(cases.invalid);
    // 覆盖重复 ID、未知端点、超限、引号换行、click 注入这几类（T069-R03）。
    expect(names.length, '反例样本集不应缩小').toBeGreaterThanOrEqual(10);

    for (const name of names as (keyof typeof cases.invalid)[]) {
      const sample = cases.invalid[name];
      const outcome = await scriptedFlowGeneration(page, headers, {
        itemIds: selected,
        body: invalidAnswerBody(name, slots),
        // Off, so a malformed sample costs exactly one scripted reply rather than
        // needing a second one for the repair request.
        schemaRepairEnabled: false,
      });

      // 失败就是失败，不是空成功。
      expect(outcome.state, `样本「${name}」应被拒绝`).toBe('failed');
      expect(outcome.viewId, `样本「${name}」不应产生视图`).toBeFalsy();

      // 并且要指向它违反的那条规则，而不是笼统报错——否则一个回归会被另一个检查项
      // 的错误文本掩盖。
      const run = await readFlowRun(page, headers, outcome.runId);
      const text = `${run.error?.message ?? ''}${run.error?.code ?? ''}`;
      expect(text.length, `样本「${name}」的错误文本不应为空`).toBeGreaterThan(0);
      expect(
        text.includes(sample.expectMessage) || run.error?.code === 'STRUCTURED_INVALID',
        `样本「${name}」的错误应说明原因，实际：${text}`,
      ).toBe(true);
    }

    // 一个视图都没多出来。
    expect(await listFlowViewIds(page, headers)).toEqual(before);

    // ---- 引号换行这一条必须**成功**，而不是被拒 --------------------------
    //
    // 转义是编译期的责任；把带标点的合法答案拒掉才是缺陷（T064-C02「可辨认」）。
    const accepted = await scriptedFlowGeneration(page, headers, {
      itemIds: selected,
      body: JSON.stringify({
        title: '标点样本',
        direction: 'LR',
        nodes: [
          { id: 'n1', label: '换行\n第二大行 "引号" 与 `反引号`', itemIds: [selected[0]] },
          { id: 'n2', label: '第二个节点（括号）[方括号] {花括号} # 和 &', itemIds: [selected[1]] },
        ],
        edges: [
          {
            source: 'n1',
            target: 'n2',
            kind: 'sequence',
            label: '顺序：先看这一条',
            itemIds: [selected[0], selected[1]],
            relationIds: [],
          },
        ],
      }),
    });
    expect(accepted.state, '带标点的合法答案必须被接受').toBe('succeeded');
    const storedPunctuation = await readFlowView(page, headers, accepted.viewId!);
    // 换行被折叠成空格（不会把标签变成第二行语法），其余标点原样保留。
    expect(storedPunctuation.content.nodes[0]!.label).toContain('引号');
    expect(storedPunctuation.content.nodes[0]!.label).not.toContain('\n');
    expect(storedPunctuation.content.nodes[1]!.label).toContain('（括号）');
    expect(storedPunctuation.content.nodes[1]!.label).toContain('# 和 &');

    await openSavedFlow(page, accepted.viewId!);
    await waitForDrawnSvg(page);
    const drawn = (await drawnTexts(page)).join(' | ');
    // 屏幕上是可辨认的原文。`&` 是唯一必须替换的普通标点（它是实体起始字符），
    // 浏览器解码后画出来的仍是 `&`。
    expect(drawn).toContain('（括号）');
    expect(drawn).toContain('[方括号]');
    expect(drawn).toContain('# 和 &');
    // 引号换成可见的全角写法：没有可用实体，这是唯一不可避免的字形替换。
    expect(drawn, '引号应以可辨认的全角写法画出').toContain('\uff02');
    // 负向：不得出现任何 `#NN;` 死文本（那些会原样显示成 `&#40;`）。
    expect(drawn, '不应出现 `#NN;` 死文本').not.toMatch(/#\d+;/u);
    expect(drawn, '不应出现被编码掉的括号').not.toContain('#40;');
    expect(drawn, '不应出现被编码掉的方括号').not.toContain('#91;');
    expect(drawn, '不应出现被编码掉的井号').not.toContain('#35;');
    // 单一换行不产生第二个节点声明：仍只有两个节点组。
    expect(await page.getByTestId('flow-svg').locator('g.node').count()).toBe(2);
  });
});
