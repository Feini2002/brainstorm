/**
 * Structural inspection of *stored* flow content (T064-R06).
 *
 * The split from `src/domain/flow.ts` is deliberate, and it is the same split
 * `inspectMindmapTree` makes from `validateMindmap`:
 *
 *  - `flow.ts::validateFlow` decides whether a **model answer** may become a View.
 *    It knows about the selection, the allowed relation ids and the causal
 *    evidence gate.
 *  - this module decides whether an **already stored View** can be drawn at all.
 *    It re-litigates nothing about provenance: a flow the server accepted once is
 *    drawn the same way forever, even if a later build tightens the limits.
 *
 * The failure modes are the ones that reach a renderer as a hang or a wrong
 * picture rather than as an error: a duplicated node id (two `n1`s in the mapping
 * table), an edge whose endpoint is not a node (Mermaid refuses the whole graph,
 * or silently invents the missing node — either way the picture stops matching
 * the material), a self edge, or an oversized graph. Each gets its own check with
 * the offending ids in the message, so the UI can say *which* row is broken
 * instead of "渲染失败".
 *
 * Pure: no database, no clock, no DOM, no randomness (T064-R06). That is what
 * makes it usable both from the compiler below and from the browser-side
 * renderer.
 */
import type { FlowContent, FlowEdgeKind, UUID } from './knowledge';
import { LIMITS } from './limits';
import { codePointLength } from './text';

/** The five semantic edge kinds, in the contract's order. */
export const FLOW_EDGE_KINDS: readonly FlowEdgeKind[] = [
  'sequence',
  'dependency',
  'association',
  'causal',
  'hypothesis',
];

export interface FlowStructureIssue {
  /** Node or edge ids the message is about; empty when it concerns the whole graph. */
  ids: string[];
  message: string;
}

function isKind(value: unknown): value is FlowEdgeKind {
  return typeof value === 'string' && (FLOW_EDGE_KINDS as readonly string[]).includes(value);
}

/**
 * Check that a stored `FlowContent` is drawable.
 *
 * Returns every issue found rather than the first: a view assembled by an older
 * build can be wrong in several independent ways at once, and reporting them one
 * round trip at a time would turn a diagnosis into a guessing game.
 */
export function inspectFlow(content: FlowContent): FlowStructureIssue[] {
  const issues: FlowStructureIssue[] = [];
  const nodes = Array.isArray(content.nodes) ? content.nodes : [];

  if (nodes.length === 0) {
    return [{ ids: [], message: '这张流程图没有任何节点' }];
  }
  if (nodes.length > LIMITS.flowNodes) {
    issues.push({
      ids: [],
      message: `节点数为 ${nodes.length}，超过上限 ${LIMITS.flowNodes}`,
    });
  }

  // ---- Unique ids ----
  //
  // Checked first and reasoned about below: a duplicated id makes "does this
  // endpoint exist" ambiguous, so continuing would report problems that are only
  // artefacts of the duplicate.
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const node of nodes) {
    if (typeof node.id !== 'string' || node.id.length === 0) continue;
    if (seen.has(node.id)) duplicates.push(node.id);
    seen.add(node.id);
  }
  if (duplicates.length > 0) {
    return [
      {
        ids: [...new Set(duplicates)],
        message: `节点 id 重复：${[...new Set(duplicates)].join('、')}。无法确定边指向哪一个，已停止绘制`,
      },
    ];
  }

  // ---- Every node is drawable on its own ----
  for (const node of nodes) {
    const label = typeof node.label === 'string' ? node.label.trim() : '';
    if (label.length === 0) {
      issues.push({ ids: [node.id], message: `节点「${node.id}」没有文字` });
      continue;
    }
    if (codePointLength(label) > LIMITS.flowLabelCodePoints) {
      issues.push({
        ids: [node.id],
        message: `节点「${node.id}」的文字超过 ${LIMITS.flowLabelCodePoints} 个字符`,
      });
    }
  }

  const edges = Array.isArray(content.edges) ? content.edges : [];
  if (edges.length > LIMITS.flowEdges) {
    issues.push({
      ids: [],
      message: `边数为 ${edges.length}，超过上限 ${LIMITS.flowEdges}`,
    });
  }

  // ---- Every edge endpoint must resolve (T063-C03) ----
  //
  // A dangling endpoint is *rejected*, never repaired by inventing the missing
  // node: the renderer cannot invent what the material does not contain, and a
  // silently re-created node would put a label on screen that no source backs.
  const dangling: string[] = [];
  const selfEdges: string[] = [];
  for (const edge of edges) {
    const key = `${String(edge.source)}→${String(edge.target)}`;
    if (!seen.has(String(edge.source)) || !seen.has(String(edge.target))) {
      dangling.push(key);
      continue;
    }
    if (edge.source === edge.target) selfEdges.push(key);
  }
  if (dangling.length > 0) {
    issues.push({
      ids: dangling,
      message: `这些边的端点不是本图的节点，Mermaid 无法补出缺失节点：${dangling.slice(0, 5).join('、')}`,
    });
  }
  if (selfEdges.length > 0) {
    issues.push({
      ids: selfEdges,
      message: `这些边指向自己，无法绘制：${selfEdges.slice(0, 5).join('、')}`,
    });
  }

  // ---- Every edge carries a kind and a readable label ----
  for (const edge of edges) {
    const key = `${String(edge.source)}→${String(edge.target)}`;
    if (!isKind(edge.kind)) {
      issues.push({ ids: [key], message: `边「${key}」的类型不合法：${String(edge.kind)}` });
      continue;
    }
    const label = typeof edge.label === 'string' ? edge.label.trim() : '';
    if (label.length === 0) {
      // An unlabelled arrow is exactly the "arrow implies causation" failure the
      // contract forbids (§3). The line must say what relation it draws.
      issues.push({ ids: [key], message: `边「${key}」没有说明这是什么关系` });
      continue;
    }
    if (codePointLength(label) > LIMITS.flowLabelCodePoints) {
      issues.push({
        ids: [key],
        message: `边「${key}」的说明超过 ${LIMITS.flowLabelCodePoints} 个字符`,
      });
    }
  }

  return issues;
}

/** Every item id any node or edge cites, deduplicated, in first-seen order. */
export function flowReferencedItemIds(content: FlowContent): UUID[] {
  const collected: UUID[] = [];
  const push = (ids: readonly UUID[] | undefined): void => {
    if (!Array.isArray(ids)) return;
    for (const id of ids) if (!collected.includes(id)) collected.push(id);
  };
  for (const node of content.nodes) push(node.itemIds);
  for (const edge of content.edges) push(edge.itemIds);
  return collected;
}

/** Every relation id any edge cites, deduplicated, in first-seen order. */
export function flowReferencedRelationIds(content: FlowContent): UUID[] {
  const collected: UUID[] = [];
  for (const edge of content.edges) {
    if (!Array.isArray(edge.relationIds)) continue;
    for (const id of edge.relationIds) if (!collected.includes(id)) collected.push(id);
  }
  return collected;
}

/**
 * The edges the source panel must present as hypotheses rather than as facts
 * (T067-R05, T067-C03).
 *
 * Exported rather than computed in the component because "which connections are
 * guesses" is a domain question with one answer, and a second implementation in
 * the UI would eventually disagree with the compiler's styling.
 */
export function flowHypothesisEdges(content: FlowContent): { source: string; target: string; label: string }[] {
  return content.edges
    .filter((edge) => edge.kind === 'hypothesis')
    .map((edge) => ({ source: edge.source, target: edge.target, label: edge.label }));
}
