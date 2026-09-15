import type { CapturedSources } from '@/server/services/views/captureSources';
import { parseMindmapOutput } from '@/server/services/generateMindmap';

/**
 * Model answers as data, plus the production parser that judges them (T061-R02/R06).
 *
 * T061 asks for two things that pull in opposite directions, and this file is how
 * both are satisfied without either one becoming a lie:
 *
 *  - **`断言服务端阻止`: the malformed answers must be rejected by the real code.**
 *    Re-implementing "is this a cycle" inside a test would prove the test's idea of
 *    a cycle, not the product's. So every sample is fed to the *production* entry
 *    point, `parseMindmapOutput`, which is the same function
 *    `/api/views/mindmap/generate` calls between the provider response and the
 *    commit.
 *
 *  - **`真实模型测试与固定替身测试分别报告` (T061-R06).** This file is the *fixed
 *    stand-in* half. It is not a fake provider and it is not reachable from the
 *    shipped app — it lives under `tests/` and is only ever called by tests. The
 *    real-provider half of T061-C06 is reported separately and stays blocked
 *    without the user's own key.
 *
 * Only the parser seam lives here. The samples and the placeholder substitution are
 * in `mindmapCases.ts`, because the Playwright spec needs them too and cannot import
 * this module — `parseMindmapOutput` pulls in `server-only`, which neither a spec
 * nor a browser bundle may load.
 */
export {
  invalidAnswerBody,
  mindmapCases,
  validAnswerBody,
  type InvalidMindmapCase,
  type MindmapCaseFile,
  type MindmapCaseNode,
  type SourceSlots,
  type ValidMindmapCase,
} from './mindmapCases';

export function runThroughParser(
  body: string,
  captured: CapturedSources,
): ReturnType<typeof parseMindmapOutput> {
  return parseMindmapOutput(body, captured);
}
