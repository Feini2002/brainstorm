'use client';

/**
 * Library route (T016).
 *
 * The open item is held in the workspace provider rather than the URL, so the
 * drawer is the same object whether the card was clicked here or in the inbox.
 */
import { LibraryPage } from '@/features/library/LibraryPage';
import { useWorkspace } from '@/features/shared/workspace';

export default function LibraryRoute() {
  const workspace = useWorkspace();
  return <LibraryPage onOpen={workspace.openItem} refreshToken={workspace.refreshToken} />;
}
