'use client';

/**
 * Layout persistence (T047).
 *
 * The rules this hook has to get right, and how:
 *
 *  - **No per-frame writes (T047-R02).** Callers hand in *only the nodes that
 *    moved*, and commits are debounced. A ten-second drag produces one request,
 *    not hundreds of SQLite writes.
 *  - **The last edit must not be lost.** Edits that arrive while a save is in
 *    flight bump a generation counter. On success the hook compares generations:
 *    if the user moved something mid-flight, `dirty` stays set and the debounce
 *    fires another pass. Clearing `dirty` unconditionally would drop that move.
 *  - **A conflict keeps the local draft (T047-R03).** On 409 the hook stops
 *    auto-saving and reports the conflict. It neither overwrites the other
 *    window nor discards what the user just arranged, so the caller can offer
 *    "reload" or "overwrite".
 *  - **Nothing is written to the item (T047-R01).** Only positions, direction and
 *    viewport are sent; the route stores them in `views.content_json`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiClientError, apiRequest } from '@/features/shared/apiClient';
import type { GraphDirection } from '@/features/graph/types';

export interface LayoutPersistenceBaseline {
  positions: Record<string, { x: number; y: number }>;
  direction: GraphDirection;
  revision: number | null;
}

export interface UseLayoutPersistenceInput {
  /** Null until a view exists; a fresh canvas has nothing to save into. */
  viewId: string | null;
  baseline: LayoutPersistenceBaseline;
  /** Milliseconds to coalesce rapid drags into one commit. */
  debounceMs?: number;
}

export interface LayoutPersistenceState {
  positions: Record<string, { x: number; y: number }>;
  direction: GraphDirection;
  revision: number | null;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  error: ApiClientError | null;
  /** Merge a drag result into the draft and schedule a commit. */
  moveNodes: (moved: Record<string, { x: number; y: number }>) => void;
  setDirection: (next: GraphDirection) => void;
  save: (override?: { expectedRevision?: number }) => Promise<void>;
  /** Adopt a newer baseline after reload; clears the conflict (T047-R03). */
  reset: (baseline: LayoutPersistenceBaseline) => void;
}

export function useLayoutPersistence(input: UseLayoutPersistenceInput): LayoutPersistenceState {
  const debounceMs = input.debounceMs ?? 600;

  const [positions, setPositionsState] = useState(input.baseline.positions);
  const [direction, setDirectionState] = useState<GraphDirection>(input.baseline.direction);
  const [revision, setRevision] = useState(input.baseline.revision);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [scheduleToken, setScheduleToken] = useState(0);

  /** Draft positions; a ref so a debounced commit reads the newest value. */
  const draftRef = useRef(input.baseline.positions);
  const directionDraftRef = useRef(input.baseline.direction);
  const revisionRef = useRef(input.baseline.revision);
  const generationRef = useRef(0);
  const savedGenerationRef = useRef(0);
  const savingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  /**
   * True once a baseline has been adopted (T047-R06).
   *
   * A ref rather than state because `save()` is invoked from a debounce timer and
   * from an event handler. A `useState` flag read inside `save` would be whatever
   * value was captured when the callback was created, which lets a drag performed
   * while the view is still loading write the *empty* draft over the stored
   * positions.
   */
  const baselineReadyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const schedule = useCallback(() => {
    generationRef.current += 1;
    setDirty(true);
    setScheduleToken((value) => value + 1);
  }, []);

  /** Ignore edits that arrive before the stored layout is known (T047-R06). */
  const isEditable = useCallback(
    () => baselineReadyRef.current && input.viewId !== null,
    [input.viewId],
  );

  const moveNodes = useCallback(
    (moved: Record<string, { x: number; y: number }>) => {
      if (!isEditable()) return;
      draftRef.current = { ...draftRef.current, ...moved };
      setPositionsState(draftRef.current);
      schedule();
    },
    [isEditable, schedule],
  );

  const setDirection = useCallback(
    (next: GraphDirection) => {
      // Direction is a draft even without a saved view — it is applied to the next
      // auto-layout and to the view the user may create. It simply is not written
      // until there is a view to write it into.
      if (!baselineReadyRef.current) return;
      directionDraftRef.current = next;
      setDirectionState(next);
      if (input.viewId !== null) schedule();
    },
    [input.viewId, schedule],
  );

  const reset = useCallback((baseline: LayoutPersistenceBaseline) => {
    draftRef.current = baseline.positions;
    directionDraftRef.current = baseline.direction;
    revisionRef.current = baseline.revision;
    savedGenerationRef.current = generationRef.current;
    baselineReadyRef.current = true;
    setPositionsState(baseline.positions);
    setDirectionState(baseline.direction);
    setRevision(baseline.revision);
    setConflict(false);
    setError(null);
    setDirty(false);
  }, []);

  const save = useCallback(
    async (override?: { expectedRevision?: number }) => {
      if (!input.viewId || savingRef.current) return;
      const expectedRevision = override?.expectedRevision ?? revisionRef.current;
      if (expectedRevision === null) return;

      const generationAtSend = generationRef.current;
      savingRef.current = true;
      setSaving(true);
      setError(null);

      try {
        const result = await apiRequest<{ revision: number }>(
          `/api/views/${input.viewId}/layout`,
          {
            method: 'PUT',
            body: {
              expectedRevision,
              positions: draftRef.current,
              direction: directionDraftRef.current,
            },
          },
        );
        if (!mountedRef.current) return;
        revisionRef.current = result.revision;
        savedGenerationRef.current = generationAtSend;
        setRevision(result.revision);
        setConflict(false);
        // Only "not dirty any more" if nothing changed while the request was out.
        setDirty(generationRef.current !== generationAtSend);
      } catch (caught) {
        if (!mountedRef.current) return;
        if (caught instanceof ApiClientError && caught.code === 'REVISION_CONFLICT') {
          setConflict(true);
        } else {
          setError(
            caught instanceof ApiClientError
              ? caught
              : new ApiClientError({ code: 'INTERNAL', message: '保存布局失败', retryable: true }),
          );
        }
      } finally {
        savingRef.current = false;
        if (mountedRef.current) setSaving(false);
      }
    },
    [input.viewId],
  );

  // Debounced auto-commit. Disabled while a conflict is unresolved, so the hook
  // cannot retry its way into overwriting the other window (T047-R03).
  useEffect(() => {
    if (!dirty || !input.viewId || conflict) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void save();
    }, debounceMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [scheduleToken, dirty, conflict, input.viewId, save, debounceMs]);

  return useMemo(
    () => ({
      positions,
      direction,
      revision,
      dirty,
      saving,
      conflict,
      error,
      moveNodes,
      setDirection,
      save,
      reset,
    }),
    [
      conflict,
      direction,
      dirty,
      error,
      moveNodes,
      positions,
      reset,
      revision,
      save,
      saving,
      setDirection,
    ],
  );
}
