/**
 * Mindmap tree validation and safe Markdown compilation (T056).
 *
 * Two jobs, and the split between them is the point:
 *
 *   1. **Prove the AST is a tree.** Zod proves field shapes; it cannot prove
 *      that there is exactly one root, that every `parentId` resolves, that no
 *      cycle exists, or that every node is reachable from the root. Each of
 *      those is a distinct way a recursive renderer could loop forever or a
 *      subtree could silently vanish, so each gets its own check with the
 *      offending node ids in the message (T056-R01). A structure that fails any
 *      of them is *rejected*, never repaired by dropping the awkward nodes:
 *      quietly discarding a branch produces a tidy-looking mindmap that is
 *      missing material the user selected.
 *
 *   2. **Compile to a restricted Markdown subset.** Only headings and nested
 *      lists — no images, links, HTML, code fences or math (T056-R03/R04). Model
 *      labels are untrusted input like any other, so every label is escaped
 *      rather than interpolated. The escape is applied to a *copy* used for
 *      rendering; the stored canonical content keeps the original label, because
 *      the AST is the artifact and the Markdown is a derivative that a later
 *      compiler version may render differently (T056-R05).
 *
 * This module is pure: no database, no network, no clock, no randomness
 * (T056-R06). That is what makes the same input compile to the same bytes, which
 * in turn is what makes a content hash meaningful.
 */
import { LIMITS } from './limits';
import type { MindmapContent, MindmapNode, UUID } from './knowledge';
import { codePointLength } from './text';
import type { MindmapOutput } from './schemas/mindmap';

/** Bumped whenever the escaping or output shape changes (T056-R05). */
export const MINDMAP_COMPILER_VERSION = 'mindmap-compiler-v2';

export interface MindmapValidationError {
  /** Node ids the message is about; empty when the problem is the whole tree. */
  nodeIds: string[];
  message: string;
}

export interface MindmapValidationResult {
  ok: boolean;
  content?: MindmapContent;
  errors: MindmapValidationError[];
  /** Item ids the tree references, deduplicated, for the source snapshot. */
  referencedItemIds: UUID[];
  /**
   * Nodes whose `itemIds` the server rewrote because they were not in the
   * selection. Reported so the UI can say the tree was corrected rather than
   * pretend the model was right (T055-R02).
   */
  correctedNodeIds: string[];
}

export interface CompileOptions {
  /** Exactly the ids the user selected. Anything else is a fabricated source. */
  allowedItemIds: ReadonlySet<UUID>;
  /** The document title, when the caller wants to force it (the view name). */
  title?: string;
}

/**
 * Validate and normalize a model-produced document.
 *
 * Returns errors instead of throwing: a caller assembling a user-facing message
 * needs *which* node is broken, and the same result feeds both the repair
 * decision and the run's error text.
 */
