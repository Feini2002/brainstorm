/**
 * Tag identity and normalization.
 *
 * The authoritative store is `tags` + `item_tags`; ItemDTO.tags is a projection.
 * Normalization uses NFKC + lowercase + whitespace collapsing to build the match
 * key. Original note text is never normalized.
 */
import { LIMITS } from './limits';
import { codePointLength } from './text';
import { collapseWhitespace } from './text';

/** Match key for a tag label. Two labels with the same key are the same tag. */
export function normalizeTag(label: string): string {
  return collapseWhitespace(label.normalize('NFKC')).toLocaleLowerCase('en-US');
}

export interface NormalizedTagList {
  /** Display labels, deduplicated by normalized key, original order preserved. */
  labels: string[];
  /** Parallel normalized keys, same order as `labels`. */
  keys: string[];
}

export interface TagNormalizationResult extends NormalizedTagList {
  /** Items dropped because they were empty after normalization. */
  droppedEmpty: number;
  /** Items dropped because they exceeded `tagCodePoints`. */
  droppedTooLong: number;
  /** Items dropped because they collided with an earlier normalized key. */
  droppedDuplicate: number;
  /** Items dropped because the list exceeded `tagsPerItem` after normalization. */
  droppedOverLimit: number;
}

/**
 * Normalize an incoming tag list.
 *
 * The raw array must already respect the contract's hard cap of 4x the final
 * limit (rejected upstream), so this function only dedupes and truncates.
 */
export function normalizeTagList(input: readonly string[]): TagNormalizationResult {
  const labels: string[] = [];
  const keys: string[] = [];
  const seen = new Set<string>();
  let droppedEmpty = 0;
  let droppedTooLong = 0;
  let droppedDuplicate = 0;
  let droppedOverLimit = 0;

  for (const raw of input) {
    const label = collapseWhitespace(raw);
    if (label.length === 0) {
      droppedEmpty += 1;
      continue;
    }
    if (codePointLength(label) > LIMITS.tagCodePoints) {
      droppedTooLong += 1;
      continue;
    }
    const key = normalizeTag(label);
    if (key.length === 0) {
      droppedEmpty += 1;
      continue;
    }
    if (seen.has(key)) {
      droppedDuplicate += 1;
      continue;
    }
    if (labels.length >= LIMITS.tagsPerItem) {
      droppedOverLimit += 1;
      continue;
    }
    seen.add(key);
    labels.push(label);
    keys.push(key);
  }

  return { labels, keys, droppedEmpty, droppedTooLong, droppedDuplicate, droppedOverLimit };
}

/** Normalize a keyword list with the same dedupe rules as tags. */
export function normalizeKeywordList(input: readonly string[]): {
  keywords: string[];
  droppedEmpty: number;
  droppedTooLong: number;
  droppedDuplicate: number;
  droppedOverLimit: number;
} {
  const keywords: string[] = [];
  const seen = new Set<string>();
  let droppedEmpty = 0;
  let droppedTooLong = 0;
  let droppedDuplicate = 0;
  let droppedOverLimit = 0;

  for (const raw of input) {
    const keyword = collapseWhitespace(raw);
    if (keyword.length === 0) {
      droppedEmpty += 1;
      continue;
    }
    if (codePointLength(keyword) > LIMITS.keywordCodePoints) {
      droppedTooLong += 1;
      continue;
    }
    const key = normalizeTag(keyword);
    if (seen.has(key)) {
      droppedDuplicate += 1;
      continue;
    }
    if (keywords.length >= LIMITS.keywordsPerItem) {
      droppedOverLimit += 1;
      continue;
    }
    seen.add(key);
    keywords.push(keyword);
  }

  return { keywords, droppedEmpty, droppedTooLong, droppedDuplicate, droppedOverLimit };
}

/** Hard cap for raw incoming arrays before normalization (4x final limit). */
export const RAW_TAG_ARRAY_MAX = LIMITS.tagsPerItem * 4;
export const RAW_KEYWORD_ARRAY_MAX = LIMITS.keywordsPerItem * 4;
