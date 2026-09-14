/**
 * Manual-field rules (T019).
 *
 * The implementation lives in `itemFields.ts`, which also holds the AI-merge
 * rules that share the same `MANUAL_FIELDS` set. This module is the stable
 * import path for the manual-edit contract, so a future split of the merge
 * logic does not move the type the edit form depends on.
 */
export {
  changedManualFields,
  isManualField,
  isNoOpPatch,
  isStructuredFullyLocked,
  parseManualFields,
  structuredStaleFlag,
  validateUserPatch,
  type UserPatch,
  type ValidateFieldIssues,
} from './itemFields';

import { MANUAL_FIELDS, type ManualField } from './knowledge';

/** Labels for the manual-field lock UI. */
export const MANUAL_FIELD_LABELS: Record<ManualField, string> = {
  title: '标题',
  summary: '摘要',
  type: '类型',
  tags: '标签',
  keywords: '关键词',
  importance: '重要度',
};

/** True when the field set covers every lockable field. */
export function allFieldsLocked(fields: readonly ManualField[]): boolean {
  const locked = new Set(fields);
  return MANUAL_FIELDS.every((field) => locked.has(field));
}
