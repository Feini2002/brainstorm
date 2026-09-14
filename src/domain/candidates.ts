/**
 * Candidate retrieval v1 (no embeddings).
 *
 * Two channels, merged and deduplicated by Item.id:
 *   - recency:  the 12 most recent other items, so new material always meets
 *   - lexical:  literal LIKE matches over title / summary / rawText / tags
 *
 * Chinese is matched by normalized substring and limited adjacent bigrams; this
 * is a literal-recall design, never advertised as semantic search
 * (docs/03_contracts/07_candidate_retrieval.md).
 */
import { LIMITS } from './limits';
import { normalizeTag } from './tags';
import { codePointLength, truncateCodePoints } from './text';

export const RETRIEVAL_VERSION = 'lexical-v1';

/** Versioned stop list; the model never alters it at runtime. */
export const STOP_FRAGMENTS: readonly string[] = [
  '的是', '一个', '我们', '你们', '他们', '这个', '那个', '可以', '因为', '所以',
  '但是', '如果', '还是', '就是', '没有', '什么', '怎么', '已经', '以及', '或者',
  '并且', '而且', '不是', '这些', '那些', '自己', '对于', '关于', '通过', '需要',
  '可能', '应该', '一定', '为了', '由于', '然后', '现在', '时候', '已经',
];

export interface QueryTerms {
  /** Full normalized tag phrases, highest confidence. */
  phrases: string[];
  /** Latin/digit words of length 2..40. */
  words: string[];
  /** Chinese adjacent bigrams of length 2. */
  bigrams: string[];
}

const MAX_TAG_PHRASES = 12;
const MAX_WORDS = LIMITS.wordTermsMax;
const MAX_BIGRAMS = LIMITS.substringTermsMax;

const CJK_RANGE = /[\u3400-\u4DBF\u4E00-\u9FFF]/u;
const LATIN_WORD = /[A-Za-z0-9]/;

export interface QueryTermInput {
  title: string;
  keywords: readonly string[];
  tags: readonly string[];
  rawText: string;
}

/**
 * Build the literal query terms. Returns empty lists when the item is too short
 * to produce meaningful terms — the caller then falls back to the recency
 * channel only, rather than inventing terms.
 */
export function buildQueryTerms(input: QueryTermInput): QueryTerms {
  const phrases: string[] = [];
  const phraseKeys = new Set<string>();

  for (const tag of input.tags) {
    const key = normalizeTag(tag);
    if (key.length === 0 || phraseKeys.has(key)) continue;
    if (phrases.length >= MAX_TAG_PHRASES) break;
    phraseKeys.add(key);
    phrases.push(key);
  }

  for (const keyword of input.keywords) {
    const key = normalizeTag(keyword);
    if (key.length < 2 || phraseKeys.has(key)) continue;
    if (phrases.length >= MAX_TAG_PHRASES) break;
    phraseKeys.add(key);
    phrases.push(key);
  }

  const haystack = `${input.title}\n${input.rawText}`;
  const normalizedHaystack = haystack.normalize('NFKC');

  const words: string[] = [];
  const wordSet = new Set<string>();
  let current = '';
  for (const char of normalizedHaystack) {
    if (LATIN_WORD.test(char)) {
      current += char.toLowerCase();
      continue;
    }
    if (current.length >= 2 && current.length <= 40 && !wordSet.has(current)) {
      wordSet.add(current);
      if (words.length < MAX_WORDS) words.push(current);
    }
    current = '';
  }
  if (current.length >= 2 && current.length <= 40 && !wordSet.has(current) && words.length < MAX_WORDS) {
    words.push(current);
  }

  const bigrams: string[] = [];
  const bigramSet = new Set<string>();
  const stopSet = new Set(STOP_FRAGMENTS);
  let cjkRun = '';
  const flushRun = () => {
    if (cjkRun.length >= 2) {
      for (let index = 0; index + 2 <= cjkRun.length; index += 1) {
        const bigram = cjkRun.slice(index, index + 2);
        if (stopSet.has(bigram)) continue;
        if (bigramSet.has(bigram)) continue;
        if (bigrams.length >= MAX_BIGRAMS) return;
        bigramSet.add(bigram);
        bigrams.push(bigram);
      }
    }
    cjkRun = '';
  };

  // Only the first 2000 code points of rawText are mined for terms.
  const termSource = truncateCodePoints(
    `${input.title}\n${input.rawText}`.normalize('NFKC'),
    2000,
  );
  for (const char of termSource) {
    if (CJK_RANGE.test(char)) {
      cjkRun += char;
      continue;
    }
    flushRun();
  }
  flushRun();

  return { phrases, words, bigrams };
}

