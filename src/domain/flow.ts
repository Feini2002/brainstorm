/**
 * Flow AST validation.
 *
 * The model returns restricted node/edge JSON; the program alone builds Mermaid
 * syntax from it (docs/03_contracts/09_view_schemas_and_compilers.md §3).
 *
 * Causal edges need machine-checked evidence: an accepted, non-stale
 * `causes` relation whose endpoints fall inside the two nodes' sources. Without
 * that, the edge must be labelled as a hypothesis — the program never upgrades
 * a guess into a knowledge-library `causes`.
 */
import { LIMITS } from './limits';
import type { FlowContent, FlowEdge, FlowEdgeKind, FlowNode, RelationDTO } from './knowledge';
import type { RawMindmap } from './mindmap';
import { sanitizeLabel } from './mindmap';
import { codePointLength } from './text';

export const FLOW_NODE_ID_MAX = 64;

export interface FlowValidationIssue {
  path: string;
  message: string;
}

export interface RawFlowNode {
  id?: unknown;
  label?: unknown;
  itemIds?: unknown;
}

export interface RawFlowEdge {
  source?: unknown;
  target?: unknown;
  kind?: unknown;
  label?: unknown;
  itemIds?: unknown;
  relationIds?: unknown;
}

export interface RawFlow {
  title?: unknown;
  direction?: unknown;
  nodes?: unknown;
  edges?: unknown;
}

export interface FlowValidationInput {
  raw: RawFlow;
  allowedItemIds: ReadonlySet<string>;
  /** Relations referenced by allow-listed content, keyed by id. */
  relationsById: ReadonlyMap<string, RelationDTO>;
}

export interface FlowValidationResult {
  ok: boolean;
  content: FlowContent | null;
  issues: FlowValidationIssue[];
  /** True when the compiler downgraded at least one causal edge to hypothesis. */
  downgradedCausal: number;
}

const FLOW_EDGE_KINDS: readonly FlowEdgeKind[] = [
  'sequence',
  'dependency',
  'association',
  'causal',
  'hypothesis',
];

