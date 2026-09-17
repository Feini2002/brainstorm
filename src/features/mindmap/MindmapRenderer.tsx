'use client';

/**
 * Markmap renderer (T057).
 *
 * Mounts one Markmap instance into one SVG for the lifetime of the component,
 * and owns the four things that go wrong when a third-party renderer is dropped
 * into React without an owner:
 *
 *  1. **Lifecycle (T057-R04).** `markmap-lib` and `markmap-view` touch `window`
 *     and `ResizeObserver` at construction, so they are imported *inside* the
 *     effect rather than at module scope: a static import would drag them into
 *     the prerender pass. Strict Mode's mount → unmount → mount then gets a real
 *     `destroy()` before the second instance is built, so there is never a second
 *     SVG, a second set of listeners, or a leaked observer. Both the instance and
 *     the SVG node are held in `ref`s, never in module-level state.
 *
 *     `destroy()` is called *before* clearing the SVG on purpose: the library
 *     removes its own `<style>`, zoom behaviour and node groups, and clearing the
 *     SVG first would leave those listeners attached to a detached tree.
 *
 *  2. **Fit policy (T057-R05).** `autoFit` is off. Fitting happens once, when a
 *     genuinely new markdown tree is mounted, and never on a re-render of the
 *     surrounding page — that is what keeps a user's manual zoom from being
 *     yanked back while they edit something else. The library's own container
 *     `ResizeObserver` still re-lays-out on a size change, which is the
 *     behaviour T057-C05 asks for, but a re-layout does not touch the zoom
 *     transform (`handleZoom` is the only writer of that `transform`), so a
 *     container resize cannot reset the viewport either.
 *
 *  3. **Sanitization (T057-R02).** The transformed tree is sanitized before
 *     `setData`; see `sanitizeContent.ts` for why the HTML has to be treated as
 *     untrusted even though *we* compiled it.
 *
 *  4. **Failure (T057-R06).** Every failure path — a missing browser API, a
 *     transform that throws, a `setData` that rejects — is reported as an error
 *     beside the renderer. The caller is expected to render the outline from the
 *     stored AST next to this component, so the sources stay reachable even when
 *     the picture cannot be drawn. A thrown render never blanks the page.
 *
 * Network safety (T057-R03) is enforced by using the `no-plugins` entry point and
 * then *asserting* the transformer produced no assets. `markmap-lib`'s default
 * entry point would enable plugins whose CSS/JS (KaTeX, highlight.js, prism) are
 * exactly the model-triggered remote loads this rule forbids; importing
 * `no-plugins` removes the plugins, and the assertion is what keeps a future
 * dependency bump from quietly re-enabling them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { compileMindmap, inspectMindmapTree, mindmapMarkdownNodeIds } from '@/domain/compileMindmap';
import type { MindmapContent } from '@/domain/knowledge';
import { InlineError, LoadingIndicator } from '@/components/ui/primitives';

import { sanitizeTree, type TransformedRoot } from './sanitizeContent';

export interface MindmapRendererProps {
  content: MindmapContent;
  /**
   * Initial expand depth, counting the root as 1. `-1` expands everything.
   * Applied when the markdown changes, not on every render.
   */
  initialExpandLevel?: number;
  /** Called with the AST node id when a node is clicked. */
  onNodeSelect?: (nodeId: string) => void;
  /** The node to mark as current. Highlighted without rebuilding the map. */
  selectedNodeId?: string | null;
  /** Changes when the caller wants the viewport re-fitted to the whole map. */
  fitToken?: number;
  /** Called when the picture cannot be drawn, or with null once it can. */
  onRenderError?: (message: string | null) => void;
}

interface RendererHandle {
  /**
   * The library instance, typed structurally rather than as `Markmap`.
   *
   * A `import type` from `markmap-view` would put the library into the type graph
   * of every component that imports this one — including the server-rendered
   * shell — which is the opposite of the lazy import the effect performs. The
   * real operations are therefore exposed as closures created *inside* the
   * effect, where the library's own types are in scope.
   */
  /**
   * The library instance, or `null` while one is being built.
   *
   * `null` is a real state, not a gap: the effect publishes a handle as soon as the
   * library is attached to its node, and fills in the closures once `setData` and
   * the first `fit` have produced a data set worth operating on. Anything that
   * needs to *drive* the map must therefore tolerate "attached but not ready",
   * which is exactly the window a content change lands in.
   */
  instance: {
    destroy: () => void;
    fit: () => Promise<void>;
    /** Highlight one AST node by id, or clear the highlight with `null`. */
    highlight: (nodeId: string | null) => Promise<void>;
  } | null;
  svg: SVGSVGElement;
}

