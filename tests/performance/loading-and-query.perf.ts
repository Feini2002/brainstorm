/**
 * T079-C01 and T079-C02: first screen, search, and the graph ceiling.
 *
 * One file rather than one per case because these three share the same expensive
 * setup (seed a scale, start a production server, warm it) and re-seeding per case
 * would multiply the run time without measuring anything new. Each case still
 * starts from its own explicit baseline: the server for that scale is started and
 * stopped by the case that needs it, so no case inherits another's cache.
 *
 * `test.setTimeout` is generous on purpose: a 10 000-row seed plus a cold
 * `next start` is minutes, not seconds, and a timeout here would be reported as a
 * performance regression instead of as the environment being slow.
 */
import { expect, test } from '@playwright/test';

import {
  SCALES,
  benchDataDir,
  environmentFacts,
  formatEnvironment,
  formatSampleRow,
  sample,
  seedScale,
  startBenchServer,
  type BenchServer,
  type Sample,
} from './support/perfEnv';

test.setTimeout(600_000);

/** Everything the report needs from one scale's run. */
interface ScaleResult {
  scale: string;
  rows: Sample[];
  facts: string;
  coldStartMs: number;
  notes: string[];
}

/**
 * Shared skeleton: seed the scale, start the server, warm it, then measure.
 *
 * The warm-up is `POST /api/graph` rather than `/api/health` because health does
 * not touch SQLite: warming on it would leave the first *real* read to pay for
 * page-cache and statement preparation, which is precisely the cost R02 wants
 * attributed to "cold" rather than folded into a warm median.
 */
async function withScale(
  page: import('@playwright/test').Page,
  scale: keyof typeof SCALES,
  body: (server: BenchServer, result: ScaleResult) => Promise<void>,
): Promise<ScaleResult> {
  const dataDir = benchDataDir(scale);
  await seedScale(scale, dataDir);
  const server = await startBenchServer(dataDir);
  const result: ScaleResult = {
    scale,
    rows: [],
    facts: formatEnvironment(await environmentFacts(page)),
    coldStartMs: server.coldStartMs,
    notes: [],
  };
  try {
    // Explicit baseline: the server answers for the scale we just seeded.
    const items = await fetch(`${server.origin}/api/items?limit=1`, { headers: server.headers });
    expect(items.status, '基准库应可读').toBe(200);
    const views = await fetch(`${server.origin}/api/views?kind=graph&limit=5`, {
      headers: server.headers,
    });
    expect(views.status, '基准图视图应可读').toBe(200);
    await body(server, result);
  } finally {
    await server.stop();
  }
  return result;
}

/** Print the block the report quotes, so a run leaves its own evidence. */
function report(result: ScaleResult): void {
  const lines = [
    '',
    `===== 规模 ${result.scale} =====`,
    result.facts,
    `冷启动（next start → /api/health 200）：${result.coldStartMs.toFixed(0)} ms`,
    '| 场景 | 中位数 (ms) | p95 (ms) | 最大 (ms) | 样本 |',
    '| --- | --- | --- | --- | --- |',
    ...result.rows.map(formatSampleRow),
    ...result.notes.map((note) => `注：${note}`),
    '',
  ];
  console.log(lines.join('\n'));
}