export function validateFlow(input: FlowValidationInput): FlowValidationResult {
  const { raw, allowedItemIds, relationsById } = input;
  const issues: FlowValidationIssue[] = [];

  const title = typeof raw.title === 'string' ? sanitizeLabel(raw.title) : '';
  if (title.length === 0) issues.push({ path: 'title', message: '缺少标题' });
  else if (codePointLength(title) > LIMITS.titleCodePoints) {
    issues.push({ path: 'title', message: `标题不能超过 ${LIMITS.titleCodePoints} 个字符` });
  }

  const direction = raw.direction;
  if (direction !== 'LR' && direction !== 'TB') {
    issues.push({ path: 'direction', message: 'direction 只能是 LR 或 TB' });
  }

  if (!Array.isArray(raw.nodes)) {
    issues.push({ path: 'nodes', message: '缺少节点数组' });
    return { ok: false, content: null, issues, downgradedCausal: 0 };
  }
  if (raw.nodes.length === 0) issues.push({ path: 'nodes', message: '节点不能为空' });
  if (raw.nodes.length > LIMITS.flowNodes) {
    issues.push({ path: 'nodes', message: `节点不能超过 ${LIMITS.flowNodes} 个` });
  }

  const nodes: FlowNode[] = [];
  const nodeById = new Map<string, FlowNode>();

  for (let index = 0; index < raw.nodes.length; index += 1) {
    const entry = raw.nodes[index] as RawFlowNode;
    const path = `nodes[${index}]`;
    if (entry === null || typeof entry !== 'object') {
      issues.push({ path, message: '节点必须是对象' });
      continue;
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (id.length === 0) {
      issues.push({ path: `${path}.id`, message: '缺少节点 id' });
      continue;
    }
    if (codePointLength(id) > FLOW_NODE_ID_MAX) {
      issues.push({ path: `${path}.id`, message: `id 不能超过 ${FLOW_NODE_ID_MAX} 个字符` });
      continue;
    }
    if (nodeById.has(id)) {
      issues.push({ path: `${path}.id`, message: `节点 id 重复：${id}` });
      continue;
    }
    const label = typeof entry.label === 'string' ? sanitizeLabel(entry.label) : '';
    if (label.length === 0) {
      issues.push({ path: `${path}.label`, message: '标签不能为空' });
      continue;
    }
    if (codePointLength(label) > LIMITS.flowLabelCodePoints) {
      issues.push({
        path: `${path}.label`,
        message: `标签不能超过 ${LIMITS.flowLabelCodePoints} 个字符`,
      });
      continue;
    }
    if (!Array.isArray(entry.itemIds) || entry.itemIds.length === 0) {
      issues.push({ path: `${path}.itemIds`, message: '节点必须至少引用一条来源' });
      continue;
    }
    if (entry.itemIds.length > LIMITS.selectedItemsPerProjection) {
      issues.push({
        path: `${path}.itemIds`,
        message: `来源不能超过 ${LIMITS.selectedItemsPerProjection} 个`,
      });
      continue;
    }
    const itemIds: string[] = [];
    let badSource = false;
    for (const rawId of entry.itemIds) {
      if (typeof rawId !== 'string' || !allowedItemIds.has(rawId)) {
        issues.push({ path: `${path}.itemIds`, message: '引用了未选择的来源' });
        badSource = true;
        break;
      }
      if (!itemIds.includes(rawId)) itemIds.push(rawId);
    }
    if (badSource) continue;

    const node: FlowNode = { id, label, itemIds };
    nodes.push(node);
    nodeById.set(id, node);
  }

  const rawEdges = Array.isArray(raw.edges) ? raw.edges : null;
  if (rawEdges === null) {
    issues.push({ path: 'edges', message: '缺少边数组' });
  } else if (rawEdges.length > LIMITS.flowEdges) {
    issues.push({ path: 'edges', message: `边不能超过 ${LIMITS.flowEdges} 条` });
  }

  const edges: FlowEdge[] = [];
  const seenEdgeKeys = new Set<string>();
  let downgradedCausal = 0;

  if (rawEdges) {
    for (let index = 0; index < rawEdges.length; index += 1) {
      const entry = rawEdges[index] as RawFlowEdge;
      const path = `edges[${index}]`;
      if (entry === null || typeof entry !== 'object') {
        issues.push({ path, message: '边必须是对象' });
        continue;
      }
      const source = typeof entry.source === 'string' ? entry.source.trim() : '';
      const target = typeof entry.target === 'string' ? entry.target.trim() : '';
      if (!nodeById.has(source)) {
        issues.push({ path: `${path}.source`, message: `边起点不存在：${source || '(空)'}` });
        continue;
      }
      if (!nodeById.has(target)) {
        issues.push({ path: `${path}.target`, message: `边终点不存在：${target || '(空)'}` });
        continue;
      }
      if (source === target) {
        issues.push({ path, message: '不允许自环边' });
        continue;
      }
      if (typeof entry.kind !== 'string' || !FLOW_EDGE_KINDS.includes(entry.kind as FlowEdgeKind)) {
        issues.push({ path: `${path}.kind`, message: '边类型不合法' });
        continue;
      }
      let kind = entry.kind as FlowEdgeKind;

      const label = typeof entry.label === 'string' ? sanitizeLabel(entry.label) : '';
      if (label.length === 0) {
        issues.push({ path: `${path}.label`, message: '边需要文字说明' });
        continue;
      }
      if (codePointLength(label) > LIMITS.flowLabelCodePoints) {
        issues.push({
          path: `${path}.label`,
          message: `边说明不能超过 ${LIMITS.flowLabelCodePoints} 个字符`,
        });
        continue;
      }

      if (!Array.isArray(entry.itemIds) || entry.itemIds.length === 0) {
        issues.push({ path: `${path}.itemIds`, message: '边必须至少引用一条来源' });
        continue;
      }
      const edgeItemIds: string[] = [];
      let badEdgeSource = false;
      for (const rawId of entry.itemIds) {
        if (typeof rawId !== 'string' || !allowedItemIds.has(rawId)) {
          issues.push({ path: `${path}.itemIds`, message: '边引用了未选择的来源' });
          badEdgeSource = true;
          break;
        }
        if (!edgeItemIds.includes(rawId)) edgeItemIds.push(rawId);
      }
      if (badEdgeSource) continue;

      const relationIds: string[] = [];
      if (entry.relationIds !== undefined) {
        if (!Array.isArray(entry.relationIds) || entry.relationIds.length > 8) {
          issues.push({ path: `${path}.relationIds`, message: 'relationIds 不合法' });
          continue;
        }
        let badRelation = false;
        for (const rawId of entry.relationIds) {
          if (typeof rawId !== 'string') {
            issues.push({ path: `${path}.relationIds`, message: 'relationIds 必须是字符串' });
            badRelation = true;
            break;
          }
          if (!relationsById.has(rawId)) {
            // A relation the model invented or that is not in this snapshot is
            // simply dropped; it cannot justify a causal edge.
            continue;
          }
          if (!relationIds.includes(rawId)) relationIds.push(rawId);
        }
        if (badRelation) continue;
      }

      if (kind === 'causal') {
        const justified = relationIds.some((relationId) => {
          const relation = relationsById.get(relationId);
          if (!relation) return false;
          if (relation.type !== 'causes') return false;
          if (relation.reviewStatus !== 'accepted') return false;
          if (relation.isStale) return false;
          const sourceNode = nodeById.get(source) as FlowNode;
          const targetNode = nodeById.get(target) as FlowNode;
          const forward =
            sourceNode.itemIds.includes(relation.sourceId) &&
            targetNode.itemIds.includes(relation.targetId);
          const backward =
            sourceNode.itemIds.includes(relation.targetId) &&
            targetNode.itemIds.includes(relation.sourceId);
          return forward || backward;
        });
        if (!justified) {
          kind = 'hypothesis';
          downgradedCausal += 1;
        }
      }

      if (kind === 'dependency') {
        const justified = relationIds.some((relationId) => {
          const relation = relationsById.get(relationId);
          return relation?.type === 'depends_on' && !relation.isStale;
        });
        if (!justified && relationIds.length > 0) {
          // Keep the model's claim only when the referenced relation supports
          // it; otherwise fall back to the neutral association kind.
          kind = 'association';
        }
      }

      const dedupeKey = `${source}\u0000${target}\u0000${kind}\u0000${label}`;
      if (seenEdgeKeys.has(dedupeKey)) continue;
      seenEdgeKeys.add(dedupeKey);

      edges.push({
        source,
        target,
        kind,
        label,
        itemIds: edgeItemIds,
        relationIds,
      });
    }
  }

  if (issues.length > 0) {
    return { ok: false, content: null, issues, downgradedCausal: 0 };
  }

  const content: FlowContent = {
    title,
    direction: direction as 'LR' | 'TB',
    nodes,
    edges,
  };
  return { ok: true, content, issues: [], downgradedCausal };
}

/** Re-exported so callers can validate a shared label sanitizer import. */
export type { RawMindmap };
