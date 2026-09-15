'use client';

/**
 * Mindmap outline (T058).
 *
 * A keyboard-reachable, always-readable view of the same tree the canvas draws.
 *
 * Three decisions worth stating:
 *
 *  1. **Same tree, not a second structure (T058-R05).** The rows are derived from
 *     the stored `MindmapContent` with the same child index the compiler uses
 *     (`mindmapChildrenIndex`). No request is made and no model is called: folding
 *     is view state on this component and nothing else.
 *
 *  2. **It renders even when the canvas cannot (T057-R06, T058-C04).** If the
 *     stored tree is malformed — a cycle, two roots, an orphan branch — the flat
 *     fallback below still lists every node with its label, kind and source count,
 *     so the material stays explainable. The canvas refuses to draw that shape;
 *     the outline refuses to hide it. Losing the sources because a picture failed
 *     is the outcome both task files single out.
 *
 *  3. **Disclosure is a real button.** Expand/collapse is `<button aria-expanded>`
 *     rather than a click handler on a list row, so a screen reader announces the
 *     state and the keyboard can reach it. Selecting a node is a separate button,
 *     because a single control that both expands and selects makes "open the
 *     sources of this group" and "show its children" the same gesture.
 *
 * Source *counts* are shown here; opening a source is `SourceList`'s job (T058),
 * because that component owns the version comparison and the missing-source
 * notice, and duplicating those rules here would give the same record two
 * different explanations.
 */
import { useCallback, useMemo, useState } from 'react';

import {
  inspectMindmapTree,
  mindmapChildrenIndex,
  mindmapRoot,
} from '@/domain/compileMindmap';
import type { MindmapContent, MindmapNode } from '@/domain/knowledge';

export interface MindmapOutlineProps {
  content: MindmapContent;
  /** The node whose sources are open; `null` means nothing is selected. */
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string) => void;
}

export interface OutlineRow {
  id: string;
  label: string;
  kind: MindmapNode['kind'];
  depth: number;
  /** Deduplicated source ids this node may show (already merged for groups). */
  sourceIds: string[];
  hasChildren: boolean;
  /** True when this row's own children are hidden. */
  collapsed: boolean;
}

/**
 * Flatten the tree into ordered rows, honouring the collapse set.
 *
 * The walk is iterative: the depth limit is enforced by validation, but this also
 * runs on stored content that may predate it, and a recursive outline is the
 * easiest place for a deep chain to blow the stack.
 */
export function buildOutlineRows(
  content: MindmapContent,
  collapsed: ReadonlySet<string>,
): OutlineRow[] {
  /**
   * A tree that cannot be walked is listed flat, in full.
   *
   * This branch used to keep the normal walk and merely append the nodes it failed
   * to reach — but that quietly *lost* nodes the walk had already swallowed. A
   * duplicated id is the clearest case: the walk visits the first row with that id
   * and skips the second one forever, so a three-node view rendered as two rows.
   * The outline's stated contract is that it refuses to hide content the canvas
   * refused to draw, so a structural problem switches the whole listing to the flat
   * form rather than mixing a hierarchy with a remainder.
   */
  if (inspectMindmapTree(content).length > 0) return flatRows(content, collapsed);

  const root = mindmapRoot(content);
  if (!root) return flatRows(content, collapsed);

  const childrenOf = mindmapChildrenIndex(content.nodes);
  const byId = new Map(content.nodes.map((node) => [node.id, node]));
  const rows: OutlineRow[] = [];
  const visited = new Set<string>();
  const stack: { id: string; depth: number }[] = [{ id: root.id, depth: 1 }];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    const node = byId.get(current.id);
    if (!node) continue;

    const childIds = childrenOf.get(current.id) ?? [];
    const isCollapsed = collapsed.has(current.id);
    rows.push({
      id: node.id,
      label: node.label,
      kind: node.kind,
      depth: current.depth,
      sourceIds: [...new Set(node.itemIds)],
      hasChildren: childIds.length > 0,
      collapsed: isCollapsed && childIds.length > 0,
    });
    if (isCollapsed) continue;
    // Pushed in reverse so the first child is popped first and siblings keep the
    // stored order — the same order the compiled Markdown used.
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      stack.push({ id: childIds[index]!, depth: current.depth + 1 });
    }
  }

  return rows;
}

/**
 * Depth-indented rows for a tree that cannot be walked from a single root.
 *
 * Depth comes from following `parentId` with a visited guard, so a cycle yields a
 * finite depth instead of looping. Nothing is filtered out: this is the readable
 * form of exactly the content that was stored.
 */