/**
 * How long a mounting attempt may stay unresolved before it is reported.
 *
 * Generous on purpose: a real mount settles in tens of milliseconds, so this only
 * fires for an attempt that is genuinely stuck rather than merely slow. It exists
 * because a stalled mount is otherwise unobservable — no error, no rejection, no
 * failed request — and the user would be left with a spinner that never resolves.
 */
const STALL_TIMEOUT_MS = 15_000;

/** Annotation key for the AST node id, so a click can name the node it hit. */
const NODE_ID_KEY = 'mmId';

/**
 * Index a rendered tree by the AST node id recorded on each node's payload.
 *
 * Generic over the node type on purpose. The objects passed to `setData` are
 * plain `IPureNode`s, but the library *upgrades them in place* while mounting —
 * it attaches a `state` record with layout geometry — and its own APIs
 * (`setHighlight`) demand those upgraded nodes. Reading the index off
 * `instance.state.data` after `setData` therefore yields exactly the type the
 * library asks for, without this module having to name it.
 */
function indexLiveById<T extends { children: T[]; payload?: { [key: string]: unknown } }>(
  root: T,
): Map<string, T> {
  const index = new Map<string, T>();
  const stack: T[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const id = node.payload?.[NODE_ID_KEY];
    if (typeof id === 'string') index.set(id, node);
    for (const child of node.children) stack.push(child);
  }
  return index;
}

/**
 * Look up the AST node id for a clicked DOM element.
 *
 * The id is attached to `payload` before `setData`, and the library copies the
 * payload onto the rendered data object, so it can be read back off the datum
 * d3 bound to the node group. Walking up from the event target is required: the
 * click lands on the inner `<div>` Markmap generated, not on the `<g>` holding
 * the datum.
 */
function nodeIdFromEvent(event: Event): string | null {
  let current: Element | null = event.target instanceof Element ? event.target : null;
  while (current) {
    const datum = readDatum(current);
    const nodeId = datum?.['payload'];
    if (nodeId && typeof nodeId === 'object') {
      const value = (nodeId as Record<string, unknown>)[NODE_ID_KEY];
      if (typeof value === 'string') return value;
    }
    current = current.parentElement;
  }
  return null;
}

/**
 * Read the d3-bound datum from an element.
 *
 * d3 stores it under a symbol-keyed property whose description is `data`, and
 * the symbol instance differs between d3 builds, so the property is found by
 * name instead of by importing d3. `__data__` is checked as a fallback because
 * that is the plain-property form older d3 releases used.
 */
function readDatum(element: Element): Record<string, unknown> | null {
  for (const key of Object.getOwnPropertySymbols(element)) {
    if (key.description !== 'data') continue;
    const value = (element as unknown as Record<symbol, unknown>)[key];
    if (value && typeof value === 'object') return value as Record<string, unknown>;
  }
  const direct = (element as unknown as { __data__?: unknown }).__data__;
  if (direct && typeof direct === 'object') return direct as Record<string, unknown>;
  return null;
}

