/**
 * Selection contract (T021).
 *
 * Rules for what a projection may send to the model, kept pure so both the UI
 * budget and the server-side re-check use the same numbers:
 *
 *  - at most `selectedItemsPerProjection` items,
 *  - the list is explicit ids, never "everything currently filtered",
 *  - a tag filter must be resolved to ids before it reaches the server, and the
 *    server re-checks existence and versions rather than trusting the list.
 */
import { LIMITS } from './limits';

export const SELECTION_MODES = ['explicit'] as const;
export type SelectionMode = (typeof SELECTION_MODES)[number];

export interface ExplicitSelection {
  mode: 'explicit';
  itemIds: string[];
}

/** The maximum number of items one generation request may carry. */
export const SELECTION_MAX = LIMITS.selectedItemsPerProjection;

export interface SelectionCheck {
  ok: boolean;
  /** Present when `ok` is false. */
  reason?: 'empty' | 'too_many' | 'duplicate';
  /** Deduplicated ids in first-seen order (always returned when ok). */
  itemIds: string[];
}

/**
 * Validate a selection before it is sent.
 *
 * Duplicates are reported rather than silently dropped: a duplicated id means a
 * client bug (e.g. a double toggle), and quietly fixing it would hide that.
 */
export function checkSelection(itemIds: readonly string[]): SelectionCheck {
  if (itemIds.length === 0) return { ok: false, reason: 'empty', itemIds: [] };
  if (itemIds.length > SELECTION_MAX) {
    return { ok: false, reason: 'too_many', itemIds: [] };
  }
  const seen = new Set<string>();
  for (const id of itemIds) {
    if (seen.has(id)) return { ok: false, reason: 'duplicate', itemIds: [] };
    seen.add(id);
  }
  return { ok: true, itemIds: [...itemIds] };
}

/** How many more may be added before the budget is reached. */
export function remainingSelectionBudget(current: number): number {
  return Math.max(0, SELECTION_MAX - current);
}