export function validateMindmap(
  document: MindmapOutput,
  options: CompileOptions,
): MindmapValidationResult {
  const errors: MindmapValidationError[] = [];
  const correctedNodeIds: string[] = [];

  // ---- 1. Node count ----
  if (document.nodes.length > LIMITS.mindmapNodes) {
    errors.push({
      nodeIds: [],
      message: `脑图节点数为 ${document.nodes.length}，超过上限 ${LIMITS.mindmapNodes}`,
    });
    return { ok: false, errors, referencedItemIds: [], correctedNodeIds };
  }

  // ---- 2. Unique ids ----
  const seenIds = new Set<string>();
  const duplicateIds: string[] = [];
  for (const node of document.nodes) {
    if (seenIds.has(node.id)) duplicateIds.push(node.id);
    seenIds.add(node.id);
  }
  if (duplicateIds.length > 0) {
    errors.push({
      nodeIds: [...new Set(duplicateIds)],
      message: `节点 id 重复：${[...new Set(duplicateIds)].join('、')}`,
    });
  }

  // ---- 3. Exactly one root ----
  const roots = document.nodes.filter((node) => node.parentId === null);
  if (roots.length === 0) {
    errors.push({ nodeIds: [], message: '脑图没有根节点（没有任何节点的 parentId 为 null）' });
  } else if (roots.length > 1) {
    errors.push({
      nodeIds: roots.map((node) => node.id),
      message: `脑图有 ${roots.length} 个根节点，必须恰好一个`,
    });
  }

  // ---- 4. Parent exists, and does not point at itself ----
  const dangling: string[] = [];
  const selfParents: string[] = [];
  for (const node of document.nodes) {
    if (node.parentId === null) continue;
    if (node.parentId === node.id) selfParents.push(node.id);
    else if (!seenIds.has(node.parentId)) dangling.push(node.id);
  }
  if (selfParents.length > 0) {
    errors.push({
      nodeIds: selfParents,
      message: `节点把父节点指向了自己：${selfParents.join('、')}`,
    });
  }
  if (dangling.length > 0) {
    errors.push({
      nodeIds: dangling,
      message: `这些节点的父节点不存在，属于悬空子树：${dangling.join('、')}`,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors, referencedItemIds: [], correctedNodeIds };
  }

  // From here the parent links are total, so the graph is a functional graph on
  // a finite set: reachability analysis is now well defined.

  // ---- 5. No cycles (incl. self-loops already rejected above) ----
  const parentOf = new Map<string, string | null>();
  for (const node of document.nodes) parentOf.set(node.id, node.parentId);

  const cycleNodeIds = findCycleNodes(parentOf);
  if (cycleNodeIds.length > 0) {
    errors.push({
      nodeIds: cycleNodeIds,
      message: `节点之间存在环，无法作为树渲染：${cycleNodeIds.join('、')}`,
    });
    return { ok: false, errors, referencedItemIds: [], correctedNodeIds };
  }

  // ---- 6. All nodes reachable from the single root ----
  const root = roots[0]!;
  const childrenOf = new Map<string, string[]>();
  for (const node of document.nodes) {
    if (node.parentId === null) continue;
    const list = childrenOf.get(node.parentId);
    if (list) list.push(node.id);
    else childrenOf.set(node.parentId, [node.id]);
  }

  const reachable = new Set<string>();
  const stack: { id: string; depth: number }[] = [{ id: root.id, depth: 1 }];
  const depthById = new Map<string, number>();
  let deepest = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (reachable.has(current.id)) continue;
    reachable.add(current.id);
    depthById.set(current.id, current.depth);
    deepest = Math.max(deepest, current.depth);
    for (const childId of childrenOf.get(current.id) ?? []) {
      stack.push({ id: childId, depth: current.depth + 1 });
    }
  }

  const unreachable = document.nodes.filter((node) => !reachable.has(node.id)).map((n) => n.id);
  if (unreachable.length > 0) {
    errors.push({
      nodeIds: unreachable,
      message: `这些节点从根节点无法到达：${unreachable.join('、')}`,
    });
  }

  // ---- 7. Depth from the root, root = 1 ----
  if (deepest > LIMITS.mindmapMaxDepth) {
    const tooDeep = document.nodes
      .filter((node) => (depthById.get(node.id) ?? 0) > LIMITS.mindmapMaxDepth)
      .map((node) => node.id);
    errors.push({
      nodeIds: tooDeep,
      message: `层级超过 ${LIMITS.mindmapMaxDepth} 层（最深处 ${deepest} 层）：${tooDeep.join('、')}`,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors, referencedItemIds: [], correctedNodeIds };
  }

  // ---- 8. Sources must come from the selection ----
  //
  // A cited id the model was never shown is a fabricated citation. Dropping just
  // that id would leave a node that *looks* sourced but is not, so the whole
  // document is refused and the caller runs the repair path (T055-C02).
  for (const node of document.nodes) {
    const unknown = node.itemIds.filter((id) => !options.allowedItemIds.has(id));
    if (unknown.length > 0) {
      errors.push({
        nodeIds: [node.id],
        message: `节点「${safeLabelForMessage(node.label)}」引用了不在本次选择中的来源`,
      });
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors, referencedItemIds: [], correctedNodeIds };
  }

  // ---- 9. No source-free node ----
  //
  // Every node must be able to trace its material to `note` nodes beneath it. A
  // group's own declared `itemIds` deliberately do not count: if they did, a
  // branch consisting of nothing but groups could satisfy the check with a claim
  // no leaf backs, which is exactly the invented structure the rule forbids
  // (T055-C04).
  const subtreeSources = computeSubtreeSources(document.nodes, childrenOf);
  for (const node of document.nodes) {
    const resolved = subtreeSources.get(node.id) ?? [];
    if (resolved.length === 0) {
      errors.push({
        nodeIds: [node.id],
        message: `节点「${safeLabelForMessage(node.label)}」没有可回溯的来源`,
      });
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors, referencedItemIds: [], correctedNodeIds };
  }

  // ---- Normalize: labels, ordering, group sources ----
  const normalized = normalizeNodes(document.nodes, childrenOf, subtreeSources, correctedNodeIds);

  const title =
    options.title !== undefined ? options.title : normalizeLabel(document.title);

  return {
    ok: true,
    content: { title, nodes: normalized },
    errors: [],
    referencedItemIds: [...(subtreeSources.get(root.id) ?? [])],
    correctedNodeIds,
  };
}

/**
 * Reorder nodes into breadth-first document order and rewrite group sources.
 *
 * Order is fixed here rather than left to `Object.keys` iteration or the model's
 * array order, because the compiled Markdown's byte-for-byte stability depends on
 * it (T056-R02/R05). Siblings keep the model's relative order, since that order
 * carries the model's own prioritisation.
 */
function normalizeNodes(
  nodes: readonly MindmapOutput['nodes'][number][],
  childrenOf: ReadonlyMap<string, string[]>,
  subtreeSources: ReadonlyMap<string, UUID[]>,
  correctedNodeIds: string[],
): MindmapNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const root = nodes.find((node) => node.parentId === null)!;

  const ordered: MindmapNode[] = [];
  const queue: string[] = [root.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = byId.get(id)!;
    // Groups carry their whole subtree's sources; notes keep exactly what the
    // model cited. This is the server's own computation, so a group cannot claim
    // material that hangs nowhere under it (docs/03_contracts/09 §2).
    const itemIds =
      node.kind === 'group'
        ? [...new Set(subtreeSources.get(node.id) ?? [])]
        : [...new Set(node.itemIds)];
    if (node.kind === 'group') {
      const declared = [...new Set(node.itemIds)];
      const same =
        declared.length === itemIds.length && declared.every((value) => itemIds.includes(value));
      if (!same) correctedNodeIds.push(node.id);
    }
    ordered.push({
      id: node.id,
      parentId: node.parentId,
      label: normalizeLabel(node.label),
      itemIds,
      kind: node.kind,
    });
    for (const childId of childrenOf.get(id) ?? []) queue.push(childId);
  }
  return ordered;
}

