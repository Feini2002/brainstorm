/**
 * Delete service (T020).
 *
 * Deleting an item cascades to its relations and tag links through foreign keys,
 * inside one transaction. Historical views keep their source snapshot, so a view
 * whose sources were deleted reports "来源已删除" rather than pretending to be
 * current — the check lives in the view layer, not here.
 *
 * @see src/server/services/items.ts `deleteItemById`
 */
import 'server-only';

export { deleteItemById } from './items';