/** All terms in priority order: complete tag phrases, then words, then bigrams. */
export function orderedTerms(terms: QueryTerms): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const term of [...terms.phrases, ...terms.words, ...terms.bigrams]) {
    if (term.length === 0 || seen.has(term)) continue;
    seen.add(term);
    if (result.length >= LIMITS.queryTermsMax) break;
    result.push(term);
  }
  return result;
}

export interface ScoredCandidate {
  id: string;
  score: number;
  updatedAt: string;
}

export interface CandidateScoreBreakdown {
  tagHits: number;
  keywordTitleHits: number;
  summaryHits: number;
  bigramHits: number;
  rawTextHits: number;
}

/**
 * Deterministic engineering score (not a probability). Each channel is capped
 * so one repeated tag cannot dominate; ties break on updatedAt then id.
 */
export function scoreCandidate(input: {
  terms: QueryTerms;
  tags: readonly string[];
  title: string;
  summary: string;
  rawText: string;
}): { score: number; breakdown: CandidateScoreBreakdown } {
  const normalizedTags = new Set(input.tags.map((tag) => normalizeTag(tag)));
  const normalizedTitle = input.title.normalize('NFKC').toLowerCase();
  const normalizedSummary = input.summary.normalize('NFKC').toLowerCase();
  const normalizedRaw = input.rawText.normalize('NFKC').toLowerCase();

  let tagHits = 0;
  for (const phrase of input.terms.phrases) {
    if (normalizedTags.has(phrase)) tagHits += 8;
  }
  tagHits = Math.min(tagHits, 24);

  let keywordTitleHits = 0;
  for (const phrase of input.terms.phrases) {
    if (normalizedTitle.includes(phrase)) keywordTitleHits += 4;
  }
  keywordTitleHits = Math.min(keywordTitleHits, 20);

  let summaryHits = 0;
  for (const word of input.terms.words) {
    if (normalizedSummary.includes(word)) summaryHits += 2;
  }
  summaryHits = Math.min(summaryHits, 12);

  let bigramHits = 0;
  for (const bigram of input.terms.bigrams) {
    if (
      normalizedRaw.includes(bigram) ||
      normalizedTitle.includes(bigram) ||
      normalizedSummary.includes(bigram)
    ) {
      bigramHits += 1;
    }
  }
  bigramHits = Math.min(bigramHits, 6);

  let rawTextHits = 0;
  for (const word of input.terms.words) {
    if (normalizedRaw.includes(word)) rawTextHits += 1;
  }
  rawTextHits = Math.min(rawTextHits, 6);

  const breakdown: CandidateScoreBreakdown = {
    tagHits,
    keywordTitleHits,
    summaryHits,
    bigramHits,
    rawTextHits,
  };

  return {
    score: tagHits + keywordTitleHits + summaryHits + bigramHits + rawTextHits,
    breakdown,
  };
}

export interface EvidenceSnippet {
  text: string;
  startOffset: number;
}

/**
 * Literal snippets from the target's own rawText. Never a paraphrase: the model
 * may only quote strings it actually received.
 */