/** Union of a subtree's own sources, in first-seen (deterministic) order. */
function computeSubtreeSources(
  nodes: readonly MindmapOutput['nodes'][number][],
  childrenOf: ReadonlyMap<string, string[]>,
): Map<string, UUID[]> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const memo = new Map<string, UUID[]>();

  function resolve(id: string): UUID[] {
    const cached = memo.get(id);
    if (cached) return cached;
    const node = byId.get(id);
    if (!node) return [];
    // Only `note` nodes contribute sources of their own. A `group`'s declared
    // `itemIds` are the model's *claim* about what its subtree covers, and that
    // claim is exactly what gets recomputed here — seeding the union with the
    // claim would make the recomputation vacuous, and the root could then list
    // material that hangs nowhere beneath it.
    const result: UUID[] = node.kind === 'note' ? [...node.itemIds] : [];
    for (const childId of childrenOf.get(id) ?? []) {
      for (const childSource of resolve(childId)) {
        if (!result.includes(childSource)) result.push(childSource);
      }
    }
    memo.set(id, result);
    return result;
  }

  for (const node of nodes) resolve(node.id);
  return memo;
}

/**
 * Find every node on a cycle.
 *
 * Iterative colouring rather than recursion: a 120-node chain is fine either way,
 * but the depth limit is enforced *after* this check, so a maliciously long chain
 * (or a future limit change) must not be able to blow the stack here.
 */
