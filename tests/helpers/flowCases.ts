import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Flow model answers as data, read without touching the server (T069-R02, T069-R04).
 *
 * Same split as `tests/helpers/mindmapCases.ts`, and for the same reason: the
 * acceptance spec may not import `src/server/**` (that code is behind
 * `server-only`), so the two things it *can* share with the rest of the suite are
 * the sample set and the substitution that turns the fixture's placeholders into
 * ids a case really created.
 *
 * The samples live in `tests/fixtures/flow-cases.json` and are fed to the real
 * generation route as the model's answer. Nothing here re-implements what the
 * server does with them: `expect` sections are *expectations*, and every one of
 * them is asserted against what the product stored, not against this file.
 */

const CASES_PATH = path.resolve(process.cwd(), 'tests', 'fixtures', 'flow-cases.json');

export interface FlowCaseNode {
  id: string;
  label: string;
  itemIds: string[];
}

export interface FlowCaseEdge {
  source: string;
  target: string;
  kind: string;
  label?: string;
  itemIds: string[];
  relationIds?: string[];
}

/**
 * What a case expects the *stored* view to contain after a valid sample runs.
 *
 * Keeping this beside the answer rather than inside the spec is what stops the two
 * from drifting: the sample that claims to be a causal-with-evidence answer also
 * states which edge kind must survive, so a change to the sample that quietly made
 * it unsupported would be visible in one file.
 */
export interface FlowCaseExpectation {
  edgeKinds: string[];
  /** How many edges the server must report as downgraded causal claims. */
  downgraded: number;
  /** True when the run's warnings must mention the downgrade. */
  warns: boolean;
  /** Labels that must still read as guesses, prefix included, in the output. */
  hypothesisLabels?: string[];
  /** Item ids (placeholder form) the edge/edges must cite. */
  itemIds?: string[];
  /** Evidence basis after server-side certification. */
  basis?: 'relation' | 'material' | 'inference';
}

export interface ValidFlowCase {
  $comment: string;
  title: string;
  direction: 'LR' | 'TB';
  nodes: FlowCaseNode[];
  edges: FlowCaseEdge[];
  expect: FlowCaseExpectation;
}

export interface InvalidFlowCase {
  $comment: string;
  expectMessage: string;
  /** A whole answer that is not JSON at all; used verbatim. */
  raw?: string;
  title?: string;
  direction?: 'LR' | 'TB';
  nodes?: FlowCaseNode[];
  edges?: FlowCaseEdge[];
  /** An extra top-level key a model volunteered (T069-R03). */
  mermaid?: string;
  /** Generate this many nodes in the same shape, for the over-limit sample. */
  $repeatNodes?: number;
}

export interface FlowCaseFile {
  valid: Record<string, ValidFlowCase>;
  invalid: Record<string, InvalidFlowCase>;
}

let cached: FlowCaseFile | null = null;

export function flowCases(): FlowCaseFile {
  if (cached === null) {
    cached = JSON.parse(readFileSync(CASES_PATH, 'utf8')) as FlowCaseFile;
  }
  return cached;
}

/**
 * The slots a sample's placeholders stand for.
 *
 * Ids are never stored in the fixture: a recorded UUID would have to be
 * re-recorded every time a case created its rows, and the first stale one would
 * silently turn a rule assertion into "the model cited a deleted item".
 */
export interface FlowSourceSlots {
  /** Selected sources, substituted for `$A`, `$B`, `$C`. */
  selected: string[];
  /** A real row that exists but was *not* selected (T069-R03「无效来源」). */
  unselected: string;
  /** A real accepted `causes` relation between $A and $B, when the case made one. */
  relation?: string;
}

function substitute(text: string, slots: FlowSourceSlots): string {
  const named = ['$A', '$B', '$C'] as const;
  let result = text;
  named.forEach((token, index) => {
    result = result.split(token).join(slots.selected[index] ?? slots.selected[0]!);
  });
  if (slots.relation !== undefined) result = result.split('$REL').join(slots.relation);
  return result.split('$UNSELECTED').join(slots.unselected);
}

function substituteValue<T>(value: T, slots: FlowSourceSlots): T {
  if (typeof value === 'string') return substitute(value, slots) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((entry) => substituteValue(entry, slots)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = substituteValue(entry, slots);
    }
    return out as unknown as T;
  }
  return value;
}

/** The over-limit sample's body: one node per index, all citing the first source. */
function repeatedNodes(count: number, slots: FlowSourceSlots): FlowCaseNode[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `n${index + 1}`,
    label: `超限节点 ${index + 1}`,
    itemIds: [slots.selected[0]!],
  }));
}

/** The exact bytes to hand the provider for a valid sample. */
export function validAnswerBody(
  name: keyof FlowCaseFile['valid'],
  slots: FlowSourceSlots,
): string {
  const sample = flowCases().valid[name];
  if (!sample) throw new Error(`未知的合法流程样本：${String(name)}`);
  return JSON.stringify(
    substituteValue(
      { title: sample.title, direction: sample.direction, nodes: sample.nodes, edges: sample.edges },
      slots,
    ),
  );
}

/**
 * The exact bytes to hand the provider for a malformed sample.
 *
 * A `raw` sample is returned unchanged: escaping prose into JSON would turn "the
 * model wrote an explanation" into "the model wrote a string field", which is a
 * different failure than the one this sample is about.
 */
export function invalidAnswerBody(
  name: keyof FlowCaseFile['invalid'],
  slots: FlowSourceSlots,
): string {
  const sample = flowCases().invalid[name];
  if (!sample) throw new Error(`未知的非法流程样本：${String(name)}`);
  if (sample.raw !== undefined) return substitute(sample.raw, slots);

  const nodes =
    sample.$repeatNodes !== undefined ? repeatedNodes(sample.$repeatNodes, slots) : (sample.nodes ?? []);
  const body: Record<string, unknown> = {
    title: sample.title,
    direction: sample.direction,
    nodes,
    edges: sample.edges ?? [],
  };
  if (sample.mermaid !== undefined) body.mermaid = sample.mermaid;
  return JSON.stringify(substituteValue(body, slots));
}

/**
 * The expectation for a valid sample, with placeholders resolved.
 *
 * Returned as a value rather than read field-by-field in the spec so the
 * "expected edge kind" statement travels with the answer it describes.
 */
export function validExpectation(
  name: keyof FlowCaseFile['valid'],
  slots: FlowSourceSlots,
): FlowCaseExpectation {
  const sample = flowCases().valid[name];
  if (!sample) throw new Error(`未知的合法流程样本：${String(name)}`);
  return substituteValue(sample.expect, slots);
}

/** The node labels a valid sample declares, resolved — for on-screen assertions. */
export function validLabels(name: keyof FlowCaseFile['valid'], slots: FlowSourceSlots): string[] {
  const sample = flowCases().valid[name];
  if (!sample) throw new Error(`未知的合法流程样本：${String(name)}`);
  return sample.nodes.map((node) => substitute(node.label, slots));
}