export function extractEvidenceSnippets(
  rawText: string,
  terms: readonly string[],
  maxSnippets = 2,
  maxCodePoints = 45,
): EvidenceSnippet[] {
  const normalizedRaw = rawText.normalize('NFKC').toLowerCase();
  const snippets: EvidenceSnippet[] = [];
  const usedRanges: { start: number; end: number }[] = [];

  for (const term of terms) {
    if (snippets.length >= maxSnippets) break;
    if (term.length === 0) continue;
    const haystack = normalizedRaw;
    const index = haystack.indexOf(term);
    if (index < 0) continue;

    const half = Math.floor(maxCodePoints / 2);
    const startCodePoint = Math.max(0, mapIndexToCodePoint(rawText, index) - half);
    const text = truncateCodePoints(
      Array.from(rawText).slice(startCodePoint, startCodePoint + maxCodePoints).join(''),
      maxCodePoints,
    );
    const overlaps = usedRanges.some(
      (range) => startCodePoint < range.end && startCodePoint + maxCodePoints > range.start,
    );
    if (overlaps) continue;
    usedRanges.push({ start: startCodePoint, end: startCodePoint + maxCodePoints });
    snippets.push({ text: text.trim(), startOffset: startCodePoint });
  }

  if (snippets.length === 0 && rawText.length > 0) {
    // No literal hit: offer the opening text, which is still the original text
    // and is explicitly allowed when there is no match.
    const text = truncateCodePoints(rawText, maxCodePoints).trim();
    if (text.length > 0) snippets.push({ text, startOffset: 0 });
  }

  return snippets.slice(0, maxSnippets);
}

/** Map a UTF-16 index into a code point index for the same string. */
function mapIndexToCodePoint(text: string, utf16Index: number): number {
  return Array.from(text.slice(0, utf16Index)).length;
}

export interface CandidateBriefInput {
  id: string;
  title: string;
  summary: string;
  tags: readonly string[];
  rawText: string;
  updatedAt: string;
}

export interface CandidateBrief {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  evidenceSnippets: EvidenceSnippet[];
  retrievalReason: string;
  score: number;
  updatedAt: string;
}

/** Per-candidate text budget (docs/03_contracts/07_candidate_retrieval.md §4). */
export const CANDIDATE_BRIEF_BUDGET = {
  title: LIMITS.candidateBriefTitleCodePoints,
  summary: LIMITS.candidateBriefSummaryCodePoints,
  tags: LIMITS.candidateBriefTagsCodePoints,
  evidence: LIMITS.candidateBriefEvidenceCodePoints,
} as const;

export function buildCandidateBrief(
  candidate: CandidateBriefInput,
  terms: QueryTerms,
  reason: string,
): CandidateBrief {
  const { score } = scoreCandidate({
    terms,
    tags: candidate.tags,
    title: candidate.title,
    summary: candidate.summary,
    rawText: candidate.rawText,
  });

  const ordered = orderedTerms(terms);
  const evidenceSnippets = extractEvidenceSnippets(candidate.rawText, ordered);

  let tagBudget = CANDIDATE_BRIEF_BUDGET.tags;
  const tags: string[] = [];
  for (const tag of candidate.tags) {
    const length = codePointLength(tag);
    if (length > tagBudget) break;
    tags.push(tag);
    tagBudget -= length;
  }

  return {
    id: candidate.id,
    title: truncateCodePoints(candidate.title, CANDIDATE_BRIEF_BUDGET.title),
    summary: truncateCodePoints(candidate.summary, CANDIDATE_BRIEF_BUDGET.summary),
    tags,
    evidenceSnippets: evidenceSnippets.map((snippet) => ({
      text: truncateCodePoints(snippet.text, 45),
      startOffset: snippet.startOffset,
    })),
    retrievalReason: reason,
    score,
    updatedAt: candidate.updatedAt,
  };
}

/** Stable ordering: recency channel first, then lexical rank, then updatedAt/id. */
export function sortCandidates(
  candidates: readonly ScoredCandidate[],
  recentIds: readonly string[],
): ScoredCandidate[] {
  const recentRank = new Map<string, number>();
  recentIds.forEach((id, index) => recentRank.set(id, index));

  return [...candidates].sort((a, b) => {
    const recentA = recentRank.get(a.id);
    const recentB = recentRank.get(b.id);
    if (recentA !== undefined && recentB !== undefined) return recentA - recentB;
    if (recentA !== undefined) return -1;
    if (recentB !== undefined) return 1;
    if (b.score !== a.score) return b.score - a.score;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Escape `%`, `_` and the escape char itself for a LIKE literal match. */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/gu, (char) => `\\${char}`);
}