function findCycleNodes(parentOf: ReadonlyMap<string, string | null>): string[] {
  // 0 = unvisited, 1 = on the current path, 2 = settled.
  const state = new Map<string, 0 | 1 | 2>();
  const onCycle = new Set<string>();

  for (const start of parentOf.keys()) {
    if (state.get(start) === 2) continue;
    const path: string[] = [];
    let current: string | null = start;
    while (current !== null) {
      const seenState = state.get(current);
      if (seenState === 1) {
        // Everything from the first occurrence of `current` onward is the cycle.
        const from = path.indexOf(current);
        for (const id of path.slice(from)) onCycle.add(id);
        break;
      }
      if (seenState === 2) break;
      state.set(current, 1);
      path.push(current);
      current = parentOf.get(current) ?? null;
    }
    for (const id of path) state.set(id, 2);
  }

  return [...onCycle];
}

/**
 * Normalize a label for display and for the canonical AST.
 *
 * Newlines and other control characters become a single space: they are how a
 * label would break out of its line and start a second Markdown construct, and
 * collapsing them keeps the AST itself safe rather than relying on the escaper
 * alone (T056-R03).
 */
export function normalizeLabel(label: string): string {
  return label
    // All C0/C1 controls plus DEL; a tab is whitespace and folds into the space.
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** A short, escaped label for error messages; never the full original text. */
function safeLabelForMessage(label: string): string {
  const normalized = normalizeLabel(label);
  const points = Array.from(normalized);
  return points.length <= 20 ? normalized : `${points.slice(0, 20).join('')}…`;
}

/**
 * Child index for one node list, in the order the nodes are stored.
 *
 * Built once and shared by the compiler, the id walker and the structural
 * inspector, because all three must visit children in the *same* order for the
 * rendered map, the AST node ids and the outline to line up. Three separate
 * loop-and-push implementations would agree until one of them was edited.
 *
 * Exported because the renderer and the outline need the same ordering
 * (T058-R05): a second traversal written on the UI side would be a second
 * definition of "the children of this node", and the two would drift the moment
 * either changed.
 */
export function mindmapChildrenIndex(
  nodes: readonly MindmapNode[],
): Map<string, string[]> {
  const childrenOf = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const list = childrenOf.get(node.parentId);
    if (list) list.push(node.id);
    else childrenOf.set(node.parentId, [node.id]);
  }
  return childrenOf;
}

/**
 * The root node of a validated tree, or null when the list has no root.
 *
 * `validateMindmap` guarantees exactly one, but this function is also called on
 * stored content read back from the database, where a hand-edited row could
 * have none. Returning null lets the callers degrade to a readable outline
 * instead of throwing inside a render.
 */
export function mindmapRoot(content: MindmapContent): MindmapNode | null {
  return content.nodes.find((node) => node.parentId === null) ?? null;
}

/**
 * Every AST node in pre-order, root first.
 *
 * This is the one traversal that defines "the order the nodes appear in the
 * compiled document", and `compileMindmap` and `mindmapMarkdownNodeIds` are both
 * written in terms of it. Two separate walks would agree until one of them was
 * edited, and the symptom of a drift is a *click on a node opening another node's
 * sources* — invisible in a screenshot, wrong in every source lookup.
 *
 * Iterative for the same reason as the compiler: this runs on stored content,
 * whose depth is not bounded by the ingest limits, and a `RangeError` here would
 * blank the map instead of reporting the problem (T057-C06).
 */
