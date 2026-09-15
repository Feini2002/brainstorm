'use client';

/**
 * Selection store (T021).
 *
 * The authoritative state is a list of item ids, nothing else — no copy of the
 * note text, no editable mirror. Generation later re-reads the items server-side
 * (T021-R01), so a stale id here can never change what is actually sent.
 *
 * Two facts about the current list are tracked alongside it, because both have
 * to be shown rather than guessed:
 *
 *  - `visibleItemIds` — what the active filter currently renders. Selection
 *    survives a filter change, so the tray needs it to report how many selected
 *    items the filter is hiding (T021-C03).
 *  - `removedIds` — ids dropped because the record no longer exists. Deleting a
 *    note removes it from the selection and says so, rather than leaving a
 *    silent hole (T021-C04).
 *
 * Every callback here is identity-stable: pages call them from effects, and an
 * unstable setter would re-trigger those effects forever.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { LIMITS } from '@/domain/limits';

/** How many items one projection may send to the model (`selectedItemsPerProjection`). */
export const SELECTION_LIMIT = LIMITS.selectedItemsPerProjection;

export interface SelectionState {
  /** Ordered ids; the order is what a generation payload will use. */
  itemIds: string[];
  count: number;
  limit: number;
  isFull: boolean;
  /** Selected ids the active filter hides; null when no filter set a visible list. */
  hiddenCount: number | null;
  /** Ids dropped by the last `prune` because they no longer exist. */
  removedIds: string[];
  has: (id: string) => boolean;
  toggle: (id: string, selected: boolean) => void;
  add: (ids: readonly string[]) => void;
  remove: (id: string) => void;
  clear: () => void;
  /** True when adding `additional` more would exceed the budget. */
  wouldExceed: (additional: number) => boolean;
  /** Tell the store which ids the current filter renders (null clears it). */
  setVisible: (ids: readonly string[] | null) => void;
  /** Drop ids the server no longer has; returns the removed ids. */
  prune: (existingIds: readonly string[]) => string[];
  /**
   * Drop one id the client *knows* is gone, e.g. the record it just deleted.
   *
   * `prune` needs the full existing id list, which only a completed list read can
   * provide. A delete can happen on a page that has no such read (the inbox), so
   * without this the selection would keep a dead id until the user next visited
   * the library — exactly the stale reference T021-R04 forbids.
   */
  dropDeleted: (id: string) => void;
  /** Clear the "removed" notice after the user has seen it. */
  acknowledgeRemoved: () => void;
}

function sameIds(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function useSelectionStore(limit: number = SELECTION_LIMIT): SelectionState {
  const [itemIds, setItemIds] = useState<string[]>([]);
  const [visibleItemIds, setVisibleItemIds] = useState<string[] | null>(null);
  const [removedIds, setRemovedIds] = useState<string[]>([]);

  // `prune` needs the current list without depending on it, so its identity stays
  // stable for the pages that call it from effects. Refs are written in effects only.
  const itemIdsRef = useRef<string[]>(itemIds);
  useEffect(() => {
    itemIdsRef.current = itemIds;
  }, [itemIds]);

  const toggle = useCallback(
    (id: string, selected: boolean) => {
      setItemIds((current) => {
        if (!selected) return current.filter((entry) => entry !== id);
        if (current.includes(id)) return current;
        // Reaching the budget is not an error: it stops adding and the tray
        // explains why (T021-C02).
        if (current.length >= limit) return current;
        return [...current, id];
      });
    },
    [limit],
  );

  const add = useCallback(
    (ids: readonly string[]) => {
      setItemIds((current) => {
        const next = [...current];
        for (const id of ids) {
          if (next.includes(id)) continue;
          if (next.length >= limit) break;
          next.push(id);
        }
        return next;
      });
    },
    [limit],
  );

  const remove = useCallback((id: string) => {
    setItemIds((current) => current.filter((entry) => entry !== id));
  }, []);

  const clear = useCallback(() => {
    setItemIds([]);
    setRemovedIds([]);
  }, []);

  const setVisible = useCallback((ids: readonly string[] | null) => {
    const next = ids === null ? null : [...ids];
    setVisibleItemIds((current) => (sameIds(current, next) ? current : next));
  }, []);

  const acknowledgeRemoved = useCallback(() => setRemovedIds([]), []);

  const dropDeleted = useCallback((id: string) => {
    const current = itemIdsRef.current;
    if (!current.includes(id)) return;
    setItemIds(current.filter((entry) => entry !== id));
    // Reported like `prune` does: a selected item disappearing from the send
    // scope must be explained, not silent (T021-C04).
    setRemovedIds((previous) => (previous.includes(id) ? previous : [...previous, id]));
  }, []);

  const prune = useCallback((existingIds: readonly string[]) => {
    const existing = new Set(existingIds);
    const removed = itemIdsRef.current.filter((id) => !existing.has(id));
    if (removed.length === 0) return removed;
    // Reported to the user, not just dropped: an invisible disappearance from the
    // selection would make the scope of the next generation unclear.
    setItemIds(itemIdsRef.current.filter((id) => existing.has(id)));
    setRemovedIds(removed);
    return removed;
  }, []);

  return useMemo<SelectionState>(() => {
    const visible = visibleItemIds === null ? null : new Set(visibleItemIds);
    return {
      itemIds,
      count: itemIds.length,
      limit,
      isFull: itemIds.length >= limit,
      hiddenCount: visible === null ? null : itemIds.filter((id) => !visible.has(id)).length,
      removedIds,
      has: (id: string) => itemIds.includes(id),
      toggle,
      add,
      remove,
      clear,
      wouldExceed: (additional: number) => itemIds.length + additional > limit,
      setVisible,
      prune,
      dropDeleted,
      acknowledgeRemoved,
    };
  }, [
    acknowledgeRemoved,
    add,
    clear,
    dropDeleted,
    itemIds,
    limit,
    prune,
    remove,
    removedIds,
    setVisible,
    toggle,
    visibleItemIds,
  ]);
}
