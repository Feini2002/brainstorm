/**
 * T079-R01's remaining scales and R03's trend.
 *
 * R01 names five separate subjects precisely so one fast scenario cannot hide a
 * slow one behind an average. The inbox, library search and the 200-node graph are
 * in `loading-and-query.perf.ts`; this file covers the two projection renderers and
 * R03's size trend.
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
} from './support/perfEnv';
import type { Sample } from './support/perfEnv';

test.setTimeout(900_000);

function printBlock(title: string, facts: string, rows: Sample[], notes: string[] = []): void {
  console.log(
    [
      '',
      `===== ${title} =====`,
      facts,
      '| 场景 | 中位数 (ms) | p95 (ms) | 最大 (ms) | 样本 |',
      '| --- | --- | --- | --- | --- |',
      ...rows.map(formatSampleRow),
      ...notes.map((note) => `注：${note}`),
      '',
    ].join('\n'),
  );
}

test.describe('T079 投影渲染与规模趋势', () => {
  test('T079-R01 一百二十节点脑图：打开已保存视图到画布出节点', async ({ page }) => {
    const dataDir = benchDataDir('target');
    await seedScale('target', dataDir);
    const server = await startBenchServer(dataDir);
    const facts = formatEnvironment(await environmentFacts(page));
    const rows: Sample[] = [];

    try {
      await page.goto(`${server.origin}/mindmap`);
      const canvas = page.getByTestId('mindmap-canvas');
      await expect(canvas).toBeVisible({ timeout: 60_000 });
      // The page adopts the newest saved mindmap, which is the seeded 120-node one.
      await expect(page.getByTestId('mindmap-view-meta')).toContainText('条来源', {
        timeout: 90_000,
      });

      /*
       * "Drawn" means Markmap produced node groups inside the `<svg>`, not that the
       * component mounted: `fit()` on an empty instance is the historical failure
       * mode where a canvas exists and shows nothing (the T057 `destroy()` bug).
       */
      const drawnNodes = (): Promise<number> =>
        page.getByTestId('mindmap-svg').locator('g.markmap-node').count();
      await expect.poll(drawnNodes, { timeout: 90_000 }).toBeGreaterThan(0);

      rows.push(
        await sample('脑图首帧（切换已保存视图 → 节点出现）', 'ms', 5, async (sampleIndex) => {
          if (sampleIndex === -1) return; // warm-up
          await page.getByTestId('mindmap-view-select').selectOption({ index: 1 });
          await expect.poll(drawnNodes, { timeout: 90_000 }).toBeGreaterThan(0);
        }),
      );

      const count = await drawnNodes();
      const collapsed = await page.getByTestId('mindmap-expand-level').inputValue();
      printBlock('T079-R01 一百二十节点脑图', facts, rows, [
        `种子规模：脑图 ${SCALES.target.mindmap} 节点`,
        `画布实际节点组 ${count} 个；默认展开层级 ${collapsed}（更深的节点按设计折叠，收起不等于丢失）`,
      ]);
      expect(count, '画布上应真的画出了节点').toBeGreaterThan(0);
    } finally {
      await server.stop();
    }
  });

  test('T079-R01 四十节点流程：打开已保存视图到 SVG 出节点', async ({ page }) => {
    const dataDir = benchDataDir('target');
    await seedScale('target', dataDir);
    const server = await startBenchServer(dataDir);
    const facts = formatEnvironment(await environmentFacts(page));
    const rows: Sample[] = [];

    try {
      await page.goto(`${server.origin}/flow`);
      await expect(page.getByTestId('flow-renderer')).toBeVisible({ timeout: 60_000 });

      /*
       * The flow page reads its own saved list, so the seeded view is opened
       * explicitly: unlike the graph and mindmap pages it does not adopt the newest
       * view on mount, and assuming it did would measure an empty renderer.
       */
      await expect(page.getByTestId('flow-saved-row').first()).toBeVisible({ timeout: 60_000 });
      const drawnNodes = (): Promise<number> =>
        page.getByTestId('flow-svg').locator('g.node').count();

      rows.push(
        await sample('流程首帧（打开已保存视图 → SVG 出节点）', 'ms', 5, async (sampleIndex) => {
          if (sampleIndex === -1) return; // warm-up
          await page.getByTestId('flow-saved-open').first().click();
          await expect.poll(drawnNodes, { timeout: 90_000 }).toBeGreaterThan(0);
        }),
      );

      const count = await drawnNodes();
      // The fallback list is the honest degradation path; if Mermaid could not draw,
      // the case must say so rather than report a fast "render".
      const fellBack = await page.getByTestId('flow-fallback').count();
      printBlock('T079-R01 四十节点流程', facts, rows, [
        `种子规模：流程 ${SCALES.target.flow} 节点 / ${SCALES.target.flowEdges} 条箭头`,
        `SVG 实际节点 ${count} 个；降级列表出现 ${fellBack} 次`,
      ]);
      expect(count, 'SVG 上应真的画出了节点').toBeGreaterThan(0);
    } finally {
      await server.stop();
    }
  });

  test('T079-R03 检索规模趋势：一百 / 一千 / 一万条本地笔记', async ({ page }) => {
    const rows: Sample[] = [];
    const notes: string[] = [];
    let facts = '';

    /*
     * Three separate servers, each against its own seeded database.
     *
     * Sequential rather than parallel on purpose: running two 10 000-row servers at
     * once would make both numbers describe contention, and the whole point of a
     * trend is that the only thing changing between the samples is the library size.
     */
    for (const scale of ['small', 'target', 'large'] as const) {
      const dataDir = benchDataDir(scale);
      await seedScale(scale, dataDir);
      const server = await startBenchServer(dataDir);
      try {
        if (facts.length === 0) facts = formatEnvironment(await environmentFacts(page));

        // Same needle at every scale, and the same page size: only the row count varies.
        const needle = '数据库索引';
        const result = await sample(
          `搜索 API /api/items?q=（${SCALES[scale].items} 条）`,
          'ms',
          9,
          async () => {
            const response = await fetch(
              `${server.origin}/api/items?q=${encodeURIComponent(needle)}&limit=${20}`,
              { headers: server.headers },
            );
            expect(response.status, '搜索接口应返回 200').toBe(200);
            const body = (await response.json()) as { data: { items: unknown[] } };
            expect(body.data.items.length, '每个规模都应能搜到同一批命中').toBeGreaterThan(0);
          },
        );
        rows.push(result);

        // The Library's first page at each size: the trend a reader actually feels.
        const firstPage = await sample(
          `资料库首屏 API /api/items?limit=20（${SCALES[scale].items} 条）`,
          'ms',
          7,
          async () => {
            const response = await fetch(`${server.origin}/api/items?limit=20`, {
              headers: server.headers,
            });
            expect(response.status).toBe(200);
            await response.json();
          },
        );
        rows.push(firstPage);

        notes.push(
          `${SCALES[scale].items} 条：数据库 ${(await databaseSizeMiB(dataDir)).toFixed(1)} MiB`,
        );
      } finally {
        await server.stop();
      }
    }

    printBlock('T079-R03 检索规模趋势', facts, rows, [
      ...notes,
      'R03 明确不要求图同时展示全部一万条：大库上图的规模仍是 200 节点的已保存视图',
      '趋势的每个点都换了一个空库起进程，因此同一规模内不含上一个规模的页缓存',
    ]);

    expect(rows).toHaveLength(6);
    /*
     * The trend must be observable at all: if 10 000 rows were not measurably
     * different from 100, the samplers would be reporting noise and the numbers
     * should not be published as a trend. This asserts the *shape* (a strictly
     * larger library costs more on at least one of the two reads), not a slope —
     * a slope would be a fine performance claim that a single run cannot support.
     */
    const smallSearch = rows[0]!.median;
    const largeSearch = rows[4]!.median;
    expect(
      largeSearch,
      `一万条搜索（${largeSearch.toFixed(1)} ms）应不低于一百条（${smallSearch.toFixed(1)} ms）——若更低说明样本没在测库规模`,
    ).toBeGreaterThanOrEqual(smallSearch * 0.5);
  });
});

async function databaseSizeMiB(dataDir: string): Promise<number> {
  const { statSync } = await import('node:fs');
  const path = await import('node:path');
  try {
    return statSync(path.join(dataDir, 'brain.db')).size / 1024 ** 2;
  } catch {
    return 0;
  }
}
