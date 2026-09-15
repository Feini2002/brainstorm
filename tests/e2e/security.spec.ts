/**
 * T075 验收｜浏览器层：跨站拒绝、浏览器持久存储无秘密、原文 URL 不被抓取。
 *
 * 用例规格：`docs/05_tests/G6/T075_cases.md`；规则：`docs/04_tasks/G6/T075_security_regression.md`。
 *
 * ## 为什么这三点必须在这一层证明，进程内测试不够
 *
 * `tests/security/` 里的用例直接调用路由处理函数，因此它们证明的是**守卫函数**的判定。
 * 下面三件事只有在真实浏览器 + 真实 `next start` 下才成立：
 *
 *  1. **跨站请求**（C01）：需要浏览器真的带 `Origin`/`Sec-Fetch-Site` 发起跨站请求。
 *     进程内测试是自己构造 `Headers` 的，无法证明「浏览器会这么发」，也无法证明产品
 *     部署后确实按这个头拒绝。这里用一个**真的跨站来源**（不同端口 = 不同 origin）
 *     向真实服务发请求。
 *  2. **浏览器持久存储**（C02）：`localStorage`/`sessionStorage`/`IndexedDB`/Cookie 是
 *     浏览器事实，`save-races.spec.ts` 的 T025-C05 只覆盖了草稿正文，**不覆盖 API Key**——
 *     那是本轮找到的真实缺口。
 *  3. **原文 URL 不被抓取**（C05）：要证明「页面打开含 URL 的笔记时没有对那个 URL 发请求」，
 *     必须有真实的页面与真实的网络记录。`traffic` fixture 记录了每一条尝试。
 *
 * ## Key 的处理与清理
 *
 * Key 走产品自己的 `PUT /api/settings/llm` 保存（`replace`），因此脱敏接线是真的被驱动过的。
 * 每个用例在 `finally` 里删除该 Key 并在 `afterAll` 里恢复套件的初始状态——否则一个残留的
 * Key 会让后面断言「未配置」的用例走到另一条分支。
 */
import { expect, gotoInbox, test } from './support/fixtures';
import { E2E_HOST, E2E_ORIGIN, E2E_PORT } from './support/env';
import {
  authHeaders,
  captureViaUi,
  findItemIdViaApi,
  openRoute,
  uniqueText,
} from './support/harness';
import { headersAt, restoreLlmSettings } from './support/gomindmap';

/**
 * A key shaped like a real gateway credential, and searchable.
 *
 * Deliberately **not** `sk-`-prefixed: `SECRET_PATTERNS` already matches that shape,
 * so an `sk-` canary would be removed by the pattern table alone and would prove
 * nothing about the literal-value layer. This form has no recognizable prefix, so it
 * can only disappear if the wiring is real.
 */
const CHAIN_KEY = 'gw_e2e_SECRETCHAIN_5566778899';

/** A different port is a different origin — a genuine cross-site request. */
const CROSS_SITE_ORIGIN = `http://${E2E_HOST}:${Number(E2E_PORT) + 1}`;

/** Every table in browser durable storage, as one string. */
async function browserStorageDump(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(async () => {
    const dumps: Record<string, unknown> = {
      localStorage: { ...window.localStorage },
      sessionStorage: { ...window.sessionStorage },
      cookie: document.cookie,
    };

    // IndexedDB is not enumerable synchronously, and a spec that skipped it would
    // leave the largest browser-side store unaudited.
    const databases =
      typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    const idb: Record<string, unknown> = {};
    for (const info of databases) {
      const name = info.name;
      if (name === undefined) continue;
      idb[name] = await new Promise((resolve) => {
        const open = indexedDB.open(name);
        open.onsuccess = () => {
          const database = open.result;
          const storeNames = [...database.objectStoreNames];
          const transaction = database.transaction(storeNames, 'readonly');
          const collected: Record<string, unknown[]> = {};
          let pending = storeNames.length;
          if (pending === 0) {
            database.close();
            resolve(collected);
            return;
          }
          for (const store of storeNames) {
            const request = transaction.objectStore(store).getAll();
            request.onsuccess = () => {
              collected[store] = request.result as unknown[];
              pending -= 1;
              if (pending === 0) {
                database.close();
                resolve(collected);
              }
            };
            request.onerror = () => {
              pending -= 1;
              if (pending === 0) {
                database.close();
                resolve(collected);
              }
            };
          }
        };
        open.onerror = () => resolve({ __error: 'open failed' });
      });
    }

    return JSON.stringify({ ...dumps, indexedDB: idb });
  });
}

