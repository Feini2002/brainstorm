'use client';

/**
 * Mermaid renderer for one flow view (T064–T066).
 *
 * Assembles the second half of G5: compile the canonical content, render it with
 * a locked-down Mermaid, sanitize the SVG, and hand out a picture plus a text
 * equivalent. Four separations are the reason this is one component and not five:
 *
 *  1. **Compile on the client, from the AST (T064-R02, T067-R02).** The Mermaid
 *     source is derived in a `useMemo` from the stored content, never read from a
 *     column and never accepted from a caller. A hand-edited or cached source
 *     therefore cannot become a second truth, and the export can hand out the same
 *     bytes the screen is showing.
 *  2. **The picture is never the only representation.** The compiled source, the
 *     text outline and the source panel are all rendered regardless of whether
 *     Mermaid succeeded, so a browser-side rendering failure costs the user the
 *     drawing and nothing else (T066-R05/R06).
 *  3. **A refused compile is a *stated* failure, not an empty canvas.** A stored
 *     content that fails `inspectFlow` — a dangling endpoint, a duplicated id —
 *     goes straight to the text fallback with the compiler's own message, which
 *     names the offending row (T063-C03).
 *  4. **No handlers come from the model (T065-R04).** The diagram is rendered with
 *     `htmlLabels: false` and no `bindFunctions`, and the sanitizer strips every
 *     event attribute; "show me this node's sources" is a React button in the
 *     panel beside the picture, keyed by the AST node id, which is the only place
 *     a click can come from.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { compileFlow, type CompiledFlow } from '@/domain/compileFlow';
import type { FlowContent } from '@/domain/knowledge';
import { inspectFlow } from '@/domain/validateFlow';
import { InlineError, LoadingIndicator } from '@/components/ui/primitives';

import { FlowFallback } from './FlowFallback';
import { useMermaidRender } from './useMermaidRender';

export interface MermaidRendererProps {
  content: FlowContent;
  /** Called with the AST node id when a node row or a node in the picture is chosen. */
  onNodeSelect?: (nodeId: string) => void;
  /** The node to mark as current. */
  selectedNodeId?: string | null;
  /**
   * Publish the sanitized SVG upward, or `null` when there is none.
   *
   * The export button lives in a sibling section, and the only SVG this
   * application may hand to the user is the one that came through
   * `sanitizeSvgString`. Publishing it is what makes that the *same* string the
   * canvas is showing, rather than a second render that happens to be safe
   * (T068-R04, T065-R06).
   */
  onSanitizedSvg?: (svg: string | null) => void;
}

/** The compiled result, or the reason there is none. */
type Compiled =
  | { ok: true; compiled: CompiledFlow }
  | { ok: false; message: string; code: string };