function flatRows(content: MindmapContent, collapsed: ReadonlySet<string>): OutlineRow[] {
  const byId = new Map(content.nodes.map((node) => [node.id, node]));
  const childrenOf = mindmapChildrenIndex(content.nodes);

  const depthOf = (node: MindmapNode): number => {
    let depth = 1;
    const seen = new Set<string>([node.id]);
    let parentId = node.parentId;
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      depth += 1;
      parentId = byId.get(parentId)?.parentId ?? null;
      if (depth > content.nodes.length) break;
    }
    return depth;
  };

  return content.nodes.map((node) => {
    const childIds = childrenOf.get(node.id) ?? [];
    return {
      id: node.id,
      label: node.label,
      kind: node.kind,
      depth: depthOf(node),
      sourceIds: [...new Set(node.itemIds)],
      hasChildren: childIds.length > 0,
      collapsed: collapsed.has(node.id) && childIds.length > 0,
    };
  });
}

export function MindmapOutline({
  content,
  selectedNodeId = null,
  onSelectNode,
}: MindmapOutlineProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = useCallback((nodeId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const rows = useMemo(() => buildOutlineRows(content, collapsed), [content, collapsed]);

  /**
   * Whether this content is a tree at all.
   *
   * Reported in the header rather than inferred from the row shapes: a reader
   * needs to know that what follows is a flat listing of a broken structure, not
   * a hierarchy they are failing to see.
   */
  const malformed = useMemo(() => inspectMindmapTree(content).length > 0, [content]);

  /** Distinct sources across the whole map — the number a reader can verify. */
  const totalSources = useMemo(() => {
    const ids = new Set<string>();
    for (const node of content.nodes) for (const id of node.itemIds) ids.add(id);
    return ids.size;
  }, [content]);

  return (
    <section
      className="flex min-w-0 flex-1 flex-col gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3"
      aria-label="脑图大纲"
      data-testid="mindmap-outline"
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-[var(--ink)]">大纲</h2>
        <p className="text-xs text-[var(--ink-muted)]" data-testid="mindmap-outline-summary">
          共 {content.nodes.length} 个节点，引用 {totalSources} 条来源。
          折叠只是显示状态，不影响保存的脑图。
        </p>
        {malformed ? (
          <p role="status" className="text-xs text-[var(--warn-ink)]" data-testid="mindmap-outline-malformed">
            这张脑图的层级结构不完整，下面按扁平列表显示；节点和来源仍然完整可读。
          </p>
        ) : null}
      </header>

      <ul className="flex flex-col gap-1 overflow-y-auto" style={{ maxHeight: '520px' }}>
        {rows.map((row) => (
          <li
            key={row.id}
            data-testid="mindmap-outline-node"
            data-node-id={row.id}
            data-depth={row.depth}
            data-kind={row.kind}
            style={{ paddingInlineStart: `${(row.depth - 1) * 16}px` }}
            className={`flex items-center gap-1 rounded-md ${
              row.id === selectedNodeId ? 'bg-[var(--surface-raised)]' : ''
            }`}
          >
            {row.hasChildren ? (
              <button
                type="button"
                aria-expanded={!row.collapsed}
                aria-label={`${row.collapsed ? '展开' : '折叠'}「${row.label}」`}
                data-testid="mindmap-outline-toggle"
                className="w-5 shrink-0 rounded text-xs text-[var(--ink-muted)] hover:text-[var(--ink)]"
                onClick={() => toggle(row.id)}
              >
                {row.collapsed ? '▸' : '▾'}
              </button>
            ) : (
              <span aria-hidden="true" className="w-5 shrink-0" />
            )}

            <button
              type="button"
              aria-current={row.id === selectedNodeId ? 'true' : undefined}
              data-testid="mindmap-outline-select"
              className="min-w-0 flex-1 rounded px-1 py-1 text-left text-sm text-[var(--ink)] hover:bg-[var(--surface-raised)]"
              onClick={() => onSelectNode?.(row.id)}
            >
              <span className="break-words">{row.label}</span>
              <span className="ml-2 text-xs text-[var(--ink-muted)]">
                {row.kind === 'group' ? '分组' : '要点'} · {row.sourceIds.length} 条来源
              </span>
            </button>
          </li>
        ))}
      </ul>

      {rows.length === 0 ? (
        <p className="text-sm text-[var(--ink-muted)]">这张脑图没有任何节点。</p>
      ) : null}
    </section>
  );
}
