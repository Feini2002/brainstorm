import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, gotoInbox, test } from './support/fixtures';
import { seedItemViaApi, uniqueText } from './support/harness';
import { seedView, tagItems, withSeedDb } from './support/seedData';
import {
  resetRestartDataDir,
  restartOrigin,
  startServer,
} from './support/restartServer';

/**
 * 导出 → 校验 → 恢复到空库：T078-R01「导出恢复」与 T084-R05 用户旅程的回归。
 *
 * 这个文件补的是**入口**那一半。`/api/export`、`/api/import/validate`、`/api/import`
 * 在 T070–T072 各有集成测试，但设置页此前只有一句「本页暂不提供按钮」（G-1），所以
 * 那两个场景只能拿 `page.request` 直打 API——那不是用户旅程（D1 采纳的理由）。
 *
 * 六个选择值得写下来，它们都是规则而不是风格：
 *
 *  1. **从设置页的按钮走。** 导出的字节来自真实的 `download` 事件；恢复走
 *     `<input type="file">` → 校验 → 勾选 → 提交。`page.request` 绕过的正是这一段接线，
 *     而「按钮有没有真的接上」是本文件唯一的主题（T078-C03）。
 *  2. **写进另一个进程的空库。** 用第二个 `startServer()` 指向 `.data-restart`：
 *     「恢复到空知识库」不是清空当前库装出来的假象，而是真把一份备份写进另一个数据库文件。
 *     写完之后**不重启**就按 id 读回，才是「写进去了」而不是「响应说写进去了」（T078-C02）。
 *  3. **恢复前先读一次确认目标真的是空的**，不靠注释声称。
 *  4. **Key 两侧都断言。** 扫导出字节（不含 Key 形态、不含 `apiKey`/`baseUrl` 字段），
 *     恢复后再读一次设置确认 `apiKeyConfigured` 仍为 false。真正的 Key 从不进入本测试。
 *  5. **非空库的拒绝分两层，且都断言。** `/api/import/validate` 对非空目标发布
 *     `valid: false`（`targetProblems`），所以界面在校验那一步就会拦住；直接打
 *     `/api/import` 则得到 409 `IMPORT_NONEMPTY`。两层守卫分开证明，不把前端的禁用
 *     当成服务端的约束（T078-R02；`importKnowledge` 在事务内二次检查）。
 *  6. **不伪造文件。** 选中的文件就是导出真正产出的字节；写一份手搓的「像备份」的 JSON
 *     只能证明 fixture 会被读。
 *
 * 目标库是 `.data-restart`，每条用例开头 `resetRestartDataDir()` 清空它，所以本文件
 * 既不依赖也不影响共享库 `.data`。「坏文件」与「不可读文件」两条用共享库的会话，不发恢复请求。
 */

/** 从设置页点「导出整库」，返回真实下载下来的字节与建议文件名。 */
async function exportViaSettings(
  page: import('@playwright/test').Page,
): Promise<{ bytes: string; filename: string }> {
  await page.goto('/settings');
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('backup-export').click();
  const download = await downloadPromise;
  const file = await download.path();
  expect(file, '导出应真的产生一个下载文件').toBeTruthy();
  return { bytes: readFileSync(file!, 'utf8'), filename: download.suggestedFilename() };
}

const tempFiles: string[] = [];

test.afterAll(() => {
  for (const file of tempFiles.splice(0)) {
    rmSync(file, { force: true });
  }
});

/**
 * 把一份备份写进临时文件，好让 `<input type="file">` 选到它。
 *
 * 位置在仓库外：这些字节是**用户数据**（原文与标签），不能落进工作区，否则一次
 * `git add -A` 就可能把它提交（T078-R06 的同一条理由）。用完由 `afterAll` 删除。
 */
function writeTempBundle(bytes: string, label: string): string {
  const dir = path.join(process.env.LOCALAPPDATA ?? process.cwd(), 'Temp');
  const file = path.join(dir, `${label}-${Date.now()}-${process.pid}.json`);
  writeFileSync(file, bytes, 'utf8');
  tempFiles.push(file);
  return file;
}

/**
 * Headers for a *specific* origin's server.
 *
 * `harness.authHeaders` is hard-wired to the shared suite origin, and the restart
 * process has its own session token (T007-R02), so it cannot be reused here — the
 * token from one process is exactly what the other process rejects.
 */
