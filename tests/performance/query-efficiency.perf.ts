/**
 * T079-R04: the query-count and instance audit.
 *
 * R04 asks for four specific things to be *checked*, not assumed: N+1 queries,
 * over-eager site-wide polling, duplicate graph instances, and per-frame layout
 * writes. Polling is C04's subject and does not appear here.
 *
 * ## Why this file does not measure SQL through the HTTP server
 *
 * The first two subjects are about *how many statements* the product issues. A
 * number of that kind cannot be obtained from outside the process — an HTTP
 * client sees requests, and one request can issue one query or two hundred. So
 * this case imports the real repository and service functions and runs them
 * against a real seeded SQLite file, with `setAuthorizer` installed on the
 * connection. The authorizer fires once per statement *prepared*, which is
 * precisely the N+1 shape: code that prepares a query per row reports N selects,
 * and code that prepares one statement and reuses it reports one.
 *
 * That is an in-process measurement of the real code path, not a re-implementation
 * of it: `listItems` and `getGraphData` are the same functions the routes call.
 *
 * ## What this file does not prove
 *
 *  - **React render counts.** The fourth subject R04 names is 无关重渲染
 *    (irrelevant re-render). Counting renders needs a profiler injected into the
 *    app; what is measured here instead is the *observable consequence* — a drag
 *    that writes nothing per frame and refetches nothing — and that is stated as
 *    a proxy rather than as a render measurement.
 *  - **The exact statement count of any future version.** The assertions are
 *    about *growth with scale*, not about a fixed number, so a refactor that
 *    adds a legitimate query does not fail this file while a per-row query does.
 */
import { DatabaseSync } from 'node:sqlite';

import { expect, test } from '@playwright/test';

import { closeDb, getDb } from '@/server/db/database';
import { listItems } from '@/server/repositories/items';
import { getGraphData } from '@/server/services/getGraphData';
import { getViewFreshness } from '@/server/services/views/getFreshness';
import {
  benchDataDir,
  environmentFacts,
  formatEnvironment,
  SCALES,
  seedScale,
  startBenchServer,
  type ScaleName,
} from './support/perfEnv';

test.setTimeout(600_000);

/** `SQLITE_SELECT` in the authorizer's action vocabulary. */
const SQLITE_SELECT = 21;

interface StatementCount {
  /** `SQLITE_SELECT` authorizer calls: one per statement *and per nested subquery*. */
  selects: number;
  /** Every authorizer callback, including per-column reads. */
  actions: number;
}

/**
 * Count the SELECT-level units one operation prepares.
 *
 * The metric counts `SQLITE_SELECT` authorizer calls, and SQLite issues one per
 * statement *plus one per nested subquery* — so `listItems`' count query (which
 * has an `EXISTS` subquery) reports two. That granularity is fine for this audit
 * and is stated rather than glossed over: the question R04 asks is whether the
 * count **grows with the data**, and both a per-row prepare and a subquery added
 * per row show up as growth. Calibration is `controlPerRowReads` below, which
 * makes the metric's sensitivity a measured fact instead of a claim.
 *
 * The authorizer is installed for the duration of `run` and removed in `finally`:
 * a connection that keeps an authorizer after a failed assertion would make every
 * later measurement in the process report that assertion's numbers.
 */
function countStatements(db: DatabaseSync, run: () => void): StatementCount {
  const count: StatementCount = { selects: 0, actions: 0 };
  db.setAuthorizer((action) => {
    count.actions += 1;
    if (action === SQLITE_SELECT) count.selects += 1;
    return 0;
  });
  try {
    run();
  } finally {
    db.setAuthorizer(null);
  }
  return count;
}

/**
 * The N+1 shape, written on purpose, to prove the metric sees it.
 *
 * A suite that asserts "the count does not grow" is only meaningful if the
 * counting can detect growth. So the same authorizer is pointed at a deliberate
 * per-row loop: the count must increase by exactly one per row. If a future
 * change to the metric or to `setAuthorizer` made it blind, this number would
 * stop tracking and the assertion below would fail.
 */
