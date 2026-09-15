/**
 * Item field merge and manual-field protection.
 *
 * Rules (docs/03_contracts/01_data_contract.md §2, 03_dto_and_version_rules.md §3):
 *  - manualFields only ever contains title/summary/type/tags/keywords/importance.
 *  - A user edit locks the fields the user actually changed.
 *  - AI organize may only write fields that are NOT locked.
 *  - Unlocking a field is an explicit user action; it also bumps revision.
 */
import {
  MANUAL_FIELDS,
  isStructuredStale,
  type ItemDTO,
  type ManualField,
} from './knowledge';
import { LIMITS } from './limits';
import { codePointLength, hasVisibleContent } from './text';
import { normalizeKeywordList, normalizeTagList } from './tags';

export interface UserPatch {
  rawText?: string;
  title?: string;
  summary?: string;
  type?: ItemDTO['type'];
  tags?: string[];
  keywords?: string[];
  importance?: number;
  sourceType?: ItemDTO['sourceType'];
  sourceRef?: string | null;
}

const MANUAL_FIELD_SET = new Set<string>(MANUAL_FIELDS);

export function isManualField(value: string): value is ManualField {
  return MANUAL_FIELD_SET.has(value);
}

/** Validate a field name list coming from a request body. */
export function parseManualFields(values: readonly string[]): ManualField[] {
  const result: ManualField[] = [];
  for (const value of values) {
    if (!isManualField(value)) {
      throw new Error(`unknown manual field: ${value}`);
    }
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

/** Fields whose *content* differs between two item snapshots. */
export function changedManualFields(current: ItemDTO, patch: UserPatch): ManualField[] {
  const changed: ManualField[] = [];

  if (patch.title !== undefined && patch.title !== current.title) changed.push('title');
  if (patch.summary !== undefined && patch.summary !== current.summary) changed.push('summary');
  if (patch.type !== undefined && patch.type !== current.type) changed.push('type');
  if (patch.importance !== undefined && patch.importance !== current.importance) {
    changed.push('importance');
  }
  if (patch.tags !== undefined && !sameStringSet(patch.tags, current.tags)) changed.push('tags');
  if (patch.keywords !== undefined && !sameStringSet(patch.keywords, current.keywords)) {
    changed.push('keywords');
  }

  return changed;
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const value of setA) {
    if (!setB.has(value)) return false;
  }
  return true;
}

/** True when the patch would not change any domain field (a no-op PATCH). */
export function isNoOpPatch(current: ItemDTO, patch: UserPatch): boolean {
  if (patch.rawText !== undefined && patch.rawText !== current.rawText) return false;
  if (changedManualFields(current, patch).length > 0) return false;
  if (patch.sourceType !== undefined && patch.sourceType !== current.sourceType) return false;
  if (patch.sourceRef !== undefined && patch.sourceRef !== current.sourceRef) return false;
  return true;
}

export interface ValidateFieldIssues {
  fieldErrors: Record<string, string[]>;
}

/** Validate user-supplied field values against contract limits. */
export function validateUserPatch(patch: UserPatch): ValidateFieldIssues {
  const fieldErrors: Record<string, string[]> = {};

  if (patch.rawText !== undefined) {
    if (!hasVisibleContent(patch.rawText)) {
      fieldErrors.rawText = ['原文不能为空'];
    } else if (codePointLength(patch.rawText) > LIMITS.rawTextCodePoints) {
      fieldErrors.rawText = [`原文不能超过 ${LIMITS.rawTextCodePoints} 个字符`];
    }
  }

  if (patch.title !== undefined && codePointLength(patch.title) > LIMITS.titleCodePoints) {
    fieldErrors.title = [`标题不能超过 ${LIMITS.titleCodePoints} 个字符`];
  }

  if (patch.summary !== undefined && codePointLength(patch.summary) > LIMITS.summaryCodePoints) {
    fieldErrors.summary = [`摘要不能超过 ${LIMITS.summaryCodePoints} 个字符`];
  }

  if (patch.importance !== undefined) {
    if (
      !Number.isInteger(patch.importance) ||
      patch.importance < LIMITS.importanceMin ||
      patch.importance > LIMITS.importanceMax
    ) {
      fieldErrors.importance = ['重要性必须是 1 到 5 的整数'];
    }
  }

  // The raw array has a hard ceiling so a million duplicates cannot be processed
  // at all, and the ceiling that matters is the number of *effective* tags after
  // normalization (docs/03_contracts/03_dto_and_version_rules.md §2). Accepting a
  // ninth distinct tag and quietly storing eight would lose the user's input
  // without saying so (T017-C03 「不能静默丢最后一个」).
  if (patch.tags !== undefined) {
    if (patch.tags.length > LIMITS.tagsPerItem * 4) {
      fieldErrors.tags = ['标签数量超过上限'];
    } else {
      const { labels, droppedOverLimit } = normalizeTagList(patch.tags);
      if (droppedOverLimit > 0) {
        fieldErrors.tags = [
          `一次最多 ${LIMITS.tagsPerItem} 个标签，当前有 ${
            labels.length + droppedOverLimit
          } 个，请减少 ${droppedOverLimit} 个`,
        ];
      }
    }
  }

  if (patch.keywords !== undefined) {
    if (patch.keywords.length > LIMITS.keywordsPerItem * 4) {
      fieldErrors.keywords = ['关键词数量超过上限'];
    } else {
      const { keywords, droppedOverLimit } = normalizeKeywordList(patch.keywords);
      if (droppedOverLimit > 0) {
        fieldErrors.keywords = [
          `一次最多 ${LIMITS.keywordsPerItem} 个关键词，当前有 ${
            keywords.length + droppedOverLimit
          } 个，请减少 ${droppedOverLimit} 个`,
        ];
      }
    }
  }

  if (
    patch.sourceRef !== undefined &&
    patch.sourceRef !== null &&
    codePointLength(patch.sourceRef) > LIMITS.sourceRefCodePoints
  ) {
    fieldErrors.sourceRef = [`来源不能超过 ${LIMITS.sourceRefCodePoints} 个字符`];
  }

  return { fieldErrors };
}

/**
 * Merge AI-organized values onto an item, skipping locked fields.
 * Returns the merged field values plus which ones were actually applied.
 */
export interface OrganizeFieldValues {
  title: string;
  summary: string;
  type: ItemDTO['type'];
  tags: string[];
  keywords: string[];
  importance: number;
}

export interface MergeResult {
  values: OrganizeFieldValues;
  applied: ManualField[];
  skipped: ManualField[];
}

export function mergeOrganizedFields(
  current: ItemDTO,
  incoming: OrganizeFieldValues,
): MergeResult {
  const locked = new Set(current.manualFields);
  const applied: ManualField[] = [];
  const skipped: ManualField[] = [];

  const values: OrganizeFieldValues = {
    title: current.title,
    summary: current.summary,
    type: current.type,
    tags: [...current.tags],
    keywords: [...current.keywords],
    importance: current.importance,
  };

  const tryApply = (field: ManualField, assign: () => void) => {
    if (locked.has(field)) {
      skipped.push(field);
      return;
    }
    assign();
    applied.push(field);
  };

  tryApply('title', () => {
    values.title = incoming.title;
  });
  tryApply('summary', () => {
    values.summary = incoming.summary;
  });
  tryApply('type', () => {
    values.type = incoming.type;
  });
  tryApply('tags', () => {
    values.tags = [...incoming.tags];
  });
  tryApply('keywords', () => {
    values.keywords = [...incoming.keywords];
  });
  tryApply('importance', () => {
    values.importance = incoming.importance;
  });

  return { values, applied, skipped };
}

/**
 * Locked fields that already match the current raw version mean a re-organize
 * can be a domain no-op. Reported to the user as "未覆盖任何字段".
 */
export function isStructuredFullyLocked(current: ItemDTO): boolean {
  const locked = new Set(current.manualFields);
  return MANUAL_FIELDS.every((field) => locked.has(field));
}

export function structuredStaleFlag(item: ItemDTO): boolean {
  return isStructuredStale(item.structuredBaseRawVersion, item.rawVersion);
}
