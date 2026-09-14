/**
 * Mindmap AST validation.
 *
 * The model returns a restricted hierarchy, never Markdown. The server checks
 * structure, sources and bounds before anything becomes a View
 * (docs/03_contracts/09_view_schemas_and_compilers.md §2).
 */
import { LIMITS } from './limits';
import type { MindmapContent, MindmapNode } from './knowledge';
import { codePointLength } from './text';

export const MINDMAP_NODE_ID_MAX = LIMITS.mindmapNodeIdCodePoints;

export interface MindmapValidationIssue {
  path: string;
  message: string;
}

export interface MindmapValidationResult {
  ok: boolean;
  content: MindmapContent | null;
  issues: MindmapValidationIssue[];
}

/**
 * Raw shape as parsed from the model, before validation. Everything is optional
 * because the input is untrusted.
 */
export interface RawMindmapNode {
  id?: unknown;
  parentId?: unknown;
  label?: unknown;
  itemIds?: unknown;
  kind?: unknown;
}

export interface RawMindmap {
  title?: unknown;
  nodes?: unknown;
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

/** Replace disallowed control characters with a safe space. */
export function sanitizeLabel(value: string): string {
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/gu, ' ').trim();
}

export function validateMindmap(
  raw: RawMindmap,
  allowedItemIds: ReadonlySet<string>,
): MindmapValidationResult {
  const issues: MindmapValidationIssue[] = [];

  const title = typeof raw.title === 'string' ? sanitizeLabel(raw.title) : '';
  if (title.length === 0) {
    issues.push({ path: 'title', message: '缺少标题' });
  } else if (codePointLength(title) > LIMITS.titleCodePoints) {
    issues.push({ path: 'title', message: `标题不能超过 ${LIMITS.titleCodePoints} 个字符` });
  }

  if (!Array.isArray(raw.nodes)) {
    issues.push({ path: 'nodes', message: '缺少节点数组' });
    return { ok: false, content: null, issues };
  }
  if (raw.nodes.length === 0) {
    issues.push({ path: 'nodes', message: '节点不能为空' });
  }
  if (raw.nodes.length > LIMITS.mindmapNodes) {
    issues.push({ path: 'nodes', message: `节点不能超过 ${LIMITS.mindmapNodes} 个` });
  }

  const nodes: MindmapNode[] = [];
  const byId = new Map<string, MindmapNode>();

  for (let index = 0; index < raw.nodes.length; index += 1) {
    const entry = raw.nodes[index] as RawMindmapNode;
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
    if (codePointLength(id) > MINDMAP_NODE_ID_MAX) {
      issues.push({ path: `${path}.id`, message: `id 不能超过 ${MINDMAP_NODE_ID_MAX} 个字符` });
      continue;
    }
    if (byId.has(id)) {
      issues.push({ path: `${path}.id`, message: `节点 id 重复：${id}` });
      continue;
    }

    let parentId: string | null = null;
    if (entry.parentId !== null && entry.parentId !== undefined) {
      if (typeof entry.parentId !== 'string' || entry.parentId.trim().length === 0) {
        issues.push({ path: `${path}.parentId`, message: 'parentId 必须是非空字符串或 null' });
        continue;
      }
      parentId = entry.parentId.trim();
      if (parentId === id) {
        issues.push({ path: `${path}.parentId`, message: '节点不能指向自己' });
        continue;
      }
    }

    const label = typeof entry.label === 'string' ? sanitizeLabel(entry.label) : '';
    if (label.length === 0) {
      issues.push({ path: `${path}.label`, message: '标签不能为空' });
      continue;
    }
    if (codePointLength(label) > LIMITS.mindmapLabelCodePoints) {
      issues.push({
        path: `${path}.label`,
        message: `标签不能超过 ${LIMITS.mindmapLabelCodePoints} 个字符`,
      });
      continue;
    }

    const kind = entry.kind;
    if (kind !== 'group' && kind !== 'note') {
      issues.push({ path: `${path}.kind`, message: 'kind 只能是 group 或 note' });
      continue;
    }

    if (!Array.isArray(entry.itemIds)) {
      issues.push({ path: `${path}.itemIds`, message: 'itemIds 必须是数组' });
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
    let invalidSource = false;
    for (const rawId of entry.itemIds) {
      if (typeof rawId !== 'string') {
        issues.push({ path: `${path}.itemIds`, message: '来源 id 必须是字符串' });
        invalidSource = true;
        break;
      }
      if (!allowedItemIds.has(rawId)) {
        issues.push({ path: `${path}.itemIds`, message: `引用了未选择的来源：${rawId}` });
        invalidSource = true;
        break;
      }
      if (!itemIds.includes(rawId)) itemIds.push(rawId);
    }
    if (invalidSource) continue;

    if (kind === 'note' && itemIds.length === 0) {
      issues.push({ path: `${path}.itemIds`, message: 'note 节点必须至少引用一条来源' });
      continue;
    }

    const node: MindmapNode = { id, parentId, label, itemIds, kind };
    nodes.push(node);
    byId.set(id, node);
  }

  if (issues.length > 0) {
    return { ok: false, content: null, issues };
  }

  // Structural checks: exactly one root, all parents exist, no cycles/islands.
  const roots = nodes.filter((node) => node.parentId === null);
  if (roots.length !== 1) {
    issues.push({ path: 'nodes', message: `必须恰好有一个根节点，当前有 ${roots.length} 个` });
  }

  for (const node of nodes) {
    if (node.parentId !== null && !byId.has(node.parentId)) {
      issues.push({ path: `nodes.${node.id}.parentId`, message: `父节点不存在：${node.parentId}` });
    }
  }

  if (issues.length > 0) return { ok: false, content: null, issues };

  const root = roots[0];
  const children = new Map<string, MindmapNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }

  const visited = new Set<string>();
  const depth = new Map<string, number>();
  let depthLimitExceeded = false;
  const stack: { node: MindmapNode; depth: number }[] = [{ node: root, depth: 1 }];

  while (stack.length > 0) {
    const current = stack.pop() as { node: MindmapNode; depth: number };
    if (visited.has(current.node.id)) {
      // A repeated node means a cycle; because each node only reaches its own
      // parents, this can only happen through a malformed graph.
      continue;
    }
    visited.add(current.node.id);
    depth.set(current.node.id, current.depth);
    if (current.depth > LIMITS.mindmapMaxDepth) depthLimitExceeded = true;
    for (const child of children.get(current.node.id) ?? []) {
      stack.push({ node: child, depth: current.depth + 1 });
    }
  }

  if (visited.size !== nodes.length) {
    const unreachable = nodes.filter((node) => !visited.has(node.id)).map((node) => node.id);
    issues.push({
      path: 'nodes',
      message: `存在无法从根访问的节点（环或孤岛）：${unreachable.slice(0, 5).join(', ')}`,
    });
  }
  if (depthLimitExceeded) {
    issues.push({ path: 'nodes', message: `层级不能超过 ${LIMITS.mindmapMaxDepth} 层` });
  }

  // Every group's sources must equal the union of its subtree's sources. This
  // stops the model from attaching an unused "fake citation" at the root.
  const subtreeSources = new Map<string, string[]>();
  const computeSubtree = (node: MindmapNode): string[] => {
    const cached = subtreeSources.get(node.id);
    if (cached) return cached;
    const collected = new Set<string>(node.itemIds);
    for (const child of children.get(node.id) ?? []) {
      for (const id of computeSubtree(child)) collected.add(id);
    }
    const result = [...collected];
    subtreeSources.set(node.id, result);
    return result;
  };
  computeSubtree(root);

  for (const node of nodes) {
    const computed = subtreeSources.get(node.id) ?? [];
    const declared = [...node.itemIds].sort();
    const expected = [...computed].sort();
    if (declared.length !== expected.length || declared.some((id, i) => id !== expected[i])) {
      issues.push({
        path: `nodes.${node.id}.itemIds`,
        message: '节点来源与其子树来源不一致',
      });
    }
  }

  if (issues.length > 0) return { ok: false, content: null, issues };

  const finalNodes = nodes.map((node) => ({ ...node, itemIds: subtreeSources.get(node.id) ?? node.itemIds }));
  return { ok: true, content: { title, nodes: finalNodes }, issues: [] };
}
