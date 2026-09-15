/**
 * A real-browser sandbox for the T065/T066 production code (T065-C01…C04, T066-C01/C06).
 *
 * ## Why a browser is required at all
 *
 * Two measured facts, not preferences:
 *
 *  1. `dompurify` does not attach `sanitize` without a DOM. In this repo's Node
 *     environment `DOMPurify.isSupported === false` and `typeof DOMPurify.sanitize`
 *     is `'undefined'`, and there is no jsdom/happy-dom in the dependency tree. So
 *     "did the sanitizer really run, and what came out" cannot be answered in-process.
 *  2. Mermaid is a browser library by construction.
 *
 * A hand-written DOM stub would make the assertions be about the stub. So this module
 * bundles the **production** entry (`flowRenderEntry.ts`) with esbuild and runs it in a
 * real Chromium:
 *
 *  - `sanitizeSvgString` is the real function from `src/features/flow/sanitizeSvg.ts`,
 *    with the real DOMPurify and the real allow-lists;
 *  - `renderFlowSvg` is the real function from `src/features/flow/useMermaidRender.ts`,
 *    so the render queue, the unique instance id, the scratch-node cleanup, the
 *    sanitize step and the post-sanitize verification all execute;
 *  - the result is assigned through `innerHTML`, which is what `MermaidRenderer`'s
 *    `dangerouslySetInnerHTML` does, so "no script ran and nothing was fetched" is
 *    observed on a live page rather than inferred from a returned string.
 *
 * ## What this cannot prove, and where that is proven instead
 *
 * React's own lifecycle (Strict Mode double-mount, effect cleanup, ResizeObserver
 * disconnect, the retry button) is not observable here. Those assertions are driven
 * through the real `/flow` page in `tests/e2e/flow-lifecycle.spec.ts`.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';

/**
 * Where the sandbox bundle is written.
 *
 * Deliberately *not* under `test-results/`: that is Playwright's `outputDir`, and
 * Playwright empties it at the start of every run. This bundle is built by the
 * `browser` *Vitest* project, so sharing that directory makes the two runners race
 * — a concurrent Playwright run could delete the bundle between the build and the
 * `page.addScriptTag` that loads it, surfacing as
 * `ENOENT: test-results\flow-sandbox\flow-sandbox.js` on an otherwise green suite.
 * A runner's scratch space must not live inside another runner's cleanup path.
 *
 * `node_modules/.cache/` is the conventional home for a build cache and is already
 * covered by the `/node_modules` entry in `.gitignore`.
 */
const BUNDLE_DIR = path.resolve(process.cwd(), 'node_modules', '.cache', 'flow-sandbox');

export interface CompileFlowResultLike {
  ok: boolean;
  compiled?: {
    source: string;
    nodeIdMap: Record<string, string>;
    compilerVersion: string;
  };
  issues?: { ids: string[]; message: string }[];
}

/**
 * The exports `flowRenderEntry.ts` puts on `window.FlowSandbox`, as the sandbox page
 * sees them. Typed here rather than imported: the test must not import `src/**`
 * directly, because that code is browser-only.
 */
export interface FlowSandboxApi {
  sanitizeSvgString: (svg: string) => string;
  findUnsafeSvgMarkup: (svg: string) => string[];
  SVG_ALLOWED_TAGS: readonly string[];
  SVG_ALLOWED_ATTR: readonly string[];
  SVG_FORBIDDEN_TAGS: readonly string[];
  renderFlowSvg: (input: { source: string; id: string }) => Promise<string>;
  compileFlow: (content: unknown) => CompileFlowResultLike;
  assertFlowchartSource: (source: string) => string[];
  MERMAID_CONFIG: { securityLevel: string; htmlLabels: boolean; startOnLoad: boolean };
  FLOW_RENDER_FAILURE_FLAG: string;
}

declare global {
  // `var` is required for a global augmentation; the rule that would flag it is
  // off for this construct by the lint config's own settings.
  var FlowSandbox: FlowSandboxApi;
}

let bundlePromise: Promise<string> | null = null;
let browser: Browser | null = null;

/**
 * Bundle the production entry once per process.
 *
 * `alias` mirrors `vitest.config.ts`'s `@ -> src` so the bundle resolves the same
 * imports the app does. The `.mjs` loader is needed because Mermaid ships plain
 * `.mjs`. `NODE_ENV` is defined as production, matching the built app.
 */
function buildBundle(): Promise<string> {
  if (bundlePromise === null) {
    bundlePromise = (async () => {
      mkdirSync(BUNDLE_DIR, { recursive: true });
      const outfile = path.join(BUNDLE_DIR, 'flow-sandbox.js');
      await build({
        entryPoints: [path.resolve('tests', 'browser', 'support', 'flowRenderEntry.ts')],
        bundle: true,
        format: 'iife',
        globalName: 'FlowSandbox',
        platform: 'browser',
        target: 'es2022',
        outfile,
        alias: { '@': path.resolve('src') },
        loader: { '.mjs': 'js' },
        logLevel: 'error',
        define: { 'process.env.NODE_ENV': '"production"' },
      });
      return outfile;
    })();
  }
  return bundlePromise;
}

export interface FlowSandboxHandle {
  page: Page;
  /** Uncaught page exceptions, in order. */
  pageErrors: string[];
  /** `console.error` output, kept separately so a noisy library does not look like a failure. */
  consoleErrors: string[];
  /** Every request the page made, in order. */
  requests: string[];
  /** Callback dialogs — a real `alert()` shows up here, not as an exception. */
  dialogs: string[];
  /** Empty the recorders, for a case that wants a clean slate. */
  resetRecorders: () => void;
  /** Empty the page body *and* the recorders. */
  resetPage: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * A blank page with the production bundle loaded and instrumentation installed.
 *
 * The body starts empty so a hostile SVG that managed to create an `<img>`, run a
 * handler or fetch something is visible from `document.body` and the request list,
 * rather than only as a diff of the app's own markup.
 */
export async function openFlowSandbox(): Promise<FlowSandboxHandle> {
  const bundle = await buildBundle();
  if (browser === null) browser = await chromium.launch();
  const page = await browser.newPage();

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const requests: string[] = [];
  const dialogs: string[] = [];

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('request', (request) => requests.push(request.url()));
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  await page.setContent('<!doctype html><html lang="zh-CN"><head></head><body></body></html>');
  // `addScriptTag({ path })` inlines the file's contents, so loading the sandbox is
  // not itself an HTTP request that would pollute the "no request happened" case.
  await page.addScriptTag({ path: bundle });
  await expect
    .poll(async () => page.evaluate(() => typeof globalThis.FlowSandbox?.sanitizeSvgString))
    .toBe('function');

  const resetRecorders = (): void => {
    pageErrors.length = 0;
    consoleErrors.length = 0;
    requests.length = 0;
    dialogs.length = 0;
  };

  return {
    page,
    pageErrors,
    consoleErrors,
    requests,
    dialogs,
    resetRecorders,
    resetPage: async () => {
      await page.evaluate(() => {
        document.body.replaceChildren();
      });
      resetRecorders();
    },
    close: async () => {
      await page.close();
    },
  };
}

/** Close the shared browser. Called from the suite's teardown. */
export async function closeFlowSandbox(): Promise<void> {
  await browser?.close();
  browser = null;
}

/** Requests that actually leave the machine's document: nothing local, nothing blank. */
export function externalRequests(requests: readonly string[]): string[] {
  return requests.filter(
    (url) => !url.startsWith('data:') && !url.startsWith('about:') && !url.startsWith('blob:'),
  );
}