export function MindmapRenderer({
  content,
  initialExpandLevel = -1,
  onNodeSelect,
  selectedNodeId = null,
  fitToken = 0,
  onRenderError,
}: MindmapRendererProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  /**
   * The live handle, or null.
   *
   * `svg` is the *published* instance's node and is only ever read for typing
   * purposes; the mount effect deliberately works from its own captured node rather
   * than from this ref, so a superseded attempt cannot act on its successor's tree.
   */
  const handleRef = useRef<RendererHandle | null>(null);

  /**
   * The markdown is derived from the AST, never from stored text.
   *
   * Compiling here rather than on the server means the renderer always draws the
   * canonical tree it was handed, so a cached or hand-edited markdown column
   * cannot become a second source of truth (T060-R01 has the same reason for
   * compiling exports from the tree).
   */
  /**
   * Compile the tree, and never let the compile itself take the route down.
   *
   * `compileMindmap` is iterative and total for any finite tree, so a throw here
   * means something genuinely unforeseen — a shape the structural check does not
   * cover. Catching it turns that into the T057-C06 outcome (a readable message
   * plus the outline) instead of a render-phase exception that blanks the page,
   * because this runs during render and a thrown error there is not catchable by
   * a caller.
   *
   * On failure `markdown` is null and the mount effect below does nothing, so no
   * instance, no `ResizeObserver` and no `setData` are ever created for content we
   * could not compile. The empty string is not used as the fallback: that would
   * compile to `# ` and render a blank-looking map, which reads as "your mindmap
   * is empty" rather than "this row cannot be drawn".
   */
  const compiled = useMemo(() => {
    try {
      return {
        markdown: compileMindmap(content),
        nodeIds: mindmapMarkdownNodeIds(content),
        failure: null as string | null,
      };
    } catch (caught) {
      return {
        markdown: null,
        nodeIds: [] as string[],
        failure: caught instanceof Error ? caught.message : '脑图内容无法编译',
      };
    }
  }, [content]);

  /**
   * Refuse a stored tree that cannot be drawn, before Markmap sees it.
   *
   * The check is structural only (T057-R06): a row edited by hand or written by
   * an older build can contain a cycle, two roots or an orphan branch, and those
   * are exactly the shapes a recursive renderer turns into an infinite loop or a
   * silently dropped subtree. The message names the offending nodes so the user
   * can act, and the outline the caller renders beside this component stays
   * readable either way.
   */
  const structureIssue = useMemo(() => inspectMindmapTree(content)[0] ?? null, [content]);

  /**
   * Identity of a mount attempt.
   *
   * The compiled markdown is the content identity, so an unrelated re-render does
   * not rebuild the map. A structural refusal has no markdown at all, so its own
   * message stands in as the key — otherwise every refused tree would share the
   * key `''` and a switch between two different broken views would look like the
   * same attempt.
   */
  const mountKey = structureIssue === null ? (compiled.markdown ?? '') : `structure:${structureIssue.message}`;

  /** The compiled markdown, or null when the tree could not be compiled. */
  const markdown = compiled.markdown;
  const nodeIds = compiled.nodeIds;

  /**
   * What the current mount attempt has produced.
   *
   * Keyed by the markdown it belongs to rather than cleared on change: a read of
   * `mount` for a *different* key is "no result yet", so switching to another
   * saved projection shows the loading state by derivation instead of by an effect
   * that blanks the previous map first (which would flash an empty canvas and,
   * worse, briefly offer the previous projection's sources against the new
   * selection).
   */
  const [mount, setMount] = useState<
    { key: string; phase: 'mounted' } | { key: string; phase: 'failed'; message: string } | null
  >(null);

  /**
   * Why the map cannot be drawn, or null.
   *
   * Three sources, in the order they are decided: the structural refusal (a
   * property of the input, so no stored state is needed), a compile failure, and
   * the mount attempt's own outcome keyed by the content it belongs to.
   */
  const error =
    structureIssue?.message ??
    compiled.failure ??
    (mount?.key === mountKey && mount.phase === 'failed' ? mount.message : null);
  const mounted = mount?.key === mountKey && mount.phase === 'mounted';

  useEffect(() => {
    onRenderError?.(error);
  }, [error, onRenderError]);

  const lastFitToken = useRef(fitToken);

  /**
   * Apply a requested re-fit.
   *
   * Deliberately separate from the markdown effect: re-fitting whenever the
   * *content* identity changes would fight the user's own zoom on every
   * unrelated re-render, and `fitToken` is the caller's explicit statement that
   * a re-fit is wanted.
   */
  useEffect(() => {
    if (lastFitToken.current === fitToken) return;
    lastFitToken.current = fitToken;
    // A token that arrives before an attempt has published its closures is dropped
    // rather than remembered: an attempt always fits once when it completes, so the
    // only way to get here early is a re-fit asked for during the initial mount,
    // which that first fit already satisfies.
    const instance = handleRef.current?.instance ?? null;
    if (instance === null) return;
    void instance.fit().catch(() => {
      // A failed fit only means the viewport is unchanged; it is not a reason to
      // replace a working map with an error.
    });
  }, [fitToken]);

  // ---- Mount: build the instance; unmount: destroy it (T057-R04) ----------
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    // Two reasons to build nothing, both reported by `error` without an instance:
    // the tree was refused structurally, or it could not be compiled at all.
    if (markdown === null || structureIssue !== null) return;

    let disposed = false;
    /**
     * The instance this attempt created, if any.
     *
     * Cleanup needs it, and it cannot read `handleRef` for it: the handle is only
     * published with its closures once `setData` and the first `fit` have both
     * succeeded, and an attempt that is cleaned up *between* those two steps owns a
     * live Markmap instance — with its own `ResizeObserver` and zoom listeners —
     * that was never fully published anywhere. Reading the ref there would leak
     * exactly that instance, which is the failure T057-C02 counts DOM to catch.
     *
     * Typed by the one operation cleanup performs rather than by the library's class,
     * which is not nameable out here (the import lives inside the effect).
     */
    let created: { destroy: () => void } | null = null;

    /** True once the instance was offered to Markmap, i.e. destroy() is meaningful. */
    let started = false;

    void (async () => {
      try {
        // Imported here so the library is never evaluated during prerender, and
        // so a browser without ResizeObserver fails into the outline path below
        // instead of taking the whole route down.
        //
        // `no-plugins` is the deliberate entry point: the default export would
        // enable the built-in plugins, whose assets (KaTeX, highlight.js,
        // prism.js CSS/JS) are exactly the model-triggered remote loads that
        // T057-R03 forbids. With no plugins, `getUsedAssets` is empty.
        const [{ Transformer }, { Markmap }] = await Promise.all([
          import('markmap-lib/no-plugins'),
          import('markmap-view'),
        ]);
        if (disposed) return;

        if (typeof ResizeObserver !== 'function') {
          throw new Error('当前浏览器不支持 ResizeObserver，无法渲染脑图');
        }

        const transformer = new Transformer([]);
        const result = transformer.transform(markdown);
        // Nothing to load, asserted rather than assumed: with no plugins the
        // transformer cannot report a feature, so an asset here means the entry
        // point changed underneath us.
        const assets = transformer.getUsedAssets(result.features);
        if ((assets.styles?.length ?? 0) > 0 || (assets.scripts?.length ?? 0) > 0) {
          throw new Error('脑图渲染器试图加载外部资源，已拒绝');
        }

        const tree = annotateTree(sanitizeTree(result.root), nodeIds);

        const instance = new Markmap(svg, {
          // The container's own observer drives re-layout; auto-fit would fight
          // the user's zoom, so it stays off (T057-R05).
          autoFit: false,
          initialExpandLevel,
          maxWidth: 300,
          duration: 200,
        });
        created = instance;
        started = true;
        // Published before `setData`, not after: the instance is already attached to
        // this node, so a cleanup arriving mid-`setData` has to be able to reach and
        // destroy it. `instance` stays null until the map is worth driving.
        handleRef.current = { svg, instance: null };

        await instance.setData(tree);
        // Only `disposed` decides whether this attempt is still current. Comparing
        // elements would be wrong: React hands back the *same* SVG node for a node
        // that never unmounted, so a superseded attempt could recognise the live node
        // as its own and publish over its successor.
        if (disposed) return;

        // The index is built *after* `setData` and from the library's own data
        // (`state.data`) rather than from `tree`: the library upgrades the nodes
        // in place with layout state, and `setHighlight` only accepts those
        // upgraded nodes. Indexing the pre-`setData` objects would type-check
        // under a cast and fail at runtime.
        const liveRoot = instance.state.data;
        const byId =
          liveRoot === undefined ? new Map() : indexLiveById<typeof liveRoot>(liveRoot);

        handleRef.current = {
          svg,
          instance: {
            destroy: () => instance.destroy(),
            fit: () => instance.fit(),
            highlight: (nodeId) =>
              instance.setHighlight(nodeId === null ? undefined : (byId.get(nodeId) ?? undefined)),
          },
        };

        // One fit for a newly mounted map, so the projection is visible without
        // the user hunting for it. Later content changes do not re-fit.
        //
        // Awaited directly rather than raced against a deadline. It was briefly
        // bounded while the tree in this node was being corrupted in place, which
        // left it waiting on geometry that never arrived; with a clean tree it
        // settles immediately. A deadline would be a second mechanism for a cause
        // that no longer exists, and would risk publishing a map whose viewport was
        // never established.
        await instance.fit();
        if (disposed) return;
        // Published only now, because there is nothing to show before this. A
        // *failed* attempt published nothing, so reaching here is the only path
        // that can leave a mounting state behind — which is what makes the
        // give-up notice in the effect below unreachable on the success path.
        setMount({ key: mountKey, phase: 'mounted' });
      } catch (caught) {
        if (disposed) return;
        // Drop the half-built instance right away instead of waiting for the
        // effect's cleanup. It may never have been published (`created` is only
        // read by the cleanup), so leaving it alive would leave a second live
        // Markmap — observer, zoom behaviour and `<style>` — on a page that is
        // about to render an error instead.
        if (created !== null) {
          created.destroy();
          created = null;
        }
        handleRef.current = null;
        setMount({
          key: mountKey,
          phase: 'failed',
          message: caught instanceof Error ? caught.message : '脑图渲染失败',
        });
      }
    })();

    return () => {
      disposed = true;
      const handle = handleRef.current;
      handleRef.current = null;
      // `destroy()` first: it unsubscribes the library's ResizeObserver, removes
      // the zoom behaviour and drops the `<style>` it appended, all of which
      // need the SVG still in place. Clearing it first would leave those
      // listeners bound to a detached tree.
      //
      // The instance destroyed is the one *this attempt* created, not whatever is
      // in the ref: after a failure the ref is null while `created` still holds the
      // instance that must not be left running.
      const owned = created ?? handle?.instance ?? null;
      created = null;
      owned?.destroy();
      // The tree the attempt drew into. It is emptied even when the library never
      // touched it, so a refused or degenerate tree leaves no stray SVG behind for
      // the next attempt to draw into.
      if (started) svg.replaceChildren();
    };
    // `compiled` is the content identity (it holds the markdown and the node ids
    // together), and `structureIssue` decides whether anything may be built at
    // all. `mountKey` is derived from those two, so it would be a redundant entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiled, initialExpandLevel, structureIssue]);

  /**
   * Report a mounting attempt that never resolved.
   *
   * `setData` is awaited inside the mount effect, and if it never settles nothing
   * else is left to resolve it: the component would sit on "正在渲染脑图" forever,
   * with no error, no rejection and no failed request to observe — the worst kind of
   * failure, because to the user it is indistinguishable from a slow page. This
   * turns it into a readable message the user can act on.
   *
   * Reachable only while an attempt owns the live handle: an attempt clears the
   * handle on both its failure and its cleanup paths, so a mount that already
   * finished leaves nothing here to fire against.
   */
  useEffect(() => {
    if (error !== null) return;
    if (mount?.key === mountKey && mount.phase === 'mounted') return;
    const timer = window.setTimeout(() => {
      if (handleRef.current === null) return;
      setMount({
        key: mountKey,
        phase: 'failed',
        message: '渲染在等待布局数据时超时，未能画出节点',
      });
    }, STALL_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [error, mount, mountKey]);

  /**
   * Mark the selected node, without rebuilding the map.
   *
   * This is the "edit an unrelated field" case from T057-C04: choosing a node in
   * the outline must show where it is on the canvas, and doing that by remounting
   * would throw away the user's zoom. `setHighlight` is the library's own
   * highlight (a rounded rect behind the node), so there is no second visual
   * language invented here.
   */
  useEffect(() => {
    const instance = handleRef.current?.instance ?? null;
    if (instance === null) return;
    void instance.highlight(selectedNodeId).catch(() => {
      // Highlighting is decoration; failing to draw it must not blank a working
      // map or replace it with an error the user cannot act on.
    });
    // The trigger is "a new selection" or "a newly published instance": selecting a
    // node while the map is still being built must not run against an instance with
    // no data, and an instance that only just became ready still has to be told what
    // is selected.
  }, [selectedNodeId, mounted]);

  /**
   * Report a click on a node, using the identity recorded on its datum.
   *
   * Two interactions share this SVG and they must not swallow each other:
   *
   *  - Markmap attaches its own fold handler to the `circle` it draws next to a
   *    branch, and folding is part of what T057-C01 asks for;
   *  - the node's text lives in a `foreignObject`, and clicking it should select
   *    the node and reveal its sources (T058).
   *
   * A circle click is therefore left entirely to the library. Any other hit that
   * resolves to one of our nodes is reported and its propagation stopped, so a
   * text click cannot also toggle the branch the user was reading.
   */
  const onClick = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      const target = event.nativeEvent.target;
      if (target instanceof Element && target.closest('circle') !== null) return;
      const nodeId = nodeIdFromEvent(event.nativeEvent);
      if (!nodeId) return;
      event.stopPropagation();
      onNodeSelect?.(nodeId);
    },
    [onNodeSelect],
  );

  return (
    <div className="flex flex-col gap-2" data-testid="mindmap-renderer">
      {/*
        The failure notice sits outside the canvas on purpose: the canvas below is
        hidden when a failure is reported, so a notice placed inside it would be
        hidden by the very state it was reporting.
      */}
      {error ? (
        <InlineError message={`脑图无法渲染：${error}`}>
          <p className="text-xs">
            图没有画出来不影响下面的大纲：每个节点和它的来源仍然可以查看和导出。
          </p>
        </InlineError>
      ) : null}
      {!mounted && !error ? <LoadingIndicator label="正在渲染脑图" /> : null}
      {/*
        The canvas is hidden only for a reported failure; while a mount is in flight
        it is already laid out. That is deliberate rather than incidental: the initial
        fit measures this element, and a `display:none` ancestor would give it zero
        geometry, from which d3 computes a `translate(NaN,NaN) scale(NaN)` transform
        that leaves every node in the tree and none of them visible.
      */}
      <div
        hidden={error !== null}
        className="h-[520px] w-full overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--surface)]"
        data-testid="mindmap-canvas"
      >
        {/*
          The drawing surface: created by React exactly once, handed to Markmap, and
          then mutated by it in place — the library appends its own `<style>` and root
          `<g>` here and merges the `markmap` class into the one below. React renders
          no children inside it, so the effect's cleanup can safely empty this node:
          the only thing it can remove is markup the library added.
        */}
        <svg
          ref={svgRef}
          className="h-full w-full cursor-grab"
          role="img"
          aria-label={`脑图：${content.title}`}
          data-testid="mindmap-svg"
          data-selected-node={selectedNodeId ?? ''}
          onClickCapture={onClick}
        />
      </div>
    </div>
  );
}

