'use client';

/**
 * Mermaid rendering lifecycle (T065-R01/R05, T066-R01–R04/R06).
 *
 * One hook owns everything about turning a compiled string into a sanitized SVG,
 * because the failure modes here are all about *when* work lands rather than what
 * the work is:
 *
 *  1. **Only the newest render may be applied (T066-R01).** Each attempt takes a
 *     monotonic token, and the token is re-checked immediately before the state
 *     write. Switching from flow A to flow B while A is still drawing therefore
 *     cannot let A's late SVG replace B's — the picture on screen is always the
 *     picture of the `source` currently passed in.
 *  2. **Unmount invalidates everything (T066-R02).** The effect's cleanup raises
 *     the token and sets `disposed`, so a promise that resolves after the user has
 *     left the page writes no state at all — no update to an unmounted component,
 *     no React warning, no phantom canvas.
 *  3. **Mermaid is initialised once, by this module, with fixed options
 *     (T065-R01/R02).** The import is dynamic (the library touches `window` at
 *     module scope) and `initialize` runs exactly once per page. Nothing derived
 *     from a view's content, title or intent reaches that configuration — the
 *     `securityLevel` and the HTML-label switch are constants, so a label reading
 *     `securityLevel "loose"` is text in a box and cannot become a setting.
 *  4. **Calls are serialized (T066-R03).** Mermaid keeps a *single* module-level
 *     configuration and a shared DOM scratch area, so two overlapping `render`
 *     calls are two writers to the same state. A module-level promise chain makes
 *     the calls take turns; because each call also passes its own unique id, a
 *     queued diagram cannot be drawn into the other's temporary node.
 *  5. **Nothing is re-rendered for a resize (T066-R04).** The size observer
 *     publishes the measured box for the layout and for the test that asserts
 *     "no new render", but the render effect does not depend on it. Re-analysis on
 *     a window drag would be both pointless and, in a paid pipeline, alarming.
 *
 * The returned SVG is sanitized *here*, before it is handed out (T065-R03), and
 * the sanitized string is the only thing any caller ever gets — so the display
 * path and the export path cannot be given different pictures (T065-R06).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { findUnsafeSvgMarkup, sanitizeSvgString } from './sanitizeSvg';

/**
 * Fixed Mermaid configuration (T065-R01/R02).
 *
 * `securityLevel: 'strict'` is the setting the contract names, and it stays
 * `'strict'` in WebAssembly-mutable form: nothing here is a function of the view.
 * `htmlLabels: false` is what makes `foreignObject` unnecessary, which is why the
 * sanitizer can forbid it without losing label text (T065-R03). `startOnLoad:
 * false` keeps the library from scanning the document for `class="mermaid"` nodes
 * — this application renders exactly one diagram, on demand, under React's
 * control.
 *
 * Exported so a test can assert the values without importing the library.
 */
export const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'neutral',
  htmlLabels: false,
  maxTextSize: 20_000,
  maxEdges: 200,
  flowchart: {
    htmlLabels: false,
    useMaxWidth: true,
    curve: 'basis',
  },
} as const;

/** Stable prefix for the temporary DOM ids Mermaid creates while rendering. */
const SCRATCH_ID_PREFIX = 'd';

export type MermaidPhase = 'idle' | 'pending' | 'ready' | 'failed';

export interface MermaidRenderState {
  phase: MermaidPhase;
  /** The sanitized SVG, present only in `ready`. */
  svg: string | null;
  /** Readable failure reason, present only in `failed`. */
  error: string | null;
  /** How many times `mermaid.render` was actually invoked for this instance. */
  attempts: number;
  /** The `source` the current `svg` belongs to, so a stale picture is detectable. */
  renderedSource: string | null;
}

export interface UseMermaidRenderResult extends MermaidRenderState {
  /** Re-run the local renderer only. Never a model call, never a paid request. */
  retry: () => void;
  /** The measured container box, for layout assertions (T066-C04). */
  size: { width: number; height: number };
  /** Attach to the element whose box should be observed. */
  observeSize: (element: HTMLElement | null) => void;
}

/**
 * Seam for the acceptance suite: make the *local* renderer fail on purpose.
 *
 * `tests/e2e/flow-lifecycle.spec.ts` has to observe what the user sees when
 * Mermaid cannot draw — the text fallback, the error code, and a retry that costs
 * nothing. The honest way to produce that state is to break the renderer, not to
 * assert against a component that was handed a pre-broken string: the latter
 * would prove the fallback renders, not that the *failure path* leads to it.
 *
 * It is installed on `window` by the spec, only ever read here, and unavailable
 * in a normal session. Crucially it cannot widen what the renderer is willing to
 * do: the hook still loads Mermaid, still sanitizes and still verifies, and a
 * thrown error is reported exactly like a real one.
 */
