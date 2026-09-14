/**
 * Relation domain contract (T022).
 *
 * The task expects a `src/domain/relations.ts` module. Direction semantics live
 * in `relation.ts`; this module is the stable import surface for the relation
 * editor, and adds the presentation metadata the editor needs (direction hint and
 * which types are symmetric).
 */
export { describeRelation, normalizeEndpoints, type NormalizedEndpoints } from './relation';

import {
  RELATION_TYPE_LABELS,
  RELATION_TYPES,
  isSymmetricRelationType,
  type RelationType,
} from './knowledge';

export interface RelationTypeMeta {
  type: RelationType;
  label: string;
  /** Symmetric types store endpoints sorted by id and read the same either way. */
  symmetric: boolean;
  /** Short explanation of the arrow direction, shown in the editor. */
  directionHint: string;
}

const DIRECTIONAL_HINTS: Record<RelationType, string> = {
  similar_to: '两个方向意思相同',
  extends: '从起点延伸到终点',
  supports: '起点为终点提供支撑',
  contradicts: '两个方向意思相同',
  causes: '起点是原因，终点是结果',
  depends_on: '起点依赖终点',
  example_of: '起点是终点的例子',
  related_to: '两个方向意思相同',
};

/** Every relation type with the labels and direction the editor shows. */
export const RELATION_TYPE_META: readonly RelationTypeMeta[] = RELATION_TYPES.map((type) => ({
  type,
  label: RELATION_TYPE_LABELS[type],
  symmetric: isSymmetricRelationType(type),
  directionHint: DIRECTIONAL_HINTS[type],
}));

export function relationTypeMeta(type: RelationType): RelationTypeMeta {
  const found = RELATION_TYPE_META.find((entry) => entry.type === type);
  if (!found) throw new Error(`unknown relation type: ${type}`);
  return found;
}
