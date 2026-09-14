/**
 * Relation review service (T023).
 *
 * Re-exports the single implementation. Review rules that matter for "rejected
 * stays rejected" and "evidence must still match" are enforced there:
 * accept/reject/restoreSuggestion apply only to origin=ai rows, and reconfirm
 * re-matches stored quotes against the current raw text instead of keeping stale
 * evidence.
 *
 * @see src/server/services/relations.ts `reviewRelation`
 */
import 'server-only';

export { reviewRelation, removeRelation, type ReviewAction, type ReviewRelationInput } from './relations';