export const FLOW_RENDER_FAILURE_FLAG = '__feiniForceFlowRenderFailure';

function forcedRenderFailure(): Error | null {
  if (typeof window === 'undefined') return null;
  const flag = (window as unknown as Record<string, unknown>)[FLOW_RENDER_FAILURE_FLAG];
  if (flag !== true) return null;
  return new Error('（测试注入）渲染器被要求失败');
}

/**
 * The single global render queue.
 *
 * A promise chain rather than a boolean flag: the flag would drop the second
 * request, and dropping a render is a blank diagram, whereas taking turns costs
 * one extra frame. Errors are swallowed *for the chain only* — the awaited result
 * still rejects to its own caller, so a failed render is reported where it
 * happened instead of poisoning every later render.
 */
let renderQueue: Promise<unknown> = Promise.resolve();

function withMermaidLock<T>(task: () => Promise<T>): Promise<T> {
  const result = renderQueue.then(task, task);
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** The library's shape, as much of it as this module uses. */
interface MermaidApi {
  initialize: (config: unknown) => void;
  render: (id: string, source: string) => Promise<{ svg: string }>;
}

let mermaidLoader: Promise<MermaidApi> | null = null;

/**
 * Import and configure Mermaid exactly once per page (T065-R01/R02).
 *
 * Idempotent by construction: the promise is memoized, so the tenth component to
 * ask gets the same instance and `initialize` has run once. A *failed* load clears
 * the memo, so "retry render" after a transient failure is a real retry rather
 * than a replay of the cached rejection.
 */
function loadMermaid(): Promise<MermaidApi> {
  if (mermaidLoader === null) {
    mermaidLoader = (async () => {
      if (typeof document === 'undefined') {
        throw new Error('当前环境没有浏览器 DOM，无法渲染流程图');
      }
      // Dynamic on purpose: a static import would evaluate the library during the
      // server prerender pass, where `window` does not exist.
      const loaded = await import('mermaid');
      const mermaid = loaded.default as MermaidApi;
      mermaid.initialize(MERMAID_CONFIG);
      return mermaid;
    })();
    mermaidLoader.catch(() => {
      mermaidLoader = null;
    });
  }
  return mermaidLoader;
}

/**
 * Delete Mermaid's own scratch node for an id.
 *
 * Mermaid builds the diagram inside a temporary `div` appended to `<body>` and
 * normally removes it. When the render throws it does not, which leaves an empty
 * node — and, for a failed attempt repeated on every keystroke, a growing pile of
 * them (T065-R05, T066-C04).
 *
 * Two guards keep this from deleting something it should not: only the prefixed
 * scratch id is considered, and only when the node is a direct child of `<body>`.
 * The rendered SVG carries the unprefixed id and lives inside the component's own
 * container, so it can never match either condition.
 */
function removeScratchNode(id: string): void {
  if (typeof document === 'undefined') return;
  const node = document.getElementById(`${SCRATCH_ID_PREFIX}${id}`);
  if (node !== null && node.parentElement === document.body) node.remove();
}

/**
 * Render one compiled source to a sanitized SVG string.
 *
 * Exported so a test can drive the exact production path (lock, unique id, scratch
 * cleanup, sanitize, verify) without a React tree. `bindFunctions` is deliberately
 * not called and not returned: it is how Mermaid attaches handlers parsed out of
 * the diagram source, which is exactly the capability T065-R04 refuses. Source
 * interaction is a React panel beside the picture, driven by item ids.
 */
export async function renderFlowSvg(input: { source: string; id: string }): Promise<string> {
  const forced = forcedRenderFailure();
  if (forced !== null) throw forced;
  const mermaid = await loadMermaid();
  try {
    const result = await withMermaidLock(() => mermaid.render(input.id, input.source));
    const sanitized = sanitizeSvgString(result.svg);
    // Verify what was actually produced rather than trusting the sanitizer call:
    // a build with a different DOMPurify profile, or a shim in a test environment,
    // would otherwise be able to hand an unsafe string to the canvas.
    const problems = findUnsafeSvgMarkup(sanitized);
    if (problems.length > 0) {
      throw new Error(`渲染结果没有通过安全净化：${problems.join('、')}`);
    }
    return sanitized;
  } finally {
    removeScratchNode(input.id);
  }
}

/** A DOM id safe for Mermaid's scratch node, derived from React's unique id. */
function toSafeIdSuffix(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/gu, '');
  return cleaned.length > 0 ? cleaned : 'mermaid';
}