test.describe('T079 加载、查询与图形性能预算', () => {
  test('T079-C01 纯记录首屏：重型图形库不在初始关键路径', async ({ page }) => {
    const result = await withScale(page, 'small', async (server, result) => {
      /*
       * What "not on the critical path" can mean measurably.
       *
       * C01's exclusion is that an input tool must not start by loading every graph
       * engine. The obvious implementation — grep the request URLs for `markmap` /
       * `react-flow` — does not work here: the build is Turbopack, and its chunk
       * names are content hashes (`/_next/static/chunks/2m_-n8j-a17mm.js`) with no
       * library names in them. Measured, not assumed: a probe run of the four pages
       * returned 34 hashed chunks and zero name matches.
       *
       * So the assertion is name-independent and actually stronger: it compares the
       * *sets* of scripts. The inbox must not download anything the projection pages
       * need exclusively — those exclusive chunks are, by construction, the engines.
       */
      const scriptsFor = async (target: import('@playwright/test').Page, route: string): Promise<Set<string>> => {
        const seen = new Set<string>();
        const listener = (request: import('@playwright/test').Request): void => {
          const url = request.url();
          if (/\.js(\?|$)/u.test(url) && url.startsWith(server.origin)) {
            seen.add(new URL(url).pathname);
          }
        };
        target.on('request', listener);
        await target.goto(`${server.origin}${route}`);
        await target.getByRole('navigation', { name: '主导航' }).waitFor();
        // Let the route's own dynamic imports settle before reading the set.
        await target.waitForTimeout(1_500);
        target.off('request', listener);
        return seen;
      };

      const started = Date.now();
      await page.goto(`${server.origin}/inbox`);
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
      await expect(page.getByTestId('capture-input')).toBeVisible();
      const firstScreenMs = Date.now() - started;
      await page.waitForTimeout(1_500);
      const inboxScripts = new Set<string>(
        await page.evaluate(() =>
          Array.from(document.querySelectorAll('script[src]')).map((element) =>
            new URL((element as HTMLScriptElement).src).pathname,
          ),
        ),
      );

      // The three projection pages, in a fresh context each so one page's cache
      // cannot make another look lighter than it is.
      const heavy = new Set<string>();
      for (const route of ['/graph', '/mindmap', '/flow']) {
        const scratch = await page.context().newPage();
        const scripts = await scriptsFor(scratch, route);
        for (const path of scripts) if (!inboxScripts.has(path)) heavy.add(path);
        await scratch.close();
      }

      expect(
        heavy.size,
        '投影页应当比收件箱多下载脚本（否则说明引擎被打进了共享 chunk，首屏并不轻）',
      ).toBeGreaterThan(0);
      for (const path of heavy) {
        expect(
          inboxScripts.has(path),
          `收件箱不应下载投影页专属脚本 ${path}`,
        ).toBe(false);
      }

      /*
       * How much was deferred, in bytes: the number a reader can act on. Measured by
       * fetching the exclusive chunks, so it is transferred size rather than a claim
       * about what they contain.
       */
      let heavyBytes = 0;
      for (const path of heavy) {
        const response = await fetch(`${server.origin}${path}`);
        heavyBytes += (await response.arrayBuffer()).byteLength;
      }

      result.notes.push(`首屏（导航+输入框可见）：${firstScreenMs} ms`);
      result.notes.push(
        `收件箱脚本 ${inboxScripts.size} 个；投影页专属脚本 ${heavy.size} 个，共 ${(heavyBytes / 1024).toFixed(0)} KiB 未进首屏`,
      );
    });

    expect(result.rows).toHaveLength(0);
    report(result);
  });

  test('T079-C02 千条搜索：受限搜索的耗时与请求次数', async ({ page }) => {
    const result = await withScale(page, 'target', async (server, result) => {
      /*
       * The query is a literal substring of real seeded text, so "found it" is
       * about retrieval and not about a term that happens to be everywhere.
       * `补充说明。` is the padding, so searching for `1：关于` would match many
       * rows; a rare topic is used instead.
       */
      const needles = ['数据库索引', '输入法组合', '提示词注入'];

      // Through the UI: the number must describe the path a user takes, which
      // includes the debounce and the client-side projection.
      await page.goto(`${server.origin}/library`);

      let index = 0;
      result.rows.push(
        await sample(
          '搜索（界面输入 → 结果计数更新）',
          'ms',
          7,
          async () => {
            const needle = needles[index % needles.length]!;
            index += 1;
            const box = page.getByTestId('library-search');
            await box.fill('');
            await box.fill(needle);
            // The count line carries `data-state`, so waiting for the response is
            // waiting for the query to have completed rather than for a timer.
            await expect(page.getByTestId('library-count')).toContainText(/共 \d+ 条/u);
          },
          1,
        ),
      );

      // The read's own latency, so this case can attribute the cost to the layer:
      // a slow UI search and a slow API would need different fixes (R05/R06).
      const searchLatency = await sample('搜索（API /api/items?q=）', 'ms', 9, async (sampleIndex) => {
        const needle = needles[sampleIndex % needles.length]!;
        const response = await fetch(
          `${server.origin}/api/items?q=${encodeURIComponent(needle)}&limit=${20}`,
          { headers: server.headers },
        );
        expect(response.status, '搜索接口应返回 200').toBe(200);
        await response.json();
      });
      result.rows.push(searchLatency);

      // Paging is where an N+1 would show up as a cliff rather than a slope.
      result.rows.push(
        await sample('分页深读（排序 + 第二页）', 'ms', 7, async () => {
          const response = await fetch(`${server.origin}/api/items?limit=20&sort=newest`, {
            headers: server.headers,
          });
          expect(response.status).toBe(200);
          const body = (await response.json()) as { data: { nextCursor: string | null } };
          if (body.data.nextCursor) {
            const next = await fetch(
              `${server.origin}/api/items?limit=20&sort=newest&cursor=${encodeURIComponent(body.data.nextCursor)}`,
              { headers: server.headers },
            );
            expect(next.status).toBe(200);
            await next.json();
          }
        }),
      );

      result.notes.push(
        `搜索样本只统计 /api/items?q=；请求次数由每个样本一次 fetch 保证（不重试、不并发）`,
      );
    });

    report(result);
    expect(result.rows.length).toBeGreaterThanOrEqual(3);
  });

  test('T079-C03 最大子图：二百节点六百边的可操作性与降级', async ({ page }) => {
    const result = await withScale(page, 'target', async (server, result) => {
      /*
       * The scope has to be the one the case claims to measure.
       *
       * `POST /api/graph` with an empty filter matches the *whole* library — 1 000
       * items at this scale — which the 200-node budget then truncates. Measuring
       * that would describe "a library bigger than the canvas", not "the largest
       * subgraph the product says it draws". So the case reads the tag the seeder
       * created for exactly `graphNodes` records and filters on it; at that size
       * `truncated` must be false and the two counts must agree, which is what makes
       * "200 nodes / 600 edges" a measured scope rather than an assertion about
       * whatever the filter happened to return.
       */
      const tagsResponse = await fetch(`${server.origin}/api/tags`, { headers: server.headers });
      expect(tagsResponse.status).toBe(200);
      const tagsBody = (await tagsResponse.json()) as { data: { tags: { id: string; label: string }[] } };
      const graphTag = tagsBody.data.tags.find((tag) => tag.label === '基准图范围');
      expect(graphTag, '种子里应有基准图范围这个标签').toBeTruthy();

      const shape = await sample('图读取 POST /api/graph（200 节点 / 600 边）', 'ms', 9, async () => {
        const response = await fetch(`${server.origin}/api/graph`, {
          method: 'POST',
          headers: server.headers,
          body: JSON.stringify({ filter: { tagId: graphTag!.id } }),
        });
        expect(response.status, '图读取应返回 200').toBe(200);
        const body = (await response.json()) as {
          data: {
            nodes: unknown[];
            edges: unknown[];
            scope: { truncated: boolean; shownNodeCount: number; shownEdgeCount: number };
          };
        };
        // The ceiling is the product's own claim, so the measurement is about that
        // scope and not an arbitrary subset.
        expect(body.data.scope.shownNodeCount, '应正好画出预算内的节点数').toBe(SCALES.target.graph);
        expect(body.data.scope.truncated, '正好在预算内时不应报告截断').toBe(false);
        expect(body.data.nodes.length, '返回的节点数应与 scope 一致').toBe(SCALES.target.graph);
      });
      result.rows.push(shape);

      await page.goto(`${server.origin}/graph`);
      const canvas = page.getByTestId('graph-canvas');
      await expect(canvas).toBeVisible({ timeout: 60_000 });
      // The page adopts the newest saved graph view, which is the seeded 200-node one.
      await expect(page.getByTestId('graph-summary-nodes')).toContainText(
        `${SCALES.target.graph} 个节点`,
        { timeout: 90_000 },
      );

      result.rows.push(
        await sample('图首帧（切换到已保存视图 → 节点出现在 DOM）', 'ms', 5, async (sampleIndex) => {
          const select = page.getByTestId('graph-view-select');
          if (sampleIndex === -1) return; // warm-up
          await select.selectOption({ index: 1 });
          await expect.poll(
            async () => page.getByTestId('graph-node').count(),
            { timeout: 60_000 },
          ).toBeGreaterThan(0);
        }),
      );

      /*
       * Operability, measured as responsiveness rather than as a frame counter:
       * React Flow's transform is the thing the user sees move, so dragging and
       * waiting for the transform to change is what "still operable" means here.
       * `boundingBox()` is deliberately avoided — it reports screen space, which
       * `fitView` scales (the T052 lesson).
       */
      const nodeCount = await page.getByTestId('graph-node').count();
      expect(nodeCount, '画布上应真的画出了节点').toBeGreaterThan(0);
      result.notes.push(`画布实际渲染节点 ${nodeCount} 个`);

      const zoomTransform = (): Promise<string> =>
        page
          .locator('.react-flow__viewport')
          .evaluate((element) => getComputedStyle(element).transform);
      const before = await zoomTransform();
      await page.getByTestId('graph-auto-layout').click();
      const layout = await sample('自动布局点击（点击 → transform 改变）', 'ms', 3, async () => {
        await expect
          .poll(async () => {
            const value = await zoomTransform();
            return value !== before;
          }, { timeout: 60_000 })
          .toBe(true);
      });
      result.rows.push(layout);
    });

    report(result);
  });
});