function walkPreOrder(content: MindmapContent): { id: string; depth: number }[] {
  const root = mindmapRoot(content);
  if (!root) return [];

  const childrenOf = mindmapChildrenIndex(content.nodes);
  const ordered: { id: string; depth: number }[] = [];
  const stack: { id: string; depth: number }[] = [{ id: root.id, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop()!;
    ordered.push(current);
    const childIds = childrenOf.get(current.id) ?? [];
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      stack.push({ id: childIds[index]!, depth: current.depth + 1 });
    }
  }
  return ordered;
}

/**
 * Compile a validated tree to restricted Markdown.
 *
 * The output uses two constructs only: one `# ` heading and nested `- ` list
 * items. Nothing in a label can introduce a third: every Markdown-significant
 * character is escaped, so `![x](y)` renders as the literal text `![x](y)` and
 * never as an image request (T056-C04).
 *
 * The heading is the document title. Markmap turns that heading into its own root
 * node, so the AST root is emitted as a list item *only when its label differs
 * from the title* — printing it otherwise would duplicate the same words on two
 * adjacent lines. `mindmapMarkdownNodeIds` records the same decision, which is
 * what keeps the compiled Markdown and the node identity in step (T057-R01).
 */
export function compileMindmap(content: MindmapContent): string {
  const lines: string[] = [`# ${escapeMarkdownLabel(content.title)}`, ''];
  const byId = new Map(content.nodes.map((node) => [node.id, node]));

  for (const { id, depth } of walkPreOrder(content)) {
    const node = byId.get(id);
    if (!node) continue;
    // The root joins the heading when the two labels match.
    const foldedIntoTitle = depth === 0 && node.label === content.title;
    if (foldedIntoTitle) continue;
    lines.push(`${'  '.repeat(depth)}- ${escapeMarkdownLabel(node.label)}`);
  }

  return lines.join('\n');
}

/**
 * Escape a label so no character in it can start a Markdown construct.
 *
 * The set is chosen for *this* subset rather than copied wholesale from a
 * generic escaper, because escaping a character that cannot matter costs
 * readability: escaping `.` would turn a cited URL into
 * `http://evil\.example/x\.png` while changing nothing about how it parses.
 *
 * Included, and why each one matters:
 *   - `` ` `` code spans, `*` `_` `~` emphasis/strikethrough,
 *   - `[` `]` `(` `)` links and images, `!` image marker,
 *   - `<` `>` HTML and autolinks,
 *   - `#` headings, `|` tables, `{` `}` extension blocks,
 *   - `\` first of all, so the escapes added below are not themselves escaped.
 *
 * Excluded, and why it is safe here: `-`, `+`, `.` and digits only introduce
 * structure at the *start* of a line. Every label is emitted mid-line after `- `
 * or after `# `, and `normalizeLabel` has already removed the newlines that
 * would have let a label begin a line of its own.
 */
