/**
 * Restricted Flow -> Mermaid compiler (T064).
 *
 * The model never supplies Mermaid. It supplies nodes, edges and a kind per edge
 * (`src/domain/flow.ts` validates that), and this module is the **only** writer of
 * flowchart syntax. Everything below follows from taking that sentence seriously:
 *
 *  1. **Syntax is guaranteed by construction, not by parsing (T064-R02).** There
 *     is no server-side `mermaid.parse` here on purpose: Mermaid's parser needs a
 *     DOM (`DOMPurify.addHook` is unavailable in the Node runtime), so a
 *     "validate then emit" design cannot run where this code runs. Instead the
 *     output is built from three line templates only, and then
 *     `assertFlowchartSource` *re-checks the emitted text against those same
 *     templates*. A label cannot introduce a fourth template because it never
 *     leaves the quoted position, and the check proves that rather than assuming
 *     it.
 *
 *  2. **Labels are data, encoded once (T064-R03), and the encoding is *measured*
 *     rather than assumed.** `escapeFlowLabel` is a single-pass character map
 *     rather than an ordered chain of `replace` calls, because a chain gets the
 *     order wrong the moment someone adds a rule.
 *
 *     Two measured facts about the locked Mermaid build (11.17.2), both obtained
 *     by rendering candidate labels through this product's own
 *     `renderFlowSvg` in a real Chromium and reading the drawn `<text>`:
 *
 *       a. **An entity without `&` is dead text.** Mermaid's own render pipeline
 *          rewrites `#<word>;` source into `&#<word>;`, and *then* the browser
 *          decodes it. So a numeric entity typed **without** the ampersand —
 *          `#60;`, `#34;`, `#40;` — survives as the literal string `&#60;` and is
 *          what the user actually reads on screen. That is why the previous
 *          table, which emitted `#34;` / `#60;` / `#62;` / `#92;`, displayed
 *          `&#60;img src=x onerror=…&#62;` instead of the note's sentence, and
 *          why an escaped `(` appeared as `&#40;`. Measured, not inferred.
 *       b. **Only three characters can escape the quoted position**, and each is
 *          neutralised by a *decodable* entity that renders back as itself:
 *
 *          - `&` — the ampersand that starts an entity. Left raw, a label
 *            containing `&lt;` becomes a real `<`, which is how a note turns into
 *            markup. `&amp;` renders as `&`.
 *          - `<` `>` — with `htmlLabels: false` these are still read as HTML:
 *            `A<B>C` was drawn as `A <b> C </b>`, and `<script>alert(1)</script>`
 *            as a script tag. `&lt;` / `&gt;` render as `<` / `>`.
 *          - `"` — the only clean delimiter for a Mermaid label. There is **no**
 *            working entity for it: `&quot;`, `#quot;` and `#34;` all reach the
 *            screen as their own text, and `\"` does not survive the lexer.
 *            `import { ZERO_WIDTH_SPACE } from 'mermaid'` is real, but Mermaid
 *            strips it before parsing, so it cannot be used to hide a delimiter.
 *            A literal `"` is therefore written as U+FF02 (FULLWIDTH QUOTATION
 *            MARK) — it renders as `＂`, stays inside the quotes, and keeps the
 *            sentence readable, which is what T064-C02's 「文字可辨认」 asks for.
 *            This is the one unavoidable lossy substitution, and it is stated as
 *            such rather than hidden behind an unreadable `&quot;`.
 *       - Everything else — `[` `]` `(` `)` `{` `}` `|` `#` `;` `` ` `` `\` —
 *         is inert inside the quotes and renders literally. The backslash is left
 *         raw on purpose: the lexer does not treat `\` or `\"` as an escape (both
 *         parse as ordinary characters), so encoding it would only put
 *         `&amp;#92;` on screen.
 *
 *  3. **Model ids never reach the syntax (T064-R01).** Nodes are renumbered to
 *     `N0…Nn` in content order and the mapping table is returned, so a node id of
 *     `n1"] --> evil["x` is a *string in a table*, never a token.
 *
 *  4. **The visual language is one table (T064-R04).** `FLOW_EDGE_STYLES` is the
 *     single kind -> (line style, label prefix) mapping. A hypothesis is dashed
 *     *and* says 推测; an association says 相关 so a plain arrow cannot read as a
 *     proven cause.
 *
 * Pure: no database, no clock, no DOM, no randomness (T064-R06). The same content
 * compiles to the same bytes, which is what makes the compiled source a derivative
 * that can be regenerated rather than a stored truth (T067-R02).
 */