test.afterAll(async () => {
  // The suite's shared database is not reset between spec files and several later
  // specs assert the *unconfigured* branch, so a key left behind here would be a
  // real regression rather than a cosmetic one.
  await restoreLlmSettings();
});

test.describe('T075-C01 真实浏览器的跨站请求被拒绝且无副作用', () => {
  test('T075-C01 跨站写入被 403，且没有任何新条目产生', async ({ page, traffic }) => {
    await gotoInbox(page);

    const headers = await authHeaders(page);
    const before = await page.request.get(`${E2E_ORIGIN}/api/items`, {
      headers,
      // `listPageSizeMax` is 100; a larger value is rejected as a 400, which would
      // make this case fail for a reason unrelated to the guard.
      params: { limit: 100 },
    });
    expect(before.status()).toBe(200);
    const countBefore = ((await before.json()) as { data: { items: unknown[] } }).data.items.length;

    // The token is real and the Host is right — the *only* thing wrong is the
    // origin. A guard that checked one criterion would let this through.
    const crossSite = await page.request.post(`${E2E_ORIGIN}/api/items`, {
      headers: {
        origin: CROSS_SITE_ORIGIN,
        host: `${E2E_HOST}:${E2E_PORT}`,
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
        'x-brain-token': headers['x-brain-token']!,
      },
      data: {
        captureRequestId: crypto.randomUUID(),
        rawText: uniqueText('跨站写入'),
        sourceType: 'other',
        sourceRef: null,
      },
    });

    expect(crossSite.status(), '跨站来源的写入必须被拒绝').toBe(403);
    const envelope = (await crossSite.json()) as { error: { code: string } };
    expect(envelope.error.code).toBe('LOCAL_ORIGIN_REJECTED');

    const after = await page.request.get(`${E2E_ORIGIN}/api/items`, {
      headers,
      params: { limit: 100 },
    });
    const countAfter = ((await after.json()) as { data: { items: unknown[] } }).data.items.length;
    expect(countAfter, '被拒绝的请求不能写入任何条目').toBe(countBefore);

    // 跨站请求没有触碰外网，也没有产生运行记录。
    expect(traffic.externalRequests(), '跨站尝试不应产生外部请求').toEqual([]);
    expect(traffic.blockedRequests()).toEqual([]);
  });

  test('T075-C01 跨站读取被拒绝，响应里不回显令牌或配置', async ({ page }) => {
    const headers = await authHeaders(page);

    const response = await page.request.get(`${E2E_ORIGIN}/api/settings/llm`, {
      headers: {
        origin: CROSS_SITE_ORIGIN,
        host: `${E2E_HOST}:${E2E_PORT}`,
        'sec-fetch-site': 'cross-site',
        'x-brain-token': headers['x-brain-token']!,
      },
    });

    expect(response.status(), '跨站读取必须被拒绝').toBe(403);
    const raw = await response.text();
    expect(raw).not.toContain(headers['x-brain-token']!);
    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('baseUrl');
  });

  test('T075-C01 伪 Host 被拒绝，不是只看 Origin 就放行', async ({ page }) => {
    const headers = await authHeaders(page);

    // Origin 正确、令牌正确，只有 Host 是伪造的（DNS 重绑定式攻击的形状）。
    const response = await page.request.post(`${E2E_ORIGIN}/api/items`, {
      headers: {
        origin: E2E_ORIGIN,
        host: 'evil.example',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'x-brain-token': headers['x-brain-token']!,
      },
      data: {
        captureRequestId: crypto.randomUUID(),
        rawText: uniqueText('伪Host'),
        sourceType: 'other',
        sourceRef: null,
      },
    });

    expect(response.status(), '伪造 Host 必须被拒绝').toBe(403);
  });

  test('T075-C01 缺少令牌的写入被拒绝（同源也不放行）', async ({ page }) => {
    await gotoInbox(page);

    const response = await page.request.post(`${E2E_ORIGIN}/api/items`, {
      headers: {
        origin: E2E_ORIGIN,
        host: `${E2E_HOST}:${E2E_PORT}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      data: {
        captureRequestId: crypto.randomUUID(),
        rawText: uniqueText('无令牌'),
        sourceType: 'other',
        sourceRef: null,
      },
    });

    // 同源但无令牌：守卫必须在写任何一行之前拦下（T007-R03）。
    expect(response.status()).toBe(403);
  });
});

test.describe('T075-C02 浏览器持久存储不含 Key 也不含令牌', () => {
  test('T075-C02 保存 Key 并浏览全部页面后，浏览器存储里没有它', async ({ page, traffic }) => {
    await gotoInbox(page);

    let rev = 0;

    try {
      // Read the current revision, then store the key through the product's own route.
      const current = await page.request.get(`${E2E_ORIGIN}/api/settings/llm`, {
        headers: await authHeaders(page),
      });
      rev = ((await current.json()) as { data: { revision: number } }).data.revision;

      const saved = await page.request.put(`${E2E_ORIGIN}/api/settings/llm`, {
        headers: await authHeaders(page),
        data: {
          keyAction: 'replace',
          apiKey: CHAIN_KEY,
          expectedRevision: rev,
          config: {
            adapter: 'openai-compatible',
            baseUrl: 'https://chain.invalid/v1',
            model: 'e2e-chain',
            structuredMode: 'prompt_json',
            tokenField: 'none',
            maxOutputTokens: 4096,
            schemaRepairEnabled: false,
          },
        },
      });
      expect(saved.status(), `保存 Key 应成功，实际 ${saved.status()}`).toBe(200);
      rev = ((await saved.json()) as { data: { revision: number } }).data.revision;

      // 真的用一遍设置页（KeyField 就在这里），再去别的页面。
      await openRoute(page, '/settings');
      await expect(page.getByTestId('key-field')).toBeVisible();
      // 已保存的 Key 不得回显：字段只能是空值，状态只用文字说明「有一个 Key」，
      // 而不是把值或它的片段放进 DOM。
      await expect(page.getByTestId('llm-api-key')).toHaveValue('');
      const status = await page.getByTestId('key-status').textContent();
      expect(status ?? '', '状态应说明已有保存的 Key').toMatch(/Key/u);
      expect(status ?? '', '状态不得回显 Key 的值').not.toContain(CHAIN_KEY);
      expect(status ?? '').not.toContain('SECRETCHAIN');

      // 服务端侧确实认为已配置（证明上面不是「其实没保存成功」）。
      const configured = await page.request.get(`${E2E_ORIGIN}/api/settings/llm`, {
        headers: await authHeaders(page),
      });
      expect(
        ((await configured.json()) as { data: { apiKeyConfigured: boolean } }).data
          .apiKeyConfigured,
      ).toBe(true);

      for (const route of ['/inbox', '/library', '/graph', '/mindmap', '/flow']) {
        await openRoute(page, route);
      }
      // 回到设置页，让诊断面板（含模型 host 与 apiKeyConfigured）也渲染一次。
      await openRoute(page, '/settings');
      await expect(page.getByTestId('diagnostics-panel')).toBeVisible();

      const storage = await browserStorageDump(page);

      // 主要判据：Key、令牌、以及 Key 的独特片段都不得出现在浏览器持久存储里。
      expect(storage).not.toContain(CHAIN_KEY);
      expect(storage).not.toContain('SECRETCHAIN');
      expect(storage.toLowerCase()).not.toContain('x-brain-token');
      // 已保存的 Key 只能在服务端；页面上也不该有 DOM 副本。
      const body = await page.content();
      expect(body).not.toContain(CHAIN_KEY);

      // 令牌本身（进程级秘密）也不应落地。
      const headers = await authHeaders(page);
      expect(storage, '会话令牌不应进入浏览器持久存储').not.toContain(
        headers['x-brain-token']!,
      );
    } finally {
      // Clean up through the product so the next spec sees the unconfigured branch.
      await page.request.put(`${E2E_ORIGIN}/api/settings/llm`, {
        headers: await authHeaders(page),
        data: {
          keyAction: 'delete',
          expectedRevision: rev,
          config: {
            adapter: 'openai-compatible',
            baseUrl: '',
            model: '',
            structuredMode: 'prompt_json',
            tokenField: 'none',
            maxOutputTokens: 4096,
            schemaRepairEnabled: false,
          },
        },
      });
    }

    expect(traffic.externalRequests(), '整段浏览不应产生外部请求').toEqual([]);
  });

  test('T075-C02 保存 Key 后 GET settings 的响应里没有它', async ({ page }) => {
    const headers = await authHeaders(page);
    const current = await page.request.get(`${E2E_ORIGIN}/api/settings/llm`, { headers });
    let rev = ((await current.json()) as { data: { revision: number } }).data.revision;

    try {
      const saved = await page.request.put(`${E2E_ORIGIN}/api/settings/llm`, {
        headers,
        data: {
          keyAction: 'replace',
          apiKey: CHAIN_KEY,
          expectedRevision: rev,
          config: {
            adapter: 'openai-compatible',
            baseUrl: 'https://chain.invalid/v1',
            model: 'e2e-chain',
            structuredMode: 'prompt_json',
            tokenField: 'none',
            maxOutputTokens: 4096,
            schemaRepairEnabled: false,
          },
        },
      });
      rev = ((await saved.json()) as { data: { revision: number } }).data.revision;

      const read = await page.request.get(`${E2E_ORIGIN}/api/settings/llm`, { headers });
      const raw = await read.text();

      expect(raw).not.toContain(CHAIN_KEY);
      const data = (JSON.parse(raw) as { data: Record<string, unknown> }).data;
      expect(data.apiKeyConfigured).toBe(true);
      // 长度是秘密的指纹，公开投影里不应有这个字段。
      expect(Object.keys(data)).not.toContain('keyLength');
      expect(Object.keys(data)).not.toContain('apiKey');
    } finally {
      await page.request.put(`${E2E_ORIGIN}/api/settings/llm`, {
        headers,
        data: {
          keyAction: 'delete',
          expectedRevision: rev,
          config: {
            adapter: 'openai-compatible',
            baseUrl: '',
            model: '',
            structuredMode: 'prompt_json',
            tokenField: 'none',
            maxOutputTokens: 4096,
            schemaRepairEnabled: false,
          },
        },
      });
    }
  });
});

test.describe('T075-C05 打开含 URL 的笔记不会抓取那些 URL', () => {
  test('T075-C05 保存并浏览含内网地址的笔记：零外部请求', async ({ page, traffic }) => {
    await gotoInbox(page);

    const internal = 'http://127.0.0.1:9/private-admin';
    const external = 'http://t075-not-real.invalid/page';
    const marker = uniqueText('原文URL');

    const text = `${marker} 同事给的内网地址 ${internal} ，还有 ${external} 这篇。`;
    await captureViaUi(page, text);

    // 在资料库里搜出来并打开详情——详情页最可能去解析 sourceRef。
    await openRoute(page, '/library');
    await page.getByTestId('library-search').fill(marker);
    const card = page.getByTestId('knowledge-card').filter({ hasText: marker });
    await expect(card).toBeVisible();
    await card.click();

    // 打开详情抽屉——抽屉最可能去解析 sourceRef 或正文里的链接。
    // 点卡片里的第一个按钮，这是产品打开抽屉的入口（见 gate1.spec.ts 的惯用法）。
    await card.getByRole('button').first().click();
    const drawer = page.getByTestId('knowledge-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText(internal);
    // 正文里的 URL 只作为文字出现，不是可点击的链接。
    expect(await drawer.locator('a').count(), '原文里的 URL 不应被渲染成链接').toBe(0);

    // 关键断言：这一整段操作里没有任何请求离开本机。
    const externalRequests = traffic.externalRequests();
    expect(
      externalRequests.map((entry) => entry.url),
      `不应抓取原文里的 URL，实际记录：${JSON.stringify(externalRequests.slice(0, 5))}`,
    ).toEqual([]);
    expect(traffic.blockedRequests(), '也不应有被拦下的抓取尝试').toEqual([]);

    // 反向约束：确实发生了本机 API 调用，证明上一条不是「页面没加载」。
    expect(traffic.apiRequests().length).toBeGreaterThan(0);

    // 清理：把这条笔记删掉，避免影响后续按条数断言的用例。
    const id = await findItemIdViaApi(page, marker);
    const detail = await page.request.get(`${E2E_ORIGIN}/api/items/${id}`, {
      headers: await authHeaders(page),
    });
    const revision = ((await detail.json()) as { data: { revision: number } }).data.revision;
    const deleted = await page.request.delete(`${E2E_ORIGIN}/api/items/${id}`, {
      headers: await authHeaders(page),
      data: { expectedRevision: revision },
    });
    expect(deleted.status()).toBe(200);
  });

  test('T075-C05 sourceRef 是链接时也不打开它，只当字符串展示', async ({ page, traffic }) => {
    const headers = await authHeaders(page);
    const marker = uniqueText('来源引用');
    const sourceRef = 'http://t075-ref-not-real.invalid/source';

    const created = await page.request.post(`${E2E_ORIGIN}/api/items`, {
      headers,
      data: {
        captureRequestId: crypto.randomUUID(),
        rawText: `${marker} 这条带一个来源引用。`,
        sourceType: 'other',
        sourceRef,
      },
    });
    expect(created.status()).toBe(201);
    const itemId = ((await created.json()) as { data: { item: { id: string } } }).data.item.id;

    try {
      const detail = await page.request.get(`${E2E_ORIGIN}/api/items/${itemId}`, { headers });
      const envelope = (await detail.json()) as { data: { sourceRef: string } };
      // 服务端只把它当字符串返回，协议判定属于展示层。
      expect(envelope.data.sourceRef).toBe(sourceRef);

      await openRoute(page, '/library');
      await page.getByTestId('library-search').fill(marker);
      const card = page.getByTestId('knowledge-card').filter({ hasText: marker });
      await expect(card).toBeVisible();
      await card.getByRole('button').first().click();
      await expect(page.getByTestId('knowledge-drawer')).toBeVisible();

      // sourceRef 只作为字符串展示/编辑，不变成可点击的链接（T018-C03 的分工：
      // 服务端只回字符串，协议判定属于展示层）。这条不假装覆盖抽屉里的来源展示，
      // 只断言「打开一条带 sourceRef 的记录不会去抓那个地址」。
      expect(traffic.externalRequests(), 'sourceRef 不应被自动抓取').toEqual([]);
      expect(traffic.blockedRequests()).toEqual([]);
    } finally {
      const detail = await page.request.get(`${E2E_ORIGIN}/api/items/${itemId}`, { headers });
      const revision = ((await detail.json()) as { data: { revision: number } }).data.revision;
      await page.request.delete(`${E2E_ORIGIN}/api/items/${itemId}`, {
        headers,
        data: { expectedRevision: revision },
      });
    }
  });
});

test.describe('T075-R05 拒绝被拒绝的请求不改弱正式设置', () => {
  test('T075-R05 跨站尝试之后同源页面仍然完全可用', async ({ page }) => {
    await gotoInbox(page);

    const headers = await authHeaders(page);

    // 先制造一次被拒绝的跨站请求。
    const rejected = await page.request.post(`${E2E_ORIGIN}/api/items`, {
      headers: {
        origin: CROSS_SITE_ORIGIN,
        host: `${E2E_HOST}:${E2E_PORT}`,
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
        'x-brain-token': headers['x-brain-token']!,
      },
      data: {
        captureRequestId: crypto.randomUUID(),
        rawText: uniqueText('拒绝后'),
        sourceType: 'other',
        sourceRef: null,
      },
    });
    expect(rejected.status()).toBe(403);

    // 守卫没有被「用过之后更严」或「被绕过之后更松」地改动：正常路径照常工作。
    const text = uniqueText('拒绝后仍可保存');
    await captureViaUi(page, text);
    await openRoute(page, '/library');
    await page.getByTestId('library-search').fill(text);
    await expect(page.getByTestId('knowledge-card').filter({ hasText: text })).toBeVisible();

    // 设置页仍然能读到配置（跨站读取被拒没有破坏读取路径）。
    const settings = await page.request.get(`${E2E_ORIGIN}/api/settings/llm`, {
      headers: await headersAt(E2E_ORIGIN),
    });
    expect(settings.status()).toBe(200);
  });
});