export function escapeMarkdownLabel(label: string): string {
  return label.replace(/\\/gu, '\\\\').replace(/([`*_~[\]()<>#!|{}])/gu, '\\$1');
}

/**
 * The AST node ids in the same order `compileMindmap` emits them.
 *
 * Exported because a renderer has to attach an identity to each rendered node,
 * and the only honest source for that identity is the writer of the Markdown.
 * Deriving the order a second time from the AST inside the renderer would be a
 * second implementation of the same traversal, and the two would drift the
 * moment either one changed.
 *
 * **One entry per node that becomes a Markmap node**, which is what makes this
 * list and `transformer.transform(markdown).root` the same length. Markmap builds
 * its root from the `# title` heading, so:
 *
 *  - when the AST root's label equals the title, the heading *is* that node and it
 *    appears first here, with no list item of its own;
 *  - when the two differ, the heading is a synthetic title node that stands for no
 *    AST node, and the AST root appears first as the outermost list item.
 *
 * Either way the sequence is the pre-order walk of the whole tree, positions
 * unchanged, so a caller can zip it against the transformed nodes positionally.
 * An earlier version dropped the title-folded root and left a gap — the renderer
 * then paired the transformed root with the first *child*, and the mismatch was
 * reported as a structure error (`节点 3 个，编译 2 个`) on every well-formed
 * mindmap whose root was named after its own title.
 */
export function mindmapMarkdownNodeIds(content: MindmapContent): string[] {
  return walkPreOrder(content).map((entry) => entry.id);
}

/** Deterministic digest input: the compiler version plus the canonical content. */
export function mindmapCompileInput(content: MindmapContent): {
  compilerVersion: string;
  content: MindmapContent;
} {
  return { compilerVersion: MINDMAP_COMPILER_VERSION, content };
}

/** True when the label survives normalization unchanged (used by tests). */
export function isLabelStable(label: string): boolean {
  return normalizeLabel(label) === label && codePointLength(label) > 0;
}

export interface MindmapStructureIssue {
  /** Node ids the problem is about; empty when it concerns the whole tree. */
  nodeIds: string[];
  message: string;
}

/**
 * Structural check on *stored* mindmap content (T057-R06).
 *
 * `validateMindmap` already rejects every one of these shapes on the way in, so
 * a well-behaved database never contains one. This exists for the other routes
 * into `content_json`: a row written by an older build, a hand-edited database, a
 * fixture, or a future schema the running client does not know about. In all of
 * those cases the honest outcome is to *not draw* and to say why, rather than to
 * hand a malformed tree to Markmap and let a recursive renderer discover the
 * cycle.
 *
 * It is a separate function from the ingest validator rather than a second mode
 * of it, because the two answer different questions: the validator decides
 * whether a *model answer* may become a View, while this decides whether a
 * *stored View* can be drawn at all. The second must not re-litigate sources,
 * labels or budgets — a View that was accepted once is drawn the same way
 * forever, even if the limits are later tightened.
 */
export function inspectMindmapTree(content: MindmapContent): MindmapStructureIssue[] {
  const issues: MindmapStructureIssue[] = [];
  const nodes = content.nodes;
  if (nodes.length === 0) {
    return [{ nodeIds: [], message: '这张脑图没有任何节点' }];
  }

  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) duplicates.push(node.id);
    seen.add(node.id);
  }
  if (duplicates.length > 0) {
    issues.push({
      nodeIds: [...new Set(duplicates)],
      message: `节点 id 重复：${[...new Set(duplicates)].join('、')}`,
    });
    // A duplicated id makes every later check ambiguous, so the diagnosis stops
    // here rather than reporting a second problem that may be an artefact of it.
    return issues;
  }

  const roots = nodes.filter((node) => node.parentId === null);
  if (roots.length !== 1) {
    issues.push({
      nodeIds: roots.map((node) => node.id),
      message:
        roots.length === 0
          ? '这张脑图没有根节点，无法确定从哪里开始画'
          : `这张脑图有 ${roots.length} 个根节点，无法确定从哪里开始画`,
    });
    return issues;
  }

  const dangling = nodes.filter(
    (node) => node.parentId !== null && !seen.has(node.parentId),
  );
  if (dangling.length > 0) {
    issues.push({
      nodeIds: dangling.map((node) => node.id),
      message: `这些节点的父节点不存在，无法显示：${dangling.map((node) => node.id).join('、')}`,
    });
    return issues;
  }

  const childrenOf = mindmapChildrenIndex(nodes);
  const reachable = new Set<string>();
  const stack = [roots[0]!.id];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const childId of childrenOf.get(id) ?? []) stack.push(childId);
  }
  if (reachable.size !== nodes.length) {
    const unreachable = nodes.filter((node) => !reachable.has(node.id)).map((node) => node.id);
    issues.push({
      nodeIds: unreachable,
      message: `这些节点不在这棵树上（存在环或孤立分支）：${unreachable.join('、')}`,
    });
  }

  return issues;
}