export function MermaidRenderer({
  content,
  onNodeSelect,
  selectedNodeId = null,
  onSanitizedSvg,
}: MermaidRendererProps) {
  /**
   * Compile once per content identity.
   *
   * `compileFlow` is pure and total for drawable content, and returns its own
   * issues for content that is not — so the structural check and the compiler are
   * one call here, and a throw can only mean something genuinely unforeseen.
   * Catching it keeps that from becoming a render-phase exception that blanks the
   * page: the fallback below still lists the nodes.
   */
  const compiled = useMemo<Compiled>(() => {
    try {
      const result = compileFlow(content);
      if (result.ok) return { ok: true, compiled: result.compiled };
      return {
        ok: false,
        message: result.issues.map((issue) => issue.message).join('；'),
        code: 'STRUCTURED_INVALID',
      };
    } catch (caught) {
      return {
        ok: false,
        message: caught instanceof Error ? caught.message : '流程图内容无法编译',
        code: 'INTERNAL',
      };
    }
  }, [content]);

  /**
   * The structural check, run only when the compiler refused.
   *
   * It is not run on the success path because the compiler has already run it —
   * calling it again would be a second authority with the same answer, and the
   * point of `inspectFlow` living in one module is that there is exactly one.
   */
  const refusal = useMemo(
    () => (compiled.ok ? null : inspectFlow(content)),
    [compiled.ok, content],
  );

  const source = compiled.ok ? compiled.compiled.source : null;
  const render = useMermaidRender({ source });

  const [showSourceText, setShowSourceText] = useState(false);

  /**
   * Publish the sanitized picture, and withdraw it when there is none.
   *
   * The effect is keyed on the string itself so the callback runs once per
   * produced artifact rather than on every render — a parent that stored the
   * value would otherwise be re-rendered continuously. `null` is published
   * deliberately: a failed render must *retract* the previous picture instead of
   * leaving the old one downloadable while the canvas shows an error.
   */
  useEffect(() => {
    onSanitizedSvg?.(render.phase === 'ready' ? render.svg : null);
  }, [onSanitizedSvg, render.phase, render.svg]);

  const selectNode = useCallback(
    (nodeId: string) => {
      onNodeSelect?.(nodeId);
    },
    [onNodeSelect],
  );

  /**
   * A *stable* ref callback for the measured canvas.
   *
   * An inline arrow (`ref={(element) => render.observeSize(element)}`) is a new
   * function identity on every render, so React detaches and re-attaches it each
   * time — and `ResizeObserver.observe()` delivers a callback immediately, so
   * every render would re-subscribe and immediately publish a measurement again.
   * `observeSize` is itself `useCallback`-stable, so depending on the function
   * (destructured, not `render`, which is a fresh object each render) keeps this
   * identity fixed and the subscription is made once per mounted element
   * (T066-R04).
   */
  const { observeSize } = render;
  const canvasRef = useCallback(
    (element: HTMLElement | null) => {
      observeSize(element);
    },
    [observeSize],
  );

  const error = compiled.ok ? render.error : compiled.message;
  const errorCode = compiled.ok ? (render.error === null ? null : 'RENDER_FAILED') : compiled.code;

  /**
   * The node whose id, in the *compiled* map, was clicked.
   *
   * The picture carries the compiler's own `N0…Nn` ids, and the mapping table is
   * the only place the model's ids appear. Reading the mapping back is what keeps
   * a click from having to trust an attribute value inside the SVG — the id in the
   * DOM is a compiler-generated token, not a model string (T064-R01, T065-C05).
   */
  const nodeIdFromMermaidId = useCallback(
    (mermaidId: string): string | null => {
      if (!compiled.ok) return null;
      for (const [modelId, safeId] of Object.entries(compiled.compiled.nodeIdMap)) {
        if (safeId === mermaidId) return modelId;
      }
      return null;
    },
    [compiled],
  );

  return (
    <section className="flex flex-col gap-3" data-testid="flow-renderer">
      {compiled.ok && render.phase === 'pending' ? (
        <LoadingIndicator label="正在渲染流程图" />
      ) : null}

      {error !== null ? (
        <InlineError message={`流程图无法渲染：${error}`}>
          {refusal !== null && refusal.length > 0 ? (
            <ul className="flex flex-col gap-1 text-xs" data-testid="flow-structure-issues">
              {refusal.slice(0, 5).map((issue) => (
                <li key={`${issue.ids.join(',')}:${issue.message}`}>{issue.message}</li>
              ))}
            </ul>
          ) : null}
        </InlineError>
      ) : null}

      {/*
        The canvas is kept in the DOM but hidden while a render is pending or has
        failed, rather than being unmounted: the container's measured box is what
        the acceptance test observes for T066-C04, and unmounting it would make a
        "no new render happened" assertion unobservable.
      */}
      <div
        hidden={!compiled.ok || render.phase !== 'ready'}
        className="overflow-x-auto rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3"
        data-testid="flow-canvas"
        data-phase={render.phase}
        data-attempts={render.attempts}
        data-size={`${render.size.width}x${render.size.height}`}
        ref={canvasRef}
        onClick={(event) => {
          // No handler comes from the diagram (T065-R04). The only click this
          // reads is on a node group, and the id it reads was generated by the
          // compiler, then translated back through the mapping table.
          const target = event.target;
          if (!(target instanceof Element)) return;
          const group = target.closest('[id]');
          const mermaidId = group?.getAttribute('id') ?? null;
          if (mermaidId === null) return;
          const modelId = nodeIdFromMermaidId(mermaidId);
          if (modelId !== null) selectNode(modelId);
        }}
      >
        {/*
          `dangerouslySetInnerHTML` is the only way to place an SVG string, and it
          is why `sanitizeSvgString` exists and why the sanitized string is verified
          before it gets here. The value written is never the raw Mermaid output.
        */}
        {render.svg !== null ? (
          <div
            className="flow-svg-host flex justify-center [&_svg]:h-auto [&_svg]:max-w-full"
            data-testid="flow-svg"
            dangerouslySetInnerHTML={{ __html: render.svg }}
          />
        ) : null}
      </div>

      {compiled.ok && showSourceText ? (
        <pre
          className="overflow-x-auto rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3 text-xs text-[var(--ink)]"
          data-testid="flow-source"
        >
          {compiled.compiled.source}
        </pre>
      ) : null}

      {compiled.ok ? (
        <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--ink-muted)]">
          <span data-testid="flow-compiler-version">
            编译版本 {compiled.compiled.compilerVersion}
          </span>
          <span data-testid="flow-legend">
            图例：
            {compiled.compiled.legend.length === 0
              ? '本例没有连接'
              : compiled.compiled.legend
                  .map((entry) => `${entry.prefix}${entry.line === 'dashed' ? '（虚线）' : ''}`)
                  .join('、')}
          </span>
          {compiled.compiled.droppedDuplicateEdges > 0 ? (
            <span data-testid="flow-dropped-edges">
              已合并 {compiled.compiled.droppedDuplicateEdges} 条完全重复的连接
            </span>
          ) : null}
          <button
            type="button"
            className="underline"
            data-testid="flow-toggle-source"
            onClick={() => setShowSourceText((value) => !value)}
          >
            {showSourceText ? '隐藏 Mermaid 源码' : '查看 Mermaid 源码'}
          </button>
        </div>
      ) : null}

      {/*
        The text list is always rendered, not only on failure. It is the
        accessible, copyable and printable form of the same content, and it is what
        the user falls back to when the drawing is unavailable — so making it
        conditional would leave exactly the case it exists for with nothing to show
        (T066-C05).
      */}
      <FlowFallback
        content={content}
        error={error}
        errorCode={errorCode}
        {...(render.phase === 'failed' ? { onRetry: render.retry } : {})}
        {...(onNodeSelect ? { onNodeSelect: selectNode } : {})}
        selectedNodeId={selectedNodeId}
      />
    </section>
  );
}