import type { FlowContent, FlowEdgeKind, UUID } from './knowledge';
import { LIMITS } from './limits';
import { inspectFlow, type FlowStructureIssue } from './validateFlow';

/** Bumped whenever the escaping or the emitted shape changes (T064-R05 analogue). */
export const FLOW_COMPILER_VERSION = 'flow-compiler-v4';

/** The only two first lines this compiler can emit. */
export const FLOWCHART_HEADER_DIRECTIONS = ['LR', 'TB'] as const;

/* -------------------------------------------------------------------------- */
/* Label encoding                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The characters that can leave the quoted position, and what each becomes.
 *
 * Every entry is a *decodable* entity (the browser turns it back into the
 * character) except the quote, which has no working entity at all — see the
 * module docblock for the four measured probes behind both statements.
 *
 * `&` must be listed: without it, a note that literally reads `&lt;script&gt;`
 * would be decoded by Mermaid into a real tag instead of staying a sentence.
 */
const LABEL_ENTITIES: Record<string, string> = {
  /** Starts an entity; left raw it would let `&lt;` in a note become a real `<`. */
  '&': '&amp;',
  /** Raw `<` `>` are parsed as HTML even with `htmlLabels: false`. */
  '<': '&lt;',
  '>': '&gt;',
  /**
   * Closes the label it sits inside, and the only character here with no entity:
   * `&quot;` / `#quot;` / `#34;` each reach the screen as their own text, and
   * `\"` is not a lexer escape. U+FF02 renders as `＂` — visible, unambiguous,
   * and inert inside the quotes.
   */
  '"': '\uff02',
};

/**
 * The one place a label could still be read as syntax rather than text.
 *
 * Mermaid's flowchart lexer recognises `direction` where a *statement* is
 * expected, and a quoted label at the start of a line is such a place: the label
 * `direction TB` was observed to **delete the node it belonged to** and set the
 * graph direction. The rest of the quoted text cannot do this — `end`, `graph`,
 * `subgraph`, `click`, `classDef`, `style`, `linkStyle`, `flowchart` and
 * `accTitle` were measured to render as ordinary text. `%%{` is still an init
 * fence even inside a quoted label, so it is broken below.
 *
 * A zero-width space is inserted between the word and its argument. It is
 * invisible, it breaks the lexer's lookahead, and the label still reads
 * `direction TB` to a human — which matters, because self-encoded noise was
 * already rejected once on this module (see the note on `escapeFlowLabel`).
 */
const DIRECTION_KEYWORD = /(\bdirection)(\s+)(?=(?:TB|BT|LR|RL|TD)\b)/gu;
const INIT_FENCE = /%%\{/gu;
const ZERO_WIDTH_SPACE = '\u200b';

/** C0/C1 controls plus DEL. A newline is how a label would become a second line. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/gu;

/**
 * Collapse a label to one safe line before encoding it.
 *
 * Newlines become a space rather than being deleted, so two words do not fuse
 * into one; runs of whitespace collapse so the result is stable regardless of how
 * the text was wrapped in the note.
 */
export function normalizeFlowLabel(value: string): string {
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/gu, ' ').trim();
}

/**
 * Encode a label so nothing in it can end the quoted position it is written into.
 *
 * Single pass by construction: the replacement is looked up per character, so an
 * entity this function produced can never be re-encoded by a later rule. The one
 * non-entity adjustment (`direction`, see `DIRECTION_KEYWORD`) happens before the
 * pass and only ever inserts a zero-width space, which is not an entity and so
 * cannot be re-encoded either.
 */
