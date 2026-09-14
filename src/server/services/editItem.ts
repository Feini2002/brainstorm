/**
 * Edit service (T019).
 *
 * Re-exports the single edit implementation under the task's expected module
 * name. `patchItem` in `services/items.ts` already owns the invariants
 * (optimistic concurrency, rawVersion only on real raw-text change, manual-field
 * locking derived from the actual change set), so duplicating the logic here
 * would create a second, divergent copy.
 *
 * @see src/server/services/items.ts `patchItem`
 */
import 'server-only';

export {
  patchItem,
  deleteItemById,
  itemTags,
  type PatchItemInput,
} from './items';

/** Field-level edit contract, kept next to the service that enforces it. */
export type { UserPatch } from '@/domain/itemFields';
