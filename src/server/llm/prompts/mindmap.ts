/**
 * Mindmap prompt (T055).
 *
 * The model's job is bounded: arrange the material the user selected into a
 * topic hierarchy, citing the notes each node rests on. It is not asked to
 * research, to complete a taxonomy, or to produce a fixed number of branches.
 *
 * Two wording decisions carry acceptance cases:
 *   - "input may be short, and a small map is the correct answer" exists because
 *     the failure mode for one selected note is an invented encyclopaedia
 *     (T055-C01);
 *   - every node must cite at least one selected id, and only those ids, because
 *     a topic with no source is a fact the model added to the knowledge base
 *     (T055-C02/C04). The server enforces this afterwards (`compileMindmap`), so
 *     the prompt is guidance while the validator is the authority.
 *
 * The framing (untrusted material, fencing, no tools, JSON only) is shared with
 * the organize prompt rather than re-typed, so both cannot drift apart.
 */
import 'server-only';

import { LIMITS } from '@/domain/limits';
import { MINDMAP_PROMPT_VERSION } from '@/domain/view';
import { composeMessages, excerptMaterial, type MaterialBlock } from './shared';

export { PROMPT_VERSIONS } from './shared';

export { MINDMAP_PROMPT_VERSION };

/**
 * How much of each note reaches the prompt.
 *
 * The whole `rawText` would blow the outbound budget after a handful of notes,
 * and a mindmap needs the *gist* of each note plus enough verbatim text to make
 * a label faithful. These are the same trade-off the organize prompt makes with
 * candidate briefs, applied to the material itself.
 */
export const MINDMAP_LIMITS = {
  /** Per-note verbatim excerpt. */
  excerptCodePoints: 400,
  /** Per-note summary, matching the item schema's own bound. */
  summaryCodePoints: LIMITS.summaryCodePoints,
  /** Fields are dropped, never truncated, to keep the JSON shape honest. */
  knownTagsMax: 40,
} as const;

export interface MindmapSource {
  id: string;
  title: string;
  summary: string;
  tags: readonly string[];
  rawText: string;
  type: string;
}

export interface MindmapPromptInput {
  sources: readonly MindmapSource[];
  /** Optional user instruction; also untrusted. */
  intent?: string;
}

export interface MindmapPrompt {
  messages: ReturnType<typeof composeMessages>;
  /** Code points of everything sent, for the outbound budget check. */
  estimatedCodePoints: number;
}

export function buildMindmapMessages(input: MindmapPromptInput): MindmapPrompt {
  const outputSchema = [
    '{',
    '  "title": "不超过 100 个字符的脑图总标题",',
    '  "nodes": [',
    '    {',
    '      "id": "本视图内部短 id，唯一，例如 m1",',
    '      "parentId": null,',
    '      "label": "不超过 100 个字符的分支标题",',
    '      "itemIds": ["只能来自上面的来源 id"],',
    '      "kind": "group 或 note"',
    '    }',
    '  ]',
    '}',
  ].join('\n');

  const instruction = [
    '你要把用户选中的资料组织成一张主题脑图，输出受限的树形 JSON。',
    '',
    '硬性要求：',
    '1. 只输出一个 JSON 对象，字段只有 title 和 nodes；不要 Markdown、HTML、SVG、链接、脚本或解释。',
    `2. 恰好一个节点的 parentId 为 null（根节点），其他节点都必须连接到这个根；层级从根算第 1 层，最多 ${LIMITS.mindmapMaxDepth} 层。`,
    `3. 节点总数不超过 ${LIMITS.mindmapNodes} 个。内部 id 用短标识（例如 m1、m2），不要用资料 UUID 当节点 id —— 同一条资料可以在不同主题下出现。`,
    '4. kind 为 group 或 note。note 必须引用至少一个真实来源 id。group 的 itemIds 可以省略，由程序从子树 note 归并。每个出现的 itemIds 只能写上面实际给出的来源 id，不能编造。',
    '5. 标签是对材料的忠实概括。可以概括、可以分组，但不能加入材料没有支持的事实、数据、结论或建议。',
    '6. 允许同一条资料出现在多个分支下，那是不同角度的观察，不是重复条目。',
    '7. 材料很短时给一个小脑图（两三个节点也完全正常），不要为了显得完整而扩充空洞分支。',
    '8. 可以用「争议」「待判断」「下一步」这类组织性分组，但不要把互相矛盾的观点强行合并成一个确定结论。',
    '',
    '输出结构：',
    outputSchema,
  ].join('\n');

  const blocks: MaterialBlock[] = [
    {
      label: 'SELECTED ITEMS',
      text: [
        `本次共选中 ${input.sources.length} 条资料。`,
        '所有 itemIds 只能从下面出现的 id 里选择。',
      ].join('\n'),
    },
  ];

  for (const source of input.sources) {
    blocks.push({
      label: `ITEM ${source.id}`,
      text: [
        `id: ${source.id}`,
        `类型: ${source.type}`,
        `标题: ${source.title.trim().length > 0 ? source.title : '（无）'}`,
        `摘要: ${source.summary.trim().length > 0 ? source.summary : '（无）'}`,
        `标签: ${source.tags.length > 0 ? source.tags.join('、') : '（无）'}`,
        '原文片段:',
        excerptMaterial(source.rawText, MINDMAP_LIMITS.excerptCodePoints),
      ].join('\n'),
    });
  }

  return {
    messages: composeMessages({
      instruction,
      blocks,
      ...(input.intent !== undefined && input.intent.trim().length > 0
        ? { intent: input.intent }
        : {}),
    }),
    estimatedCodePoints: estimateMindmapCodePoints(instruction, blocks),
  };
}


/** Code-point total of everything that will be sent, for the budget check. */
export function estimateMindmapCodePoints(
  instruction: string,
  blocks: readonly MaterialBlock[],
): number {
  let total = Array.from(instruction).length;
  // 48 covers a block's fence markers, its label line and the surrounding blank
  // lines. Over-counting slightly is the safe direction: a request just under the
  // real budget is refused locally with a clear message instead of failing at the
  // provider with a context-length error the user cannot act on.
  for (const block of blocks) total += Array.from(block.text).length + 48;
  return total;
}
