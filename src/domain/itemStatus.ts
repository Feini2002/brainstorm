/**
 * Item status semantics (T038).
 *
 * `deriveItemStatus` lives in `domain/knowledge.ts` so that the repository, the
 * services and any test share *one* rule; this module is the thin, explicitly
 * named domain surface for "what status means", and exists so callers do not
 * re-derive it from raw fields.
 *
 * The priority order is the contract's and must not be reordered casually:
 * an unexpired running organize run wins over everything, because showing
 * "已整理" while a paid call is in flight would be a lie; `stale` beats `done`,
 * because the structured fields no longer describe the current raw text.
 */
import { deriveItemStatus, type ItemStatus } from './knowledge';

export { deriveItemStatus };
export type { ItemStatus };

/** Statuses that mean "the structured fields describe the current raw text". */
export const STRUCTURED_OK_STATUSES: readonly ItemStatus[] = ['done', 'stale'];

/** Statuses that invite the user to try again; used for copy, not for logic. */
export const RETRYABLE_STATUSES: readonly ItemStatus[] = ['error'];

export function isProcessing(status: ItemStatus): boolean {
  return status === 'processing';
}

/**
 * Whether the item's structured fields are usable as-is.
 *
 * A `stale` item still has usable content — it is flagged as out of date rather
 * than discarded — so projections may render it with a warning. Only `raw`,
 * `processing` and `error` need the UI to say "no organized result yet".
 */
export function hasUsableStructure(status: ItemStatus): boolean {
  return status === 'done' || status === 'stale';
}

export function statusLabelSuffix(status: ItemStatus): string | null {
  switch (status) {
    case 'processing':
      return '整理进行中，可以先去忙别的';
    case 'error':
      return '上次整理没有成功，原文仍然保留';
    case 'stale':
      return '原文改过，当前整理结果基于旧版本';
    default:
      return null;
  }
}