function controlPerRowReads(db: DatabaseSync, rows: number): StatementCount {
  return countStatements(db, () => {
    for (let index = 0; index < rows; index += 1) {
      db.prepare('SELECT 1 AS x').get();
    }
  });
}

/** The tag the seeder puts exactly `graphNodes` records behind. */
function graphTagId(db: DatabaseSync): string {
  const row = db
    .prepare("SELECT id FROM tags WHERE label = '基准图范围'")
    .get() as { id?: string } | undefined;
  expect(row?.id, '种子应写入「基准图范围」标签').toBeTruthy();
  return String(row!.id);
}

function graphViewId(db: DatabaseSync): string {
  const row = db
    .prepare("SELECT id FROM views WHERE kind = 'graph' LIMIT 1")
    .get() as { id?: string } | undefined;
  expect(row?.id, '种子应写入一张关系图视图').toBeTruthy();
  return String(row!.id);
}

test.describe('T079 查询与实例审计', () => {
  test('T079-R04 列表与搜索：查询次数不随条目数或命中数增长', async () => {
    const measurements: {
      scale: ScaleName;
      items: number;
      listSelects: number;
      searchSelects: number;
      /** Same queries with a larger page, to catch per-result-row work. */
      widePageSelects: number;
      /** Matches the needle actually returned, so "few hits" is a measured fact. */
      searchMatched: number;
    }[] = [];

    try {
      for (const scale of ['small', 'target', 'large'] as const) {
        const dataDir = benchDataDir(scale);
        await seedScale(scale, dataDir);
        const db = getDb({ databasePath: `${dataDir}/brain.db` });
        try {
          const page = countStatements(db, () => {
            listItems(db, {
              filters: {},
              sort: 'newest',
              limit: 20,
              cursor: null,
            });
          });

          /*
           * The same read with a much larger page.
           *
           * This is the assertion that actually catches per-result-row work. The
           * per-scale comparison below cannot: the page size is a constant, so one
           * query per returned row would report the same inflated count at 100 and
           * at 10 000 items and look stable. Changing only the page size isolates
           * "does the cost follow the rows returned", which is the N+1 question.
           */
          const widePage = countStatements(db, () => {
            listItems(db, {
              filters: {},
              sort: 'newest',
              limit: 100,
              cursor: null,
            });
          });

          /*
           * Two search widths on the same library.
           *
           * A common needle matches a large share of the library and a narrow one
           * matches a handful. If tags were fetched per result row, the wide
           * search would cost proportionally more selects; the whole point of the
           * `json_group_array` subquery in `ITEM_WITH_TAGS_SQL` is that both cost
           * the same two statements.
           */
          let searchMatched = 0;
          const search = countStatements(db, () => {
            const result = listItems(db, {
              filters: { q: '关于' },
              sort: 'newest',
              limit: 20,
              cursor: null,
            });
            searchMatched = result.totalMatched;
          });

          measurements.push({
            scale,
            items: SCALES[scale].items,
            listSelects: page.selects,
            searchSelects: search.selects,
            widePageSelects: widePage.selects,
            searchMatched,
          });
        } finally {
          closeDb(`${dataDir}/brain.db`);
        }
      }
    } finally {
      // The throwaway databases are the audit's own artefact; the report keeps the
      // numbers, and the files are deleted after the run by the caller.
    }

    const first = measurements[0]!;
    for (const row of measurements) {
      expect(
        row.listSelects,
        `列表读取的单元数应不随库大小增长（${row.items} 条时 ${row.listSelects}）`,
      ).toBe(first.listSelects);
      expect(
        row.searchSelects,
        `搜索的单元数应不随库大小增长（${row.items} 条时 ${row.searchSelects}）`,
      ).toBe(first.searchSelects);
      expect(
        row.widePageSelects,
        `翻到 100 条一页的单元数应不随库大小增长（${row.items} 条时 ${row.widePageSelects}）`,
      ).toBe(first.widePageSelects);
    }
    /*
     * The page-size comparison: 20 rows and 100 rows must cost the same units. A
     * statement prepared per returned row would make the 100-row read report five
     * times the 20-row one, which is exactly the N+1 shape.
     */
    expect(
      first.widePageSelects,
      `把每页从 20 条放大到 100 条不应增加单元数（20 条 ${first.listSelects}，100 条 ${first.widePageSelects}）`,
    ).toBe(first.listSelects);
    /*
     * A loose ceiling, because the exact number of subqueries is an implementation
     * detail and this file must not fail for a legitimate query being added. What
     * it *does* catch is the N+1 shape: twenty result rows read one-by-one would
     * be at least twenty units, and every row's tags read separately would be
     * forty. The calibration below is what makes that a measurement.
     */
    expect(first.searchSelects, '一次搜索应当是常数个单位，而不是每行一个').toBeLessThanOrEqual(24);
    expect(
      measurements[measurements.length - 1]!.searchMatched,
      '大库上的搜索应当真的命中很多行，否则"计数不增长"只是因为没查到东西',
    ).toBeGreaterThan(100);

    /*
     * Proves the metric can see per-row work at all, so the assertions above are
     * not passing because the counter is blind.
     *
     * The connection is closed again: leaving one open would hold the file, and
     * the *next* case's `--reset` seed would fail with a Windows `EPERM` instead
     * of measuring anything. (That is how this was found.)
     */
    const controlRows = 50;
    const controlPath = `${benchDataDir('small')}/brain.db`;
    const controlDb = getDb({ databasePath: controlPath });
    let controlSelects = 0;
    try {
      controlSelects = controlPerRowReads(controlDb, controlRows).selects;
    } finally {
      closeDb(controlPath);
    }
    expect(
      controlSelects,
      `对照组：故意按行读 ${controlRows} 行必须报 ${controlRows} 个单位（实测 ${controlSelects}）`,
    ).toBe(controlRows);

    const firstScreen = measurements[0]!;
    console.log(
      [
        '',
        '===== T079-R04 列表与搜索语句数 =====',
        '| 规模 | 条目 | 列表读取单元（20/100 条一页） | 搜索单元 | 搜索命中 |',
        '| --- | --- | --- | --- | --- |',
        ...measurements.map(
          (row) =>
            `| ${row.scale} | ${row.items} | ${row.listSelects} / ${row.widePageSelects} | ${row.searchSelects} | ${row.searchMatched} |`,
        ),
        '口径：setAuthorizer 统计 SQLITE_SELECT 次数，一条语句含嵌套子查询会计多次；',
        `单元数不随库大小、也不随每页条数变化即为通过（首次样本 ${firstScreen.listSelects}/${firstScreen.widePageSelects}/${firstScreen.searchSelects}）。`,
        `对照组：按行读 ${controlRows} 行报告 ${controlSelects} 个单位，证明计数能看见 N+1。`,
        '',
      ].join('\n'),
    );
  });

  test('T079-R04 子图与新鲜度：读取不按节点数或漂移数逐条放大', async () => {
    const rows: { label: string; nodes: number; edges: number; selects: number }[] = [];

    for (const scale of ['small', 'target'] as const) {
      const dataDir = benchDataDir(scale);
      await seedScale(scale, dataDir);
      const db = getDb({ databasePath: `${dataDir}/brain.db` });
      try {
        const tagId = graphTagId(db);
        let nodes = 0;
        let edges = 0;
        const counted = countStatements(db, () => {
          const graph = getGraphData(db, { filter: { tagId } }, 1);
          nodes = graph.nodes.length;
          edges = graph.edges.length;
        });
        expect(nodes, '子图应真的画出节点').toBe(SCALES[scale].graph);
        expect(edges, '子图应真的画出边').toBeGreaterThan(0);
        rows.push({ label: scale, nodes, edges, selects: counted.selects });
      } finally {
        closeDb(`${dataDir}/brain.db`);
      }
    }

    /*
     * 40 nodes vs 200 nodes: five times the nodes and five times the edges must
     * not mean five times the queries. This is the assertion that would catch a
     * per-node endpoint lookup, which is exactly the N+1 shape R04 names.
     */
    expect(
      rows[1]!.selects,
      `子图读取的语句数不应随节点数放大（${rows[0]!.nodes} 节点 ${rows[0]!.selects} 条语句 vs ${rows[1]!.nodes} 节点 ${rows[1]!.selects} 条语句）`,
    ).toBe(rows[0]!.selects);

    /*
     * Freshness: the cost is meant to follow the *drift*, not the snapshot. A
     * healthy view of the same content must not cost more than a drifted one by
     * any margin proportional to how many sources it has.
     */
    const dataDir = benchDataDir('target');
    await seedScale('target', dataDir);
    const db = getDb({ databasePath: `${dataDir}/brain.db` });
    let healthySelects = 0;
    let driftedSelects = 0;
    let snapshotSources = 0;
    try {
      const viewId = graphViewId(db);
      healthySelects = countStatements(db, () => {
        getViewFreshness(db, viewId);
      }).selects;

      /*
       * Move one source's raw version, so exactly one source has drifted.
       *
       * Read through `SourceSnapshot['items']` — `{"items":[{id,…}],"relations":[]}`
       * — rather than guessing at the JSON shape: a `json_extract` path that does
       * not match returns NULL, which would have made this case fail for a reason
       * unrelated to what it measures.
       */
      const snapshot = JSON.parse(
        String(
          (db.prepare('SELECT source_snapshot_json AS raw FROM views WHERE id = ?').get(viewId) as {
            raw: string;
          }).raw,
        ),
      ) as { items: { id: string }[] };
      snapshotSources = snapshot.items.length;
      expect(snapshotSources, '视图快照应有来源条目').toBeGreaterThan(0);
      const sourceId = snapshot.items[0]!.id;

      db.prepare('UPDATE knowledge_items SET raw_version = raw_version + 1 WHERE id = ?').run(
        sourceId,
      );

      driftedSelects = countStatements(db, () => {
        getViewFreshness(db, viewId);
      }).selects;
    } finally {
      closeDb(`${dataDir}/brain.db`);
    }

    /*
     * One drifted source may add the title lookup and nothing more; a per-source
     * read would add one select per snapshot entry — hundreds here, which is what
     * makes this the freshness-shaped N+1.
     */
    expect(
      driftedSelects - healthySelects,
      `一条来源漂移只应增加常数个单位（健康 ${healthySelects}，漂移 ${driftedSelects}，快照 ${snapshotSources} 条来源）`,
    ).toBeLessThanOrEqual(4);

    console.log(
      [
        '',
        '===== T079-R04 子图与新鲜度语句数 =====',
        '| 场景 | 节点 | 边 | 单元数 |',
        '| --- | --- | --- | --- |',
        ...rows.map((row) => `| 子图（${row.label}） | ${row.nodes} | ${row.edges} | ${row.selects} |`),
        `| 新鲜度（健康视图，快照 ${snapshotSources} 条来源） | — | — | ${healthySelects} |`,
        `| 新鲜度（一条来源漂移后） | — | — | ${driftedSelects} |`,
        '',
      ].join('\n'),
    );
  });

  test('T079-R04 画布实例与每帧写入：拖一个节点只产生一次请求', async ({ page }) => {
    const dataDir = benchDataDir('small');
    await seedScale('small', dataDir);
    const server = await startBenchServer(dataDir);
    const facts = formatEnvironment(await environmentFacts(page));

    try {
      const headers = server.headers;
      const viewsResponse = await fetch(`${server.origin}/api/views`, { headers });
      expect(viewsResponse.status, 'GET /api/views 应返回 200').toBe(200);
      const views = (await viewsResponse.json()) as {
        data: { views: { id: string; kind: string }[] };
      };
      const graphView = views.data.views.find((view) => view.kind === 'graph');
      expect(graphView, '基准库应含一张关系图视图').toBeTruthy();

      await page.goto(`${server.origin}/graph`);
      await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: 60_000 });
      await page.getByTestId('graph-view-select').selectOption(graphView!.id);
      await expect(page.getByTestId('graph-node').first()).toBeVisible({ timeout: 60_000 });

      /*
       * Exactly one canvas instance.
       *
       * R04's 重复图实例 is the T057/T066 class of defect: a second React Flow
       * instance left mounted behind the first, or a remount that never tore the
       * old one down. Counting the DOM is the honest form of that check — the
       * instance *is* the container React Flow renders.
       */
      const canvasCount = await page.getByTestId('graph-canvas').count();
      const flowCount = await page.locator('.react-flow').count();
      expect(canvasCount, '页面上应只有一个图实例').toBe(1);
      expect(flowCount, 'React Flow 容器应只有一个').toBe(1);

      const putRequests: { at: number; url: string }[] = [];
      const graphReads: string[] = [];
      page.on('request', (request) => {
        const url = request.url();
        if (request.method() === 'PUT' && url.includes('/layout')) {
          putRequests.push({ at: Date.now(), url });
        }
        if (request.method() === 'POST' && /\/api\/graph/u.test(url)) graphReads.push(url);
      });

      const node = page.getByTestId('graph-node').first();
      const itemId = await node.getAttribute('data-item-id');
      expect(itemId, '图节点应带有条目 id').toBeTruthy();
      await node.scrollIntoViewIfNeeded();
      const box = await node.boundingBox();
      expect(box, '节点应有可拖动的几何位置').toBeTruthy();

      const startX = box!.x + box!.width / 2;
      const startY = box!.y + box!.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      // Ten intermediate moves, i.e. ten frames of a real drag.
      for (let step = 1; step <= 10; step += 1) {
        await page.mouse.move(startX + step * 6, startY + step * 4, { steps: 2 });
      }
      const duringDrag = putRequests.length;
      const readsDuringDrag = graphReads.length;
      await page.mouse.up();

      /*
       * The write is debounced (600 ms) and only the drop is reported, so the
       * assertion has two halves: nothing during the drag, exactly one after it.
       * Waiting past the debounce is the measurement, not a sleep to hide a race —
       * the state being checked is "the debounce fired", which only time reveals.
       */
      await expect
        .poll(() => putRequests.length, { timeout: 15_000, message: '拖动结束后应写出一次布局' })
        .toBe(1);

      expect(duringDrag, '拖动过程中不应写入布局（每帧写是 T047-R02 禁止的）').toBe(0);
      expect(readsDuringDrag, '拖动不应重新读取整张子图').toBe(0);

      // And the canvas did not multiply while interacting.
      expect(await page.getByTestId('graph-canvas').count(), '交互后仍应只有一个图实例').toBe(1);

      console.log(
        [
          '',
          '===== T079-R04 画布实例与每帧写入 =====',
          facts,
          `图实例：画布 ${canvasCount} 个、React Flow 容器 ${flowCount} 个（预算：各 1）`,
          `拖动 10 帧期间的布局写入：${duringDrag} 次（预算：0）；拖动期间的子图重读：${readsDuringDrag} 次（预算：0）`,
          `拖动结束后布局写入：${putRequests.length} 次（预算：1）`,
          '未覆盖：React 渲染次数（需要注入 profiler），本用例以"无每帧请求"作为代理观察。',
          '',
        ].join('\n'),
      );
    } finally {
      await server.stop();
    }
  });
});
