/**
 * Organize prompt (T033).
 *
 * The model's job is bounded on purpose: compress, label, and suggest relations
 * that can be traced to quoted text. It is not asked to write an article, not
 * asked to produce a fixed number of relations, and not asked to invent tags.
 *
 * Three consequences of the wording, each tied to an acceptance case:
 *   - hedging is preserved ("可能", "有人认为", "尚未验证" stay hedged), because a
 *     summary that turns a possibility into a fact corrupts the knowledge base
 *     more than a vague summary does (T033-C02);
 *   - the user's own stance is never inferred: a note recording someone else's
 *     view is summarized as that view, not as the user's belief (T033-C03);
 *   - a one-word note yields a conservative concept label, not an invented
 *     position (T033-C04), and zero relations is explicitly a valid answer
 *     (T033-C05).
 */
import 'server-only';

import {
  ITEM_TYPE_LABELS,
  ITEM_TYPES,
  RELATION_TYPE_LABELS,
  RELATION_TYPES,
} from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import { composeMessages, type MaterialBlock } from './shared';

export { PROMPT_VERSIONS } from './shared';

/** The relation vocabulary, with the distinction that keeps types from blurring. */
const RELATION_GUIDE = [
  'similar_to：两段内容在主要意思上相似。',
  'extends：A 在 B 的基础上增加条件、范围或解释。',
  'supports：A 为 B 提供理由或例证。',
  'contradicts：针对相同条件或主张出现不一致。',
  'causes：A 引起 B（先后发生不算）。',
  'depends_on：A 的成立或实施依赖 B（同属一个话题不算）。',
  'example_of：A 是 B 的具体例子。',
  'related_to：主题上有明确联系，但不足以归入上面几种。',
].join('\n');

const ITEM_TYPE_GUIDE = ITEM_TYPES.map((type) => `${type}（${ITEM_TYPE_LABELS[type]}）`).join('、');
const RELATION_TYPE_GUIDE = RELATION_TYPES.map(
  (type) => `${type}（${RELATION_TYPE_LABELS[type]}）`,
).join('、');

export interface OrganizeCandidate {
  id: string;
  title: string;
  summary: string;
  tags: readonly string[];
  /** Literal snippets from the candidate's own rawText, already budgeted. */
  evidence: readonly string[];
}

export interface OrganizePromptInput {
  /** The item being organized; its id is required so quotes can cite it. */
  targetId: string;
  rawText: string;
  title: string;
  keywords: readonly string[];
  tags: readonly string[];
  /** A slice of the existing tag dictionary — never the whole library. */
  knownTags: readonly string[];
  /** Bounded candidate briefs, already truncated by the retrieval layer. */
  candidates: readonly OrganizeCandidate[];
  /** Reasons retrieval returned nothing, used for an honest prompt message. */
  noCandidatesReason?: string;
}

export interface OrganizePrompt {
  messages: ReturnType<typeof composeMessages>;
  /** Code points of everything sent, for the outbound budget check. */
  estimatedCodePoints: number;
}