export function escapeFlowLabel(value: string): string {
  const folded = normalizeFlowLabel(value)
    .replace(DIRECTION_KEYWORD, `$1${ZERO_WIDTH_SPACE}$2`)
    .replace(INIT_FENCE, `%${ZERO_WIDTH_SPACE}%{`);
  let result = '';
  for (const character of folded) {
    result += LABEL_ENTITIES[character] ?? character;
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* The one style table                                                        */
/* -------------------------------------------------------------------------- */

export interface FlowEdgeStyle {
  /** `solid` is `-->`; `dashed` is `-.->`. Only a hypothesis is dashed. */
  line: 'solid' | 'dashed';
  /** Written at the front of the edge label so the relation is stated, not implied. */
  prefix: string;
  /**
   * Words that already mark this kind, so the prefix is not doubled.
   *
   * `建议` is here because the prompt offers it as an alternative to `推测` for a
   * hypothesis, and prefixing a label that already says it would read as a stutter.
   */
  altWords?: readonly string[];
}

/**
 * The unique mapping from semantic type to presentation (T064-R04).
 *
 * A `Record<FlowEdgeKind, …>` rather than a chain of `if`s: adding a kind to the
 * contract makes this table fail to compile until it is given a style, which is
 * the only way "every kind has exactly one appearance" stays true.
 *
 * Every kind carries an explicit word. An unlabelled arrow is the single most
 * persuasive way to assert a cause that was never established, so `association`
 * says 相关 and `causal` may only be reached through the evidence gate in
 * `flow.ts` — the styling cannot *make* an association look causal, and the wording
 * cannot be dropped to make it look cleaner.
 */
export const FLOW_EDGE_STYLES: Record<FlowEdgeKind, FlowEdgeStyle> = {
  sequence: { line: 'solid', prefix: '顺序：' },
  dependency: { line: 'solid', prefix: '依赖：' },
  association: { line: 'solid', prefix: '相关：' },
  causal: { line: 'solid', prefix: '因果：' },
  hypothesis: { line: 'dashed', prefix: '推测：', altWords: ['建议'] },
};

/** The arrow token for a style. Exported so the structural check and tests share it. */
export function arrowFor(kind: FlowEdgeKind): '-->' | '-.->' {
  return FLOW_EDGE_STYLES[kind].line === 'dashed' ? '-.->' : '-->';
}

/**
 * Put the kind's word in front of a label, once.
 *
 * A label already beginning with its own word is left alone so a model that
 * followed the prompt (`推测：材料不足`) is not rendered as `推测：推测：材料不足`.
 */
export function labelForKind(
  kind: FlowEdgeKind,
  label: string,
  basis?: 'relation' | 'material' | 'inference',
): string {
  const style = FLOW_EDGE_STYLES[kind];
  const normalized = normalizeFlowLabel(label);
  const word = style.prefix.slice(0, -1);
  const marks = [word, ...(style.altWords ?? [])];
  let prefixed = marks.some((mark) => normalized.startsWith(mark))
    ? normalized
    : `${style.prefix}${normalized}`;
  if (basis === 'material') {
    prefixed = prefixed.replace(/^因果：/u, '');
    if (!prefixed.startsWith('材料表述')) prefixed = `材料表述：${prefixed}`;
  } else if (basis === 'relation' && kind === 'causal') {
    prefixed = prefixed.replace(/^因果：/u, '已确认关系：');
    if (!prefixed.startsWith('已确认关系')) prefixed = `已确认关系：${prefixed}`;
  }
  return prefixed;
}

function legendPrefix(
  kind: FlowEdgeKind,
  basis?: 'relation' | 'material' | 'inference',
): string {
  if (basis === 'material') return '材料表述：';
  if (basis === 'relation' && kind === 'causal') return '已确认关系：';
  return FLOW_EDGE_STYLES[kind].prefix;
}

/* -------------------------------------------------------------------------- */
/* Compiled result                                                            */
/* -------------------------------------------------------------------------- */

/** One node, as the renderer and the source panel need to see it. */
export interface CompiledFlowNode {
  /** The safe id that appears in the syntax, e.g. `N3`. */
  mermaidId: string;
  /** The model's own id, kept only so the mapping table is inspectable. */
  nodeId: string;
  /** The label as stored in the canonical content (unencoded). */
  label: string;
  itemIds: UUID[];
}

export interface CompiledFlowEdge {
  sourceId: string;
  targetId: string;
  /** The model's node ids, for the same reason as above. */
  source: string;
  target: string;
  kind: FlowEdgeKind;
  /** The label as stored in the canonical content (unencoded, without prefix). */
  label: string;
  /** Exactly the text drawn on the edge, prefix included. */
  displayLabel: string;
  itemIds: UUID[];
  relationIds: UUID[];
  basis?: 'relation' | 'material' | 'inference';
}

/** One row of the on-screen legend, derived from the table rather than retyped. */
export interface FlowLegendEntry {
  kind: FlowEdgeKind;
  line: 'solid' | 'dashed';
  prefix: string;
}

export interface CompiledFlow {
  /** The Mermaid source. The only place flowchart syntax is produced. */
  source: string;
  direction: 'LR' | 'TB';
  compilerVersion: string;
  nodes: CompiledFlowNode[];
  edges: CompiledFlowEdge[];
  /** Model node id -> safe id, for debugging and for tests to assert on. */
  nodeIdMap: Record<string, string>;
  /** Only the kinds actually present, in contract order. */
  legend: FlowLegendEntry[];
  /** Edges dropped because an identical one already existed (T064-R05). */
  droppedDuplicateEdges: number;
}

export type CompileFlowResult =
  | { ok: true; compiled: CompiledFlow }
  | { ok: false; issues: FlowStructureIssue[] };

/* -------------------------------------------------------------------------- */
/* Compile                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Compile validated flow content into restricted Mermaid.
 *
 * Order is fixed — nodes in content order, then edges in content order — because
 * a deterministic walk is the only reason the same View regenerates the same
 * source, which is what lets the export be derived instead of stored.
 *
 * Refuses rather than repairs when the stored content is not drawable: a dangling
 * endpoint cannot be fixed by inventing the missing node, and doing so would put a
 * label on screen that no source backs (T063-C03).
 */
export function compileFlow(content: FlowContent): CompileFlowResult {
  const issues = inspectFlow(content);
  if (issues.length > 0) return { ok: false, issues };

  const direction: 'LR' | 'TB' = content.direction === 'TB' ? 'TB' : 'LR';

  // ---- Assign safe ids (T064-R01) ----
  //
  // Index into the content's own node order, so the mapping is a property of the
  // document rather than of the model's choice of id.
  const nodeIdMap: Record<string, string> = {};
  const nodes: CompiledFlowNode[] = content.nodes.map((node, index) => {
    const mermaidId = `N${index}`;
    nodeIdMap[node.id] = mermaidId;
    return {
      mermaidId,
      nodeId: node.id,
      label: node.label,
      itemIds: [...node.itemIds],
    };
  });

  // ---- Normalize edges: drop exact duplicates, keep first (T064-R05) ----
  //
  // The key is the contract's (docs/03_contracts/09 §3): same source, target, kind
  // and label. Item ids are deliberately *not* part of it — the same connection
  // citing two different notes is one arrow, and drawing it twice would suggest two
  // separate relations. Cycles are never removed: a flow may legitimately loop, and
  // deleting an edge to make the graph acyclic would drop material the user chose.
  const seen = new Set<string>();
  const edges: CompiledFlowEdge[] = [];
  let droppedDuplicateEdges = 0;

  for (const edge of content.edges) {
    const key = `${edge.source}\u0000${edge.target}\u0000${edge.kind}\u0000${normalizeFlowLabel(edge.label)}`;
    if (seen.has(key)) {
      droppedDuplicateEdges += 1;
      continue;
    }
    seen.add(key);
    edges.push({
      sourceId: nodeIdMap[edge.source]!,
      targetId: nodeIdMap[edge.target]!,
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      label: edge.label,
      displayLabel: labelForKind(edge.kind, edge.label, edge.basis),
      itemIds: [...edge.itemIds],
      relationIds: [...edge.relationIds],
      basis: edge.basis,
    });
  }

  // ---- Emit ----
  //
  // Declared first, referenced second, so an edge can never be the thing that
  // brings a node into existence — the order is what makes "every endpoint exists"
  // a property of the text and not just of the AST.
  const lines: string[] = [`flowchart ${direction}`];
  for (const node of nodes) {
    lines.push(`  ${node.mermaidId}["${escapeFlowLabel(node.label)}"]`);
  }
  for (const edge of edges) {
    lines.push(
      `  ${edge.sourceId} ${arrowFor(edge.kind)}|"${escapeFlowLabel(edge.displayLabel)}"| ${edge.targetId}`,
    );
  }
  const source = lines.join('\n');

  // ---- Prove what was emitted (see the module docblock) ----
  const selfCheck = assertFlowchartSource(source);
  if (selfCheck.length > 0) {
    return {
      ok: false,
      issues: selfCheck.map((message) => ({ ids: [], message })),
    };
  }

  const legend: FlowLegendEntry[] = [];
  const seenLegend = new Set<string>();
  for (const kind of Object.keys(FLOW_EDGE_STYLES) as FlowEdgeKind[]) {
    for (const edge of edges) {
      if (edge.kind !== kind) continue;
      const prefix = legendPrefix(kind, edge.basis);
      const key = `${kind}\u0000${prefix}`;
      if (seenLegend.has(key)) continue;
      seenLegend.add(key);
      legend.push({
        kind,
        line: FLOW_EDGE_STYLES[kind].line,
        prefix,
      });
    }
  }

  return {
    ok: true,
    compiled: {
      source,
      direction,
      compilerVersion: FLOW_COMPILER_VERSION,
      nodes,
      edges,
      nodeIdMap,
      legend,
      droppedDuplicateEdges,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Structural verification                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Lines the compiler is allowed to produce.
 *
 * `[^"]*` in the label position is the whole safety argument: since
 * `escapeFlowLabel` removes every raw `"`, a label cannot end its own string, so a
 * line either matches one of these two shapes or is a bug in this module.
 */
const HEADER_LINE = /^flowchart (?:LR|TB)$/u;
const NODE_LINE = /^ {2}N\d+\["[^"]*"\]$/u;
const EDGE_LINE = /^ {2}N\d+ (?:-->|-\.->)\|"[^"]*"\| N\d+$/u;

/**
 * Check a compiled source against the allowed templates.
 *
 * Exported because this is the check a test (and the renderer's own guard) can run
 * where Mermaid's parser cannot: it is the same predicate the compiler applies to
 * its own output, so "the compiler emitted only these templates" is one rule
 * written once.
 *
 * Returns human-readable problems rather than throwing, so a caller can report them
 * in the app's own error envelope.
 */
export function assertFlowchartSource(source: string): string[] {
  const issues: string[] = [];
  const lines = source.split('\n');

  if (lines.length === 0 || !HEADER_LINE.test(lines[0] ?? '')) {
    return [`第一行必须是 flowchart LR 或 flowchart TB，实际是「${(lines[0] ?? '').slice(0, 40)}」`];
  }

  const declaredIds = new Set<string>();
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const node = NODE_LINE.exec(line);
    if (node) {
      // The id is everything before the shape bracket. Sliced off the *trimmed*
      // line, so the indentation is not counted as part of the id.
      const trimmed = line.trim();
      declaredIds.add(trimmed.slice(0, trimmed.indexOf('[')));
      continue;
    }
    if (EDGE_LINE.test(line)) continue;
    issues.push(`第 ${index + 1} 行不是允许的节点或边模板：${line.slice(0, 60)}`);
  }

  // An edge naming an undeclared node is the one defect the per-line check cannot
  // see, and it is exactly the shape Mermaid "helpfully" repairs by inventing the
  // missing node — producing a picture of something the material never said.
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!EDGE_LINE.test(line)) continue;
    const ids = line.trim().match(/^N\d+/gu) ?? [];
    const tail = / N\d+$/u.exec(line.trim());
    for (const id of [...ids, ...(tail ? [tail[0].trim()] : [])]) {
      if (!declaredIds.has(id)) {
        issues.push(`第 ${index + 1} 行引用了没有声明的节点 ${id}`);
      }
    }
  }

  return issues;
}

/** The two arrow tokens, exposed so callers can describe the legend in words. */
export const FLOW_LINE_DESCRIPTIONS: Record<'solid' | 'dashed', string> = {
  solid: '实线箭头',
  dashed: '虚线箭头（推测）',
};

/** Guard for the one budget this module can still exceed after validation. */
export const FLOW_COMPILED_LIMITS = {
  nodes: LIMITS.flowNodes,
  edges: LIMITS.flowEdges,
} as const;
