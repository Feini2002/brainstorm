'use client';

/**
 * Flow source and evidence panel (T067-R05, T067-C02/C03).
 *
 * The panel exists because a flow diagram has two different kinds of claim in it
 * and the picture alone cannot separate them:
 *
 *  - a **fact edge** — sequence, dependency, association, or a causal edge that
 *    passed the server's evidence gate — is backed by notes and, for dependency
 *    and causal, by relations the user accepted;
 *  - a **hypothesis edge** is the model's own guess, drawn dashed and prefixed
 *    「推测：」, and it must not acquire the authority of the edges around it
 *    merely by being listed in the same panel.
 *
 * So the guesses are moved *out* of the node's source list into their own section
 * with their own wording, and the node's real sources come from `<SourceList>`,
 * which resolves every id against the live library and states which version the
 * view recorded. Nothing here creates a knowledge record: a node's `itemIds` are
 * references, and this component only displays and opens them (T067-R01,
 * T067-R05).
 *
 * Relations are shown by id with their recorded revision, because the relation is
 * a *knowledge-level* fact with its own review state — if the user rejects the
 * relation later, the freshness banner reports the drift and this list still names
 * what the edge was built on (T067-C02).
 */
import { useMemo } from 'react';

import type { FlowContent, SourceSnapshot } from '@/domain/knowledge';
import { flowHypothesisEdges, flowReferencedRelationIds } from '@/domain/validateFlow';
import { Field, Select } from '@/components/ui/primitives';
import { SourceList } from '@/features/shared/SourceList';

import { FLOW_EDGE_STYLES } from '@/domain/compileFlow';

export interface FlowSourcePanelProps {
  content: FlowContent;
  snapshot: SourceSnapshot;
  /** The node whose sources are shown, or null for the whole graph's sources. */
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  onOpenItem: (itemId: string) => void;
}