export function buildOrganizeMessages(input: OrganizePromptInput): OrganizePrompt {
  const outputSchema = [
    '{',
    '  "title": "不超过 50 个字符的短标题；原文只有一个词时就用这个词本身",',
    '  "summary": "不超过 200 个字符的概括",',
    `  "type": "必须从这些里选一个：${ITEM_TYPE_GUIDE}",`,
    '  "tags": ["0 到 8 个标签，优先复用给定词表中的写法"],',
    '  "keywords": ["0 到 10 个关键词"],',
    '  "importance": 1,',
    '  "relations": [',
    '    {',
    '      "targetId": "候选列表里出现过的 id",',
    `      "type": "必须从这些里选一个：${RELATION_TYPE_GUIDE}",`,
    '      "reason": "不超过 300 个字符，说明为什么是这种关系",',
    '      "score": 0.0,',
    '      "evidence": [',
    `        { "itemId": "${input.targetId}", "quote": "原文中的连续片段" },`,
    '        { "itemId": "候选 id", "quote": "该候选片段中的连续文字" }',
    '      ]',
    '    }',
    '  ]',
    '}',
  ].join('\n');

  const instruction = [
    '你要把用户保存的一条资料整理成结构化字段，并判断它和已有资料之间是否有依据的关系。',
    '',
    '硬性要求：',
    '1. 只输出一个 JSON 对象，不要 Markdown、不要解释、不要额外字段。',
    '2. 字段必须齐全：title、summary、type、tags、keywords、importance、relations。',
    '3. 保真：保留原文里的可能性与限定。原文写“可能”“也许”“有人认为”“尚未验证”，摘要必须保持这种不确定，不能改写成已经确定的事实。',
    '4. 归属：原文记录的是别人的观点、引述或问题，就照此归纳，不要写成用户本人认同的结论。',
    '5. 克制：只根据原文实际写到的内容概括，不补充原文没有的背景、数据、结论或建议。原文很短时给保守的标题和简短说明即可，不要扩写成文章。',
    '6. 类型：选最贴近的 item type；拿不准时用 idea（想法）。',
    '7. 标签：tags 优先从下面给出的已有标签词表里选相同的写法；需要新标签时用简短名词，最多 8 个。',
    '8. 关系：可以一条都不给，relations 为空数组是完全正常的答案。不要为了凑数建立关系。',
    '9. 证据：每条关系必须给出两段逐字引用，一段来自原文，一段来自对应候选的片段。引用必须与给出的文字完全一致，不能改写、不能拼接、不能跨段拼合。',
    '10. 只引用下方实际给出的文字，不要引用没出现过的内容，也不要引用其他资料的整篇原文。',
    '',
    '关系类型与含义：',
    RELATION_GUIDE,
    '',
    '输出结构：',
    outputSchema,
  ].join('\n');

  const blocks: MaterialBlock[] = [
    {
      label: 'TARGET ITEM',
      text: [
        `id: ${input.targetId}`,
        `当前标题: ${input.title.trim().length > 0 ? input.title : '（无）'}`,
        `当前关键词: ${input.keywords.length > 0 ? input.keywords.join('、') : '（无）'}`,
        `当前标签: ${input.tags.length > 0 ? input.tags.join('、') : '（无）'}`,
        '原文:',
        input.rawText,
      ].join('\n'),
    },
  ];

  if (input.knownTags.length > 0) {
    blocks.push({
      label: 'EXISTING TAG DICTIONARY',
      text: `（这是现有标签，能复用就复用）${input.knownTags.join('、')}`,
    });
  }

  if (input.candidates.length === 0) {
    blocks.push({
      label: 'CANDIDATE ITEMS',
      text:
        input.noCandidatesReason ??
        '（这次没有可比较的候选资料。relations 必须是空数组。）',
    });
  } else {
    for (const candidate of input.candidates) {
      blocks.push({
        label: `CANDIDATE ${candidate.id}`,
        text: [
          `id: ${candidate.id}`,
          `title: ${candidate.title}`,
          `summary: ${candidate.summary}`,
          `tags: ${candidate.tags.join('、')}`,
          '片段:',
          ...(candidate.evidence.length > 0
            ? candidate.evidence.map((snippet) => `- ${snippet}`)
            : ['（无匹配片段）']),
        ].join('\n'),
      });
    }
  }

  return {
    messages: composeMessages({ instruction, blocks }),
    estimatedCodePoints: estimateCodePoints(instruction, blocks),
  };
}

/** Code-point total of everything that will be sent, for the budget check. */
export function estimateCodePoints(
  instruction: string,
  blocks: readonly MaterialBlock[],
): number {
  let total = Array.from(instruction).length;
  for (const block of blocks) total += Array.from(block.text).length + 40;
  return total;
}

export const ORGANIZE_LIMITS = {
  titleCodePoints: 50,
  summaryCodePoints: 200,
  reasonCodePoints: LIMITS.relationReasonCodePoints,
  relationsMax: LIMITS.relationsPerOrganize,
  knownTagsMax: 60,
} as const;
