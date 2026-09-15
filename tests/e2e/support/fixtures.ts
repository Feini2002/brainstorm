import { test as base, expect, type Page } from '@playwright/test';

import { E2E_DATA_DIR } from './env';
import { observeTraffic, type TrafficObserver } from './harness';

/**
 * e2e fixtures.
 *
 * `traffic` is a fixture rather than a per-spec call so that *every* case in this
 * suite records its network activity by construction. A spec that forgot to opt
 * in would be able to claim "no external request" without evidence, which is
 * precisely the claim T024-R05/T026-R05 must not rest on.
 */
export interface E2EFixtures {
  traffic: TrafficObserver;
}

export const test = base.extend<E2EFixtures>({
  // Playwright calls this second argument `use`; renaming it avoids colliding
  // with the React hooks lint rule, which reads `use(` as a hook call.
  // `auto: true` is not used: `page` is needed to install the recorder, so the
  // fixture also depends on it and Playwright orders the setup accordingly.
  traffic: async ({ page }: { page: Page }, provide) => {
    const observer = await observeTraffic(page);
    await provide(observer);
  },
});

export { expect };
export { E2E_DATA_DIR };

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
