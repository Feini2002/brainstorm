import { test as base, expect, type Page } from '@playwright/test';

import { watchConsoleErrors, type ConsoleWatch } from './consoleWatch';
import { E2E_DATA_DIR } from './env';
import { observeTraffic, type TrafficObserver } from './harness';

/**
 * e2e fixtures.
 *
 * `traffic` is a fixture rather than a per-spec call so that *every* case in this
 * suite records its network activity by construction. A spec that forgot to opt
 * in would be able to claim "no external request" without evidence, which is
 * precisely the claim T024-R05/T026-R05 must not rest on.
 *
 * `consoleWatch` is registered as an **auto** fixture for the same reason, one rule
 * later (T078-R03). Opt-in would have covered whichever spec remembered to ask for
 * it — measured: exactly one of 23 specs — which is not "监听 console 与 pageerror"
 * in any useful sense. Auto is also what makes the teardown assertion
 * unconditional: a case cannot observe an uncaught exception and then return green
 * by not requesting the fixture. See `consoleWatch.ts` for the three rules that are
 * excused and why "no rule matched" is a failure rather than a warning.
 */
export interface E2EFixtures {
  traffic: TrafficObserver;
  consoleWatch: ConsoleWatch;
}

export const test = base.extend<E2EFixtures>({
  // Playwright calls this second argument `use`; renaming it avoids colliding
  // with the React hooks lint rule, which reads `use(` as a hook call.
  traffic: async ({ page }: { page: Page }, provide) => {
    const observer = await observeTraffic(page);
    await provide(observer);
  },

  consoleWatch: [
    async ({ page }: { page: Page }, provide) => {
      const watch = watchConsoleErrors(page);
      await provide(watch);
      try {
        // Both lists are asserted, but the page-error one first: an uncaught
        // exception is the stronger finding and should be the message a reader
        // sees even when a console error also happened.
        expect(
          watch.unexpectedPageErrors(),
          '不应出现未捕获异常（T078-R03）；这不是白名单问题，请按栈定位组件',
        ).toEqual([]);
        expect(
          watch.unexpectedConsoleErrors(),
          '出现未被规则解释的 console.error（T078-R03）：请先确认是产品缺陷，再决定是否新增豁免规则',
        ).toEqual([]);
      } finally {
        watch.stop();
      }
    },
    // `auto` so every case in the suite is watched without asking (T078-R03).
    { auto: true },
  ],
});

export { expect };
export { E2E_DATA_DIR };
export { revealDiagnostics, revealMindmapOutline } from './harness';

/**
 * Put the app on a known route before the case body runs.
 *
 * Every case starts from `/inbox` so a failure cannot be caused by leftover
 * navigation state from the previous spec (docs/05_tests/G1 公共测试装置).
 */
export async function gotoInbox(page: Page): Promise<void> {
  await page.goto('/inbox');
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await expect(page.getByTestId('capture-input')).toBeVisible();
}