export function FlowSourcePanel({
  content,
  snapshot,
  selectedNodeId,
  onSelectNode,
  onOpenItem,
}: FlowSourcePanelProps) {
  /**
   * The node in question, or the first one.
   *
   * Falling back to the first node keeps the panel informative on open instead of
   * empty, which would read as "this flow has no sources" (the same reasoning the
   * mindmap page uses for adopting its root).
   */
  const node = useMemo(() => {
    if (selectedNodeId !== null) {
      const found = content.nodes.find((entry) => entry.id === selectedNodeId);
      if (found) return found;
    }
    return content.nodes[0] ?? null;
  }, [content.nodes, selectedNodeId]);

  /**
   * The hypothesis edges, computed by the domain rather than here.
   *
   * "Which connections are guesses" has exactly one answer, and the compiler styles
   * the same set; deriving it a second time in a component is how the dashed line
   * and the panel text eventually disagree (T067-R05).
   */
  const hypotheses = useMemo(() => flowHypothesisEdges(content), [content]);
  const hypothesisByNode = useMemo(() => {
    const map = new Map<string, { source: string; target: string; label: string }[]>();
    for (const edge of hypotheses) {
      for (const key of [edge.source, edge.target]) {
        const list = map.get(key) ?? [];
        list.push(edge);
        map.set(key, list);
      }
    }
    return map;
  }, [hypotheses]);

  /** Relations this flow cites, with the revision the snapshot recorded. */
  const citedRelations = useMemo(() => {
    const ids = flowReferencedRelationIds(content);
    const revisions = new Map(snapshot.relations.map((entry) => [entry.id, entry.revision]));
    return ids.map((id) => ({ id, revision: revisions.get(id) ?? null }));
  }, [content, snapshot.relations]);

  const nodeHypotheses = node === null ? [] : (hypothesisByNode.get(node.id) ?? []);

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3"
      aria-label="流程图来源与依据"
      data-testid="flow-source-panel"
    >
      <header className="flex flex-wrap items-end gap-3">
        <Field label="查看哪个节点的来源" htmlFor="flow-source-node">
          <Select
            id="flow-source-node"
            data-testid="flow-source-node"
            value={node?.id ?? ''}
            onChange={(event) => onSelectNode(event.target.value || null)}
          >
            {content.nodes.length === 0 ? <option value="">没有节点</option> : null}
            {content.nodes.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label.trim().length > 0 ? entry.label : entry.id}
              </option>
            ))}
          </Select>
        </Field>
        <p className="text-xs text-[var(--ink-muted)]" data-testid="flow-evidence-summary">
          这张图有 {content.nodes.length} 个节点、{content.edges.length} 条连接，其中{' '}
          {hypotheses.length} 条是标注的推测。
        </p>
      </header>

      {node ? (
        <SourceList
          itemIds={node.itemIds}
          snapshot={snapshot}
          nodeLabel={node.label.trim().length > 0 ? node.label : node.id}
          onOpenItem={onOpenItem}
        />
      ) : (
        <p className="text-sm text-[var(--ink-muted)]">这张流程图没有节点，因此没有来源可以列出。</p>
      )}

      {/*
        The hypothesis section is deliberately *separate* and comes after the real
        sources: the point is that a guess is not one of the facts above it.
        Rendering it as another source row would put a 「推测」 and a verbatim quote
        in the same list, and the list is what a reader skims.
      */}
      <div className="flex flex-col gap-1" data-testid="flow-hypothesis-section">
        <h3 className="text-sm font-semibold text-[var(--ink)]">
          推测连接（{hypotheses.length}）
        </h3>
        {nodeHypotheses.length === 0 ? (
          <p className="text-xs text-[var(--ink-muted)]" data-testid="flow-hypothesis-none">
            {hypotheses.length === 0
              ? '这张图没有推测连接：每一条边都有材料依据。'
              : '当前节点没有涉及推测连接。'}
          </p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="flow-hypothesis-list">
            {nodeHypotheses.map((edge) => (
              <li
                key={`${edge.source}->${edge.target}`}
                data-testid="flow-hypothesis-row"
                data-kind="hypothesis"
                className="rounded-md border border-dashed border-[var(--line)] p-2 text-xs"
              >
                <span className="text-[var(--ink)]">
                  {FLOW_EDGE_STYLES.hypothesis.prefix}
                  {edge.label}
                </span>
                <span className="text-[var(--ink-muted)]">
                  （{edge.source} → {edge.target}）
                </span>
              </li>
            ))}
          </ul>
        )}
        {hypotheses.length > 0 ? (
          <p className="text-xs text-[var(--ink-muted)]" data-testid="flow-hypothesis-notice">
            推测连接是模型为了帮助思考补上的排列，材料里没有已确认的依据。它不影响知识库里的关系，
            导出时也会保留「推测」标记。
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1" data-testid="flow-relation-section">
        <h3 className="text-sm font-semibold text-[var(--ink)]">
          引用的关系（{citedRelations.length}）
        </h3>
        {citedRelations.length === 0 ? (
          <p className="text-xs text-[var(--ink-muted)]" data-testid="flow-relation-none">
            这张图没有引用任何已记录的关系：它的连接来自材料本身的顺序或明确标注的推测。
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs" data-testid="flow-relation-list">
            {citedRelations.map((relation) => (
              <li
                key={relation.id}
                data-testid="flow-relation-row"
                data-relation-id={relation.id}
                className="flex flex-wrap items-baseline gap-2 rounded-md border border-[var(--line)] p-2"
              >
                <span className="break-all text-[var(--ink)]">{relation.id}</span>
                <span className="text-[var(--ink-muted)]">
                  {relation.revision === null
                    ? '不在本图快照中'
                    : `生成时 revision ${relation.revision}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-[var(--ink-muted)]">
          关系的审核状态与版本由知识库维护；如果它被拒绝或改动，上面的过期提示会说明这张图依据的是旧版本。
        </p>
      </div>
    </section>
  );
}
