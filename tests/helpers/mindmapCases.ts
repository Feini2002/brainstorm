import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Model answers as data, read without touching the server (T061-R02/R06).
 *
 * Split out of `mindmapAnswers.ts` on purpose. That file also exposes
 * `runThroughParser`, which imports the *production* parser, and the parser lives
 * behind `server-only` — so a Playwright spec, which is neither a server nor a
 * client bundle, cannot import it. The acceptance case needs only the two things
 * that are pure data: the sample set and the substitution that turns the fixture's
 * `$A`/`$UNSELECTED` placeholders into ids a case really created.
 *
 * The samples themselves are not re-implemented here. There is one copy, in
 * `tests/fixtures/mindmap-cases.json`, and both this module and the integration
 * tests read it — otherwise "the six malformed shapes" would become two lists that
 * drift.
 */

const CASES_PATH = path.resolve(process.cwd(), 'tests', 'fixtures', 'mindmap-cases.json');

export interface MindmapCaseNode {
  id: string;
  parentId: string | null;
  label: string;
  itemIds: string[];
  kind: 'group' | 'note';
}

export interface ValidMindmapCase {
  $comment: string;
  title: string;
  nodes: MindmapCaseNode[];
}

export interface InvalidMindmapCase {
  $comment: string;
  expectMessage: string;
  /** A tree-shaped answer; absent for a sample that is not JSON at all. */
  title?: string;
  nodes?: MindmapCaseNode[];
  /** A non-JSON answer, used verbatim. */
  raw?: string;
}

export interface MindmapCaseFile {
  valid: Record<string, ValidMindmapCase>;
  invalid: Record<string, InvalidMindmapCase>;
}

let cached: MindmapCaseFile | null = null;

export function mindmapCases(): MindmapCaseFile {
  if (cached === null) {
    cached = JSON.parse(readFileSync(CASES_PATH, 'utf8')) as MindmapCaseFile;
  }
  return cached;
}

/**
 * Placeholders the samples use in place of real ids.
 *
 * The fixture deliberately carries no UUIDs: a stored id would be a fixture that
 * had to be re-recorded every time a case created its rows, and the first stale
 * one would silently test "the model cited a deleted item" instead of the rule the
 * case is about.
 */
export interface SourceSlots {
  /** Selected sources, substituted for `$A`, `$B`, `$C`. */
  selected: string[];
  /** A real row that exists but was *not* selected (T061-R02「无效ID」). */
  unselected: string;
}

function substitute(text: string, slots: SourceSlots): string {
  const named = ['$A', '$B', '$C'] as const;
  let result = text;
  named.forEach((token, index) => {
    result = result.split(token).join(slots.selected[index] ?? slots.selected[0]!);
  });
  return result.split('$UNSELECTED').join(slots.unselected);
}

/** Deep-substitute every string in a sample, so labels and ids both resolve. */
function substituteValue<T>(value: T, slots: SourceSlots): T {
  if (typeof value === 'string') return substitute(value, slots) as unknown as T;
  if (Array.isArray(value)) return value.map((entry) => substituteValue(entry, slots)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = substituteValue(entry, slots);
    }
    return out as unknown as T;
  }
  return value;
}

/** The exact bytes to hand the parser for a valid sample. */
export function validAnswerBody(name: keyof MindmapCaseFile['valid'], slots: SourceSlots): string {
  const sample = mindmapCases().valid[name];
  if (!sample) throw new Error(`未知的合法样本：${String(name)}`);
  return JSON.stringify(substituteValue({ title: sample.title, nodes: sample.nodes }, slots));
}

/**
 * The exact bytes to hand the parser for a malformed sample.
 *
 * A `raw` sample is returned unchanged: escaping it into JSON would turn "the model
 * wrote prose" into "the model wrote a string field", which is a different failure
 * than the one T061-R03 is about.
 */
export function invalidAnswerBody(
  name: keyof MindmapCaseFile['invalid'],
  slots: SourceSlots,
): string {
  const sample = mindmapCases().invalid[name];
  if (!sample) throw new Error(`未知的非法样本：${String(name)}`);
  if (sample.raw !== undefined) return substitute(sample.raw, slots);
  return JSON.stringify(substituteValue({ title: sample.title, nodes: sample.nodes }, slots));
}
