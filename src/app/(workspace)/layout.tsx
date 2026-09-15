'use client';

/**
 * Workspace layout (T005, T018, T021).
 *
 * Hosts the two pieces of cross-page state — the open item drawer and the
 * selection budget — plus the selection tray that tells the user what will be
 * sent to the model and how much room is left.
 */
import type { ReactNode } from 'react';

import { KnowledgeDrawer } from '@/features/shared/KnowledgeDrawer';
import { SelectionTray } from '@/features/shared/SelectionTray';
import { WorkspaceProvider, useWorkspace } from '@/features/shared/workspace';

function DrawerHost() {
  const workspace = useWorkspace();
  if (!workspace.openItemId) return null;
  return (
    <KnowledgeDrawer
      itemId={workspace.openItemId}
      onClose={workspace.closeItem}
      // The drawer reports `deleted` explicitly, so the selection can drop the id
      // in the same tick as the delete instead of waiting for a list refetch
      // (T021-R04 / T026-C04).
      onChanged={(change) =>
        workspace.notifyChanged(change.deleted ? { deletedId: change.id } : {})
      }
    />
  );
}

function Body({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <SelectionTray />
        {children}
      </div>
      <DrawerHost />
    </>
  );
}

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <Body>{children}</Body>
    </WorkspaceProvider>
  );
}
