'use client';

/**
 * Text fallback for an undrawable flow (T066-R05, T066-C05).
 *
 * When Mermaid cannot run, when the compiled source is refused, or when a stored
 * `FlowContent` fails the structural check, the *material must still be readable*.
 * A blank canvas would say "this flow has nothing in it", which is a different and
 * false claim — the nodes and the relations are still known; only the picture is
 * missing (docs/03_contracts/09 §4).
 *
 * Three things this deliberately does *not* do:
 *
 *  - **It does not compile.** The fallback is reached precisely when compilation
 *    failed, so it reads the raw stored content and prints whatever ids are there.
 *    A dangling endpoint is shown as an arrow between two names rather than being
 *    hidden, because "this row is broken" is the information the user needs.
 *  - **It does not fetch anything.** The sources are rendered by `<SourceList>`
 *    beside it, from the view's own snapshot, so the fallback works with the
 *    network and the model unavailable.
 *  - **It does not offer a paid retry.** `onRetry` re-runs the *local* renderer
 *    only; there is no path from here back to a provider request (T066-C03).
 */
import type { FlowContent, FlowEdgeKind } from '@/domain/knowledge';
import { Button, InlineError } from '@/components/ui/primitives';

import { labelForKind } from '@/domain/compileFlow';

/**
 * The word each edge kind is introduced with, in the fallback.
 *
 * Taken from the compiler's own table rather than retyped, so the text list and
 * the drawn diagram cannot describe the same edge differently — and so a
 * `hypothesis` still says 推测 when the picture is missing.
 */
function edgeText(kind: FlowEdgeKind, label: string): string {
  try {
    return labelForKind(kind, label);
  } catch {
    // An edge kind outside the five is itself a reason this view is being shown as
    // text. Printing the raw label is more useful than throwing from a fallback.
    return label;
  }
}

export interface FlowFallbackProps {
  content: FlowContent;
  /** Readable reason the picture is missing, or null when this is a plain outline. */
  error?: string | null;
  /** The app's error code for the failure, when there is one. */
  errorCode?: string | null;
  /** Re-run the local renderer. Never a model call (T066-R05). */
  onRetry?: () => void;
  /** Called with a node id when its row is clicked, so sources can be shown. */
  onNodeSelect?: (nodeId: string) => void;
  selectedNodeId?: string | null;
}

export function FlowFallback({
  content,
  error = null,
  errorCode = null,
  onRetry,
  onNodeSelect,
  selectedNodeId = null,
}: FlowFallbackProps) {
  const nodes = Array.isArray(content.nodes) ? content.nodes : [];
  const edges = Array.isArray(content.edges) ? content.edges : [];

  return (
    <section
      className="flex flex-col gap-3"
      aria-label="流程文本替代"
      data-testid="flow-fallback"
    >
      {error ? (
        <InlineError message={`流程图无法渲染：${error}`}>
          <p className="text-xs">
            下面用文字列出了这张图的节点和连接，来源仍然可以在旁边的面板里查看。图没有画出来
            不影响知识库和其它视图。
          </p>
          {errorCode ? (
            <p className="text-xs text-[var(--ink-muted)]" data-testid="flow-fallback-code">
              错误码：{errorCode}
            </p>
          ) : null}
          {onRetry ? (
            <div>
              <Button variant="secondary" data-testid="flow-retry-render" onClick={onRetry}>
                重试渲染
              </Button>
            </div>
          ) : null}
          <p className="text-xs text-[var(--ink-muted)]">
            重试只在本地重新渲染，不会重新请求模型，也不会产生费用。
          </p>
        </InlineError>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-[var(--ink)]" data-testid="flow-fallback-nodes-count">
          节点（{nodes.length}）
        </h3>
        <ul className="flex flex-col gap-1" data-testid="flow-fallback-nodes">
          {nodes.map((node) => (
            <li
              key={node.id}
              data-testid="flow-fallback-node"
              data-node-id={node.id}
              data-selected={node.id === selectedNodeId ? 'true' : 'false'}
              className="flex flex-wrap items-baseline gap-2 rounded-md border border-[var(--line)] p-2"
            >
              <button
                type="button"
                className="text-left text-sm text-[var(--ink)] underline-offset-2 hover:underline"
                data-testid="flow-fallback-node-select"
                onClick={() => onNodeSelect?.(node.id)}
              >
                {node.label.trim().length > 0 ? node.label : `（无文字：${node.id}）`}
              </button>
              <span className="text-xs text-[var(--ink-muted)]">
                来源 {Array.isArray(node.itemIds) ? node.itemIds.length : 0} 条
              </span>
            </li>
          ))}
          {nodes.length === 0 ? (
            <li className="text-sm text-[var(--ink-muted)]">这张流程图没有任何节点。</li>
          ) : null}
        </ul>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-[var(--ink)]" data-testid="flow-fallback-edges-count">
          连接（{edges.length}）
        </h3>
        <ul className="flex flex-col gap-1" data-testid="flow-fallback-edges">
          {edges.map((edge, index) => (
            <li
              // Not keyed by endpoint pair: a duplicated edge is one of the shapes
              // this list exists to surface, and a key collision would hide it.
              key={`${edge.source}->${edge.target}:${index}`}
              data-testid="flow-fallback-edge"
              data-kind={edge.kind}
              className="rounded-md border border-[var(--line)] p-2 text-sm"
            >
              <span className="text-[var(--ink)]">
                {edge.source} → {edge.target}
              </span>
              <span className="text-[var(--ink-muted)]">
                ：{edgeText(edge.kind, edge.label)}
              </span>
            </li>
          ))}
          {edges.length === 0 ? (
            <li className="text-sm text-[var(--ink-muted)]" data-testid="flow-fallback-no-edges">
              这张图没有画任何连接：材料里没有可支持的先后或依赖，这是正常结果。
            </li>
          ) : null}
        </ul>
      </div>
    </section>
  );
}