async function sessionHeaders(origin: string): Promise<Record<string, string>> {
  const response = await fetch(`${origin}/api/session`, {
    headers: { host: new URL(origin).host, origin },
  });
  expect(response.ok, `GET ${origin}/api/session 必须成功`).toBe(true);
  const envelope = (await response.json()) as { ok: boolean; data: { token: string } };
  return {
    host: new URL(origin).host,
    origin,
    'content-type': 'application/json',
    'x-brain-token': envelope.data.token,
  };
}

test.describe('整库导出与空库恢复', () => {
  /**
   * `@narrow`: the settings backup controls are explicitly in the narrow project's
   * remit — the import button sits behind a `label` + hidden `input[type=file]`,
   * which is the kind of layout that can break when the window shrinks.
   */
  test('T078-C01 @narrow 导出恢复：设置页导出整库，在另一个进程的空库上恢复，原文与视图按 id 读回', async ({
    page,
    traffic,
  }) => {
    await gotoInbox(page);

    // ---- 源库：一条原文 + 一个标签 + 一张视图 ------------------------------
    const text = uniqueText('备份恢复-原文');
    const itemId = await seedItemViaApi(page, { rawText: text });
    const tagLabel = uniqueText('备份标签');
    tagItems([itemId], tagLabel);
    const viewId = withSeedDb((db) =>
      seedView(db, {
        name: uniqueText('备份视图'),
        kind: 'mindmap',
        itemIds: [itemId],
        content: {
          title: '备份视图',
          nodes: [
            { id: 'm1', parentId: null, label: '备份视图', itemIds: [itemId], kind: 'group' },
            { id: 'm2', parentId: 'm1', label: '唯一分支', itemIds: [itemId], kind: 'note' },
          ],
        },
      }),
    );

    // ---- 导出：走设置页的按钮，断言的是字节 -------------------------------
    const exported = await exportViaSettings(page);
    expect(exported.filename, '导出应带一个 .json 文件名').toMatch(/\.json$/iu);

    const bundle = JSON.parse(exported.bytes) as {
      schemaVersion: number;
      data: {
        knowledgeItems: { id: string; rawText: string }[];
        tags: unknown[];
        itemTags: unknown[];
        relations: unknown[];
        views: { id: string }[];
      };
    };
    expect(bundle.schemaVersion, '备份 schemaVersion 应为 1').toBe(1);
    const exportedItem = bundle.data.knowledgeItems.find((entry) => entry.id === itemId);
    expect(exportedItem, '导出的字节里应有那条原文').toBeTruthy();
    expect(exportedItem!.rawText).toBe(text);
    expect(bundle.data.views.map((entry) => entry.id)).toContain(viewId);

    // 「逻辑导出不含 Key」是 P0 的验收条件：直接扫字节，而不是相信界面文案。
    expect(exported.bytes).not.toMatch(/sk-[A-Za-z0-9-]{8,}/u);
    expect(exported.bytes).not.toMatch(/authorization/iu);
    expect(exported.bytes).not.toContain('apiKey');
    expect(exported.bytes).not.toContain('baseUrl');

    // ---- 目标：另起一个进程，指向一个真的空库 ------------------------------
    resetRestartDataDir();
    const origin = restartOrigin();
    const server = await startServer();
    try {
      // 空库前置：读一次确认，不靠注释声称。
      const before = await page.request.get(`${origin}/api/items`, {
        headers: await sessionHeaders(origin),
        params: { limit: 1 },
      });
      expect(before.status()).toBe(200);
      const beforeBody = (await before.json()) as { data: { items: unknown[] } };
      expect(beforeBody.data.items, '恢复前目标库必须是空的').toEqual([]);

      // 在目标进程的页面上操作：令牌由该页自己的会话给出，与源库无关。
      await page.goto(`${origin}/settings`);
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();

      const filePath = writeTempBundle(exported.bytes, 't078-backup');
      await page.getByTestId('backup-file').setInputFiles(filePath);
      await expect(page.getByTestId('backup-picked-file')).toBeVisible();
      await page.getByTestId('backup-validate').click();

      const counts = page.getByTestId('backup-validation-counts');
      await expect(counts).toBeVisible({ timeout: 30_000 });
      // 校验报告必须真的数了这份备份，而不是笼统地说「通过」。
      await expect(counts).toHaveAttribute('data-valid', 'true');
      // 断言的是「界面报的数 = 这份备份字节里的数」，不是写死的 1：备份是**整库**快照，
      // 全量跑时共享库已被前面的 spec 写入几百条。写死 `条目 1` 只在单跑该文件时成立，
      // 那是用例在依赖上一个 spec 的残留 —— 正是 T078 要求排除的耦合。
      const expectedCounts = {
        items: bundle.data.knowledgeItems.length,
        tags: bundle.data.tags.length,
        itemTags: bundle.data.itemTags.length,
        relations: bundle.data.relations.length,
        views: bundle.data.views.length,
      };
      // 这一份备份是我们自己刚导出的，所以它至少含刚种下的那条原文与那张视图。
      expect(expectedCounts.items, '这份备份至少应有刚种下的那条原文').toBeGreaterThanOrEqual(1);
      expect(expectedCounts.views, '这份备份至少应有刚种下的那张视图').toBeGreaterThanOrEqual(1);
      await expect(counts).toContainText(`条目 ${expectedCounts.items}`);
      await expect(counts).toContainText(`视图 ${expectedCounts.views}`);
      // 带上分隔符，否则 `标签 6` 会被 `标签连接 309` 误匹配成通过。
      await expect(counts).toContainText(`标签 ${expectedCounts.tags} ·`);
      await expect(counts).toContainText(`标签连接 ${expectedCounts.itemTags} ·`);
      await expect(counts).toContainText(`关系 ${expectedCounts.relations} ·`);

      // 恢复必须是一次明确动作：未勾选前按钮不可点。
      await expect(page.getByTestId('backup-restore')).toBeDisabled();
      await page.getByTestId('backup-confirm-empty').check();
      await page.getByTestId('backup-restore').click();

      await expect(page.getByTestId('backup-restore-notice')).toContainText('已恢复到空知识库', {
        timeout: 30_000,
      });

      // ---- 不重启，直接按 id 读回：证明写进了那个库，而不是只在响应里 ------
      const headers = await sessionHeaders(origin);
      const reloaded = await page.request.get(`${origin}/api/items/${itemId}`, { headers });
      expect(reloaded.status(), '恢复后应能按原 id 读回条目').toBe(200);
      // `GET /api/items/:id` answers with the item DTO directly as `data` (T006
      // envelope), not a wrapper object — so this reads `data.rawText`.
      const reloadedBody = (await reloaded.json()) as { data: { rawText: string } };
      expect(reloadedBody.data.rawText, '原文必须逐字一致').toBe(text);

      const views = await page.request.get(`${origin}/api/views`, {
        headers,
        params: { kind: 'mindmap', limit: 50 },
      });
      const viewsBody = (await views.json()) as { data: { views: { id: string }[] } };
      expect(viewsBody.data.views.map((entry) => entry.id)).toContain(viewId);

      // 标签也回来了（引用重建的依据），并且是按标签能查回同一条。
      const tags = await page.request.get(`${origin}/api/tags`, { headers });
      expect(tags.status()).toBe(200);
      const tagsBody = (await tags.json()) as { data: { tags: { label: string }[] } };
      expect(tagsBody.data.tags.map((entry) => entry.label)).toContain(tagLabel);

      // 「恢复只写知识数据」：设置区仍没有 Key。
      const settings = await page.request.get(`${origin}/api/settings/llm`, { headers });
      expect(settings.status()).toBe(200);
      const settingsBody = (await settings.json()) as { data: { apiKeyConfigured: boolean } };
      expect(settingsBody.data.apiKeyConfigured, '恢复不得带回 Key').toBe(false);
    } finally {
      await server.stop();
    }

    // 整段旅程（含跨进程）没有任何非回环请求发出。
    expect(traffic.blockedRequests(), '导出恢复不应尝试任何外部主机').toEqual([]);
  });

  test('T078-C03 非空库：校验即拦下，直接提交仍被服务端 409 拒绝，界面不提供合并', async ({
    page,
  }) => {
    await gotoInbox(page);

    const sourceText = uniqueText('非空拒绝-源');
    await seedItemViaApi(page, { rawText: sourceText });
    const exported = await exportViaSettings(page);

    resetRestartDataDir();
    const origin = restartOrigin();
    const server = await startServer();
    try {
      const headers = await sessionHeaders(origin);

      // 目标库先放入一条记录，使它非空。
      const existingText = uniqueText('非空拒绝-已有');
      const created = await page.request.post(`${origin}/api/items`, {
        headers,
        data: {
          captureRequestId: crypto.randomUUID(),
          rawText: existingText,
          sourceType: 'other',
          sourceRef: null,
        },
      });
      expect(created.status(), '目标库应先有一条记录').toBe(201);

      // 第一层：界面上校验这一步就报 valid=false，且不给勾选。
      await page.goto(`${origin}/settings`);
      const filePath = writeTempBundle(exported.bytes, 't078-nonempty');
      await page.getByTestId('backup-file').setInputFiles(filePath);
      await page.getByTestId('backup-validate').click();

      const counts = page.getByTestId('backup-validation-counts');
      await expect(counts).toHaveAttribute('data-valid', 'false', { timeout: 30_000 });
      // 「目标非空」是校验报告里的一条**结构问题**（`targetProblems` 的 path 是
      // `(target)`），所以原因出现在错误列表里，而不是计数行上。
      await expect(page.getByTestId('backup-errors')).toContainText('只支持恢复到空知识库');
      await expect(page.getByTestId('backup-confirm-empty')).toBeDisabled();
      await expect(page.getByTestId('backup-restore')).toBeDisabled();
      // 界面上那句「不会合并、也不会覆盖」是在**说明**能力边界；要断言的是没有
      // 任何一个**控件**提供合并或覆盖——文案与能力是两件事。
      await expect(page.getByRole('button', { name: /合并|覆盖|强制/u })).toHaveCount(0);

      // 第二层：绕过界面直接提交，服务端自己也会拒绝（前端禁用不是约束）。
      const parsed = JSON.parse(exported.bytes) as Record<string, unknown>;
      const validated = await page.request.post(`${origin}/api/import/validate`, {
        headers,
        data: { bundle: parsed },
      });
      expect(validated.status()).toBe(200);
      const validatedBody = (await validated.json()) as { data: { bundleHash: string } };

      const committed = await page.request.post(`${origin}/api/import`, {
        headers,
        data: {
          bundle: parsed,
          expectedBundleHash: validatedBody.data.bundleHash,
          confirmEmptyRestore: true,
        },
      });
      expect(committed.status(), '非空库提交应被拒绝').toBe(409);
      const committedBody = (await committed.json()) as { error: { code: string } };
      expect(committedBody.error.code).toBe('IMPORT_NONEMPTY');

      // 哈希不符也必须被拒：客户端不能校验一份、提交另一份（T072-R01）。
      const mismatched = await page.request.post(`${origin}/api/import`, {
        headers,
        data: {
          bundle: parsed,
          expectedBundleHash: '0'.repeat(64),
          confirmEmptyRestore: true,
        },
      });
      expect(mismatched.status(), '哈希不符应被拒绝').toBe(422);
      const mismatchedBody = (await mismatched.json()) as { error: { code: string } };
      expect(mismatchedBody.error.code).toBe('IMPORT_INVALID');

      // 目标库没有被改动：那条记录还在，备份里的内容一条都没进来。
      const items = await page.request.get(`${origin}/api/items`, {
        headers,
        params: { limit: 50 },
      });
      const body = (await items.json()) as { data: { items: { rawText: string }[] } };
      expect(body.data.items.map((entry) => entry.rawText)).toContain(existingText);
      expect(body.data.items.map((entry) => entry.rawText)).not.toContain(sourceText);
    } finally {
      await server.stop();
    }
  });

  test('T078-C03 坏备份：能解析但不是备份的 JSON，校验在服务端返回不合法', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();

    // 目标库是共享库（非空也无妨）：这条只走 `/validate`，不提交。
    // 「能解析但不是备份」正是校验（而不是 JSON.parse）要拦的对象。
    const filePath = writeTempBundle(JSON.stringify({ hello: 'world' }), 't078-bad');
    await page.getByTestId('backup-file').setInputFiles(filePath);
    await expect(page.getByTestId('backup-picked-file')).toBeVisible();
    await page.getByTestId('backup-validate').click();

    const counts = page.getByTestId('backup-validation-counts');
    await expect(counts).toHaveAttribute('data-valid', 'false', { timeout: 30_000 });
    // 结构错误要逐条列出来（version 字段缺失等），让用户知道该改哪里。
    await expect(page.getByTestId('backup-errors')).toContainText('schemaVersion');
    // 校验未通过时不允许恢复，且没有可勾的确认框。
    await expect(page.getByTestId('backup-confirm-empty')).toBeDisabled();
    await expect(page.getByTestId('backup-restore')).toBeDisabled();
  });

  test('T078-C03 不可读文件：本地就报错，且不发出任何校验请求', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();

    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/import/')) requests.push(request.url());
    });

    const filePath = writeTempBundle('{ this is not json', 't078-unreadable');
    await page.getByTestId('backup-file').setInputFiles(filePath);

    // 本地读取失败：错误出现在「选择文件」那一步，不是服务端返回的。
    await expect(page.getByTestId('backup-file-error')).toContainText('不是合法的 JSON');
    await expect(page.getByTestId('backup-validate')).toBeDisabled();
    await page.waitForTimeout(300);
    expect(requests, '无法解析的文件不应发出任何校验或恢复请求').toEqual([]);
  });
});