export function useMermaidRender(
  options: { source: string | null; unavailableMessage?: string } = { source: null },
): UseMermaidRenderResult {
  const { source, unavailableMessage } = options;

  /**
   * Unique per component instance, and stable across its re-renders.
   *
   * React guarantees this is different for every mounted instance, which is what
   * makes "two flows on one page" two scratch nodes rather than one shared id
   * (T065-R05, T066-C06). The render attempt is appended to it so a retry uses a
   * fresh scratch node rather than reusing the one that just failed.
   */
  const idBase = toSafeIdSuffix(useId());

  const [state, setState] = useState<MermaidRenderState>({
    phase: 'idle',
    svg: null,
    error: null,
    attempts: 0,
    renderedSource: null,
  });
  const [attempt, setAttempt] = useState(0);
  const [size, setSize] = useState({ width: 0, height: 0 });

  /** The newest attempt. Anything older must not write (T066-R01). */
  const currentToken = useRef(0);

  useEffect(() => {
    if (source === null) {
      // Nothing drawable: a honest "nothing to show" rather than a stale picture
      // left over from the previous view.
      currentToken.current += 1;
      setState((previous) =>
        previous.phase === 'idle' && previous.svg === null && previous.attempts === 0
          ? previous
          : { phase: 'idle', svg: null, error: null, attempts: previous.attempts, renderedSource: null },
      );
      return;
    }

    const token = currentToken.current + 1;
    currentToken.current = token;
    let disposed = false;

    setState((previous) => ({
      phase: 'pending',
      svg: null,
      error: null,
      attempts: previous.attempts + 1,
      renderedSource: null,
    }));

    void (async () => {
      try {
        const svg = await renderFlowSvg({ source, id: `${idBase}-${token}-${attempt}` });
        // Both checks matter and neither subsumes the other: `token` catches a
        // superseded attempt of the *same* component, `disposed` catches an attempt
        // whose component is gone.
        if (disposed || token !== currentToken.current) return;
        setState((previous) => ({
          phase: 'ready',
          svg,
          error: null,
          attempts: previous.attempts,
          renderedSource: source,
        }));
      } catch (caught) {
        if (disposed || token !== currentToken.current) return;
        setState((previous) => ({
          phase: 'failed',
          svg: null,
          error:
            caught instanceof Error && caught.message.length > 0
              ? caught.message
              : (unavailableMessage ?? '流程图渲染失败'),
          attempts: previous.attempts,
          renderedSource: null,
        }));
      }
    })();

    return () => {
      // Raising the token is what makes a late promise a no-op; `disposed` covers
      // the case where the whole component is unmounted (T066-R02).
      disposed = true;
      currentToken.current += 1;
    };
    // `size` is deliberately absent: a resize must not re-render (T066-R04).
  }, [source, attempt, idBase, unavailableMessage]);

  /**
   * Re-run the renderer.
   *
   * Nothing here touches the network, the database or a model: the compiled source
   * is already in memory, so a browser-side rendering failure can always be retried
   * for free (T066-R05, T066-C03).
   */
  const retry = useCallback(() => {
    setAttempt((previous) => previous + 1);
  }, []);

  /**
   * Observe the container's box.
   *
   * The measurement is published for the layout and for the acceptance test that
   * asserts a resize changes nothing else; it is *not* an input to the render
   * effect, so a window drag cannot trigger either a recompile or a model call
   * (T066-R04).
   */
  const observerRef = useRef<ResizeObserver | null>(null);
  const observeSize = useCallback((element: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (element === null) return;
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      const next = { width: Math.round(box.width), height: Math.round(box.height) };
      // Only publish a *change*. `observe()` fires the callback once immediately,
      // so re-observing the same box would otherwise write a new object identity
      // and cost a render for a measurement that did not move (T066-C04).
      setSize((previous) =>
        previous.width === next.width && previous.height === next.height ? previous : next,
      );
    });
    observer.observe(element);
    observerRef.current = observer;
  }, []);

  // Disconnect on unmount, so a detached canvas keeps no observer alive
  // (T066-R02, and the "cleanup must not leak" half of T065-R05).
  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
  }, []);

  return { ...state, retry, size, observeSize };
}
