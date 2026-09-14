import type { ReactNode } from 'react';

import { EmptyState } from '@/components/ui/primitives';

/**
 * Honest placeholder used while a section's own tasks are still pending.
 *
 * It describes the concrete next action instead of a generic failure, and it
 * never shows a button that does nothing (T005-R03, mission rule 10).
 */
export function SectionPending({
  title,
  description,
  next,
}: {
  title: string;
  description: string;
  next: ReactNode;
}) {
  return <EmptyState title={title} description={description} action={next} />;
}
