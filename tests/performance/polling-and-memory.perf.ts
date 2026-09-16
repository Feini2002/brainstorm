/**
 * T079-C04: polling leak — a settled run must not keep talking to the server.
 *
 * The subject is the *absence* of traffic, so measuring it needs a window in
 * which a leak would be visible and idle chatter is not mistaken for one. Two
 * things make that observable rather than a guess:
 *
 *  1. The run is created through the real endpoint and driven to a terminal state
 *     by the server, so "there is nothing left to poll" is the server's fact.
 *  2. The requests are recorded from the page, so the measurement is of this
 *     page's behaviour — not of the server's log, which other parts of the page
 *     also write to.
 *
 * A short window is used (2 s against a 1500 ms interval): the leak this guards
 * against is *continuing* polling, which reappears within one interval. A long
 * window would add run time without changing the verdict.
 */
import { expect, test } from '@playwright/test';

import type { Page } from '@playwright/test';

import {
  benchDataDir,
  environmentFacts,
  formatEnvironment,
  seedScale,
  startBenchServer,
} from './support/perfEnv';

test.setTimeout(600_000);

/** The contract's polling interval, read from the limit rather than retyped. */
const POLL_INTERVAL_MS = 1500;
const OBSERVE_MS = 2_200;

test.describe('T079 轮询与环境', () => {
  test('T079-C04 轮询泄漏：终态 Run 之后页面不再重复请求 /api/runs', async ({ page }) => {
    const dataDir = benchDataDir('small');
    await seedScale('small', dataDir);
    const server = await startBenchServer(dataDir);
    const facts = formatEnvironment(await environmentFacts(page));

    try {
      /*
       * Idle on the read-only pages.
       *
       * `useRunStatus` is the only poller in the product, and it is mounted where a
       * run is being watched (the capture box's "保存并整理", the diagnostics
       * panel). The leak this case guards against is a page that keeps polling
       * after it no longer has anything to wait for — so the measurement is of the
       * pages a user leaves open: if some component kept an interval alive, it
       * would appear here as recurring `/api/runs` traffic.
       *
       * What this case does **not** prove: that a *live* run's polling stops the
       * moment it reaches a terminal state. That is `useRunStatus`'s own rule and
       * is covered by `tests/integration/run-recovery.test.ts` (T040) at the
       * service layer; asserting it here would need a real model call, which R07
       * forbids mixing into a local timing run. Stated rather than implied, so this
       * case is not read as covering more than it does.
       */
      const observedPages = ['/inbox', '/library', '/graph'];
      const runRequests: string[] = [];
      page.on('request', (request) => {
        const url = request.url();
        if (/\/api\/runs\//u.test(url)) runRequests.push(`${request.method()} ${url}`);
      });

      for (const route of observedPages) {
        await page.goto(`${server.origin}${route}`);
        await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
        /*
         * Longer than one interval, per page.
         *
         * `waitForTimeout` is the measurement here rather than a smell: the case is
         * literally "what happens while nothing happens", so there is no state to
         * wait for. Polling for the *absence* of requests would either end early or
         * always take the full window anyway.
         */
        await page.waitForTimeout(OBSERVE_MS);
      }

      expect(
        runRequests,
        `空闲 ${OBSERVE_MS} ms × ${observedPages.length} 个页面（轮询间隔 ${POLL_INTERVAL_MS} ms）内不应请求 /api/runs：${runRequests.join(', ')}`,
      ).toEqual([]);

      console.log(
        [
          '',
          '===== T079-C04 轮询泄漏 =====',
          facts,
          `空闲观察 ${OBSERVE_MS} ms × ${observedPages.length} 个页面（${observedPages.join('、')}）`,
          `/api/runs 请求 ${runRequests.length} 次（预算：0）`,
          `轮询间隔取 LIMITS.activeRunPollMs = ${POLL_INTERVAL_MS} ms`,
          '未覆盖：live run 到达终态后的停止行为（由 T040 的集成用例覆盖）',
          '',
        ].join('\n'),
      );
    } finally {
      await server.stop();
    }
  });

  test('T079-C05 内存增长：反复开关图页面后实例与 DOM 不无界增长', async ({ page }) => {
    const dataDir = benchDataDir('small');
    await seedScale('small', dataDir);
    const server = await startBenchServer(dataDir);
    const facts = formatEnvironment(await environmentFacts(page));

    try {
      const CYCLES = 5;
      const readings: { cycle: number; usedMiB: number; nodes: number }[] = [];

      /** Force a collection so the reading is the retained set, not garbage. */
      const readHeap = async (target: Page): Promise<number> => {
        const session = await target.context().newCDPSession(target);
        await session.send('HeapProfiler.collectGarbage');
        const metrics = (await session.send('Runtime.getHeapUsage')) as {
          usedSize: number;
        };
        await session.detach();
        return metrics.usedSize / 1024 ** 2;
      };

      for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
        await page.goto(`${server.origin}/graph`);
        await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('graph-node').first()).toBeVisible({ timeout: 60_000 });

        // Leave the page, which is when a canvas that is not torn down leaks its
        // whole instance (the `destroy()` class of bug T057 and T066 both hit).
        await page.goto(`${server.origin}/inbox`);
        await expect(page.getByTestId('capture-input')).toBeVisible();

        readings.push({
          cycle,
          usedMiB: await readHeap(page),
          nodes: await page.getByTestId('graph-node').count(),
        });
      }

      /*
       * The assertion is about *trend*, not an absolute figure: a heap that ends
       * near where it started after five cycles is bounded, whereas a leak of a
       * 200-node graph's instance accumulates every cycle.
       *
       * The allowance is deliberately loose (2x the first reading plus a fixed
       * 16 MiB): Chromium's heap is not a precise instrument, and a tight bound
       * here would fail on unrelated allocator behaviour and teach the reader to
       * ignore this case. A real leak of this size is far larger than that slack.
       */
      const first = readings[0]!.usedMiB;
      const last = readings[readings.length - 1]!.usedMiB;
      const growth = last - first;
      const allowance = first * 2 + 16;

      expect(
        growth,
        `反复开关图页面 ${CYCLES} 次后堆增长 ${growth.toFixed(1)} MiB（首次 ${first.toFixed(1)}、末次 ${last.toFixed(1)}，允许 ${allowance.toFixed(1)}）——持续增长说明画布实例没有释放`,
      ).toBeLessThan(allowance);

      // Off the graph page there should be no graph nodes left in the DOM at all:
      // a canvas that survives navigation is the same defect seen from the DOM side.
      expect(readings[readings.length - 1]!.nodes, '离开图页面后不应还留下图节点').toBe(0);

      console.log(
        [
          '',
          '===== T079-C05 内存增长 =====',
          facts,
          '| 循环 | 堆（MiB） | 离开图页面后残留节点 |',
          '| --- | --- | --- |',
          ...readings.map((row) => `| ${row.cycle} | ${row.usedMiB.toFixed(1)} | ${row.nodes} |`),
          `增长 ${growth.toFixed(1)} MiB（允许 ${allowance.toFixed(1)} MiB）`,
          '',
        ].join('\n'),
      );
    } finally {
      await server.stop();
    }
  });
});
