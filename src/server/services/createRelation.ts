/**
 * Relation creation service (T022).
 *
 * Re-exports the single implementation. Manual creation promotes an existing AI
 * suggestion for the same canonical pair rather than inserting a parallel edge,
 * and uses symmetric normalization so `similar_to` has one stored direction.
 *
 * @see src/server/services/relations.ts `createManualRelation`
 */
import 'server-only';

export {
  createManualRelation,
  type CreateManualRelationInput,
  type CreateManualRelationResult,
} from './relations';
