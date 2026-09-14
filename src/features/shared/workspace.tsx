'use client';

/**
 * Workspace state shared by the six pages (T018, T021).
 *
 * Two things must agree across pages, so both live here rather than in each
 * page:
 *
 *  - **The open item.** A card clicked in the inbox and the same card clicked in
 *    the library open one drawer with one state.
 *  - **The selection.** The explicit list of ids the user ticked for a later
 *    mindmap or flow. The store itself is `useSelectionStore`; this provider is
 *    only the place that makes it shared. Only ids are kept, and generation
 *    re-reads the items server-side, so a stale id can never send extra
 *    knowledge to the model (T021-R01/R04).
 *
 * The refresh token is bumped after a write so a page can refetch without the
 * layout needing to know which page it is.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { SELECTION_LIMIT, useSelectionStore, type SelectionState } from './useSelection';

export { SELECTION_LIMIT, useSelectionStore };
export type { SelectionState };

export interface WorkspaceState {
  selection: SelectionState;
  /** Id of the item shown in the detail drawer, or null. */
  openItemId: string | null;
  openItem: (id: string) => void;
  closeItem: () => void;
  /** Bumped after an edit or delete so lists can refetch. */
  refreshToken: number;
  notifyChanged: () => void;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({
  children,
  selectionLimit = SELECTION_LIMIT,
}: {
  children: ReactNode;
  /** Overridable so the budget can be tightened without touching call sites. */
  selectionLimit?: number;
}) {
  const selection = useSelectionStore(selectionLimit);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const openItem = useCallback((id: string) => setOpenItemId(id), []);
  const closeItem = useCallback(() => setOpenItemId(null), []);
  const notifyChanged = useCallback(() => setRefreshToken((current) => current + 1), []);

  const value = useMemo<WorkspaceState>(
    () => ({ selection, openItemId, openItem, closeItem, refreshToken, notifyChanged }),
    [closeItem, notifyChanged, openItem, openItemId, refreshToken, selection],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceState {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('useWorkspace 必须在 WorkspaceProvider 内使用');
  return context;
}

export function useSelection(): SelectionState {
  return useWorkspace().selection;
}