/**
 * Attach the AST node id to each transformed node's payload, positionally.
 *
 * The walk is pre-order depth-first because that is how `compileMindmap` emits
 * the document and therefore how Markmap builds its tree: `# title` becomes the
 * root, and the outermost list item becomes its first child. `nodeIds` is the
 * same pre-order walk over the AST, so the two sequences line up index for index
 * once the heading's own position is accounted for.
 *
 * There are exactly two shapes, and the count distinguishes them without any
 * guessing:
 *
 *  - **`nodes === nodeIds.length`** — the AST root and the document title are the
 *    same string, so `compileMindmap` folded them into one heading and Markmap's
 *    root *is* the root node. The sequences align from index 0.
 *  - **`nodes === nodeIds.length + 1`** — the labels differ, so Markmap's root is a
 *    synthetic title node standing for no AST node, and the AST root is its first
 *    child. That synthetic node is left unannotated on purpose: it is the document
 *    title, clicking it should select nothing, and giving it the root's id would
 *    put the same id on two nodes and make `byId` ambiguous.
 *
 * Anything else means the compile and the transform genuinely disagree, which
 * would mean clicking a node opens another node's sources. That is reported
 * rather than silently zipped: an off-by-one here is invisible in a screenshot
 * and wrong in every source lookup.
 */
function annotateTree(root: TransformedRoot, nodeIds: readonly string[]): TransformedRoot {
  const ordered: TransformedRoot[] = [];
  const stack: TransformedRoot[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    ordered.push(node);
    // Pushed in reverse so children pop in their rendered order, matching the
    // pre-order walk the id list was built with.
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]!);
    }
  }

  const hasSyntheticTitle = ordered.length === nodeIds.length + 1;
  if (!hasSyntheticTitle && ordered.length !== nodeIds.length) {
    throw new Error(
      `脑图结构与编译结果不一致（节点 ${ordered.length} 个，编译 ${nodeIds.length} 个），已按大纲显示`,
    );
  }

  const offset = hasSyntheticTitle ? 1 : 0;
  for (let index = 0; index < nodeIds.length; index += 1) {
    const node = ordered[index + offset]!;
    const marked = node as { payload?: Record<string, unknown> };
    marked.payload = { ...marked.payload, [NODE_ID_KEY]: nodeIds[index]! };
  }
  return root;
}
