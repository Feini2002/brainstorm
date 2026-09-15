/**
 * Bundle entry for the T065/T066 browser sandbox.
 *
 * This file exists so a test can run the **production** sanitizer and renderer in a
 * real browser. It is not a test seam and adds no behaviour: it only re-exports the
 * functions the two modules already export, and `flowSandbox.ts` bundles it with
 * esbuild and injects the result into a real Chromium page.
 *
 * The reason a bundle is needed at all is a measured constraint:
 * `dompurify` needs `window`/`document` before it will attach `sanitize` (in the
 * Node environment used by this repo's other vitest projects, `isSupported === false`
 * and `typeof D.sanitize === 'undefined'`). So "did the sanitizer really run, and
 * what came out" can only be answered where there is a DOM — which is also where the
 * product runs (T065-C01's observation method is 「没有脚本执行或外部请求」).
 */
export {
  sanitizeSvgString,
  findUnsafeSvgMarkup,
  SVG_ALLOWED_TAGS,
  SVG_ALLOWED_ATTR,
  SVG_FORBIDDEN_TAGS,
} from '@/features/flow/sanitizeSvg';

export { renderFlowSvg, MERMAID_CONFIG, FLOW_RENDER_FAILURE_FLAG } from '@/features/flow/useMermaidRender';

export { compileFlow, assertFlowchartSource } from '@/domain/compileFlow';
