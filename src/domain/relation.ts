/**
 * Relation identity rules.
 *
 * Symmetric relation types persist with endpoints sorted by UUID string order;
 * directional types keep their semantic direction. Pair identity is
 * (sourceId, targetId, relationType) after normalization, which is also the SQL
 * unique key — so one canonical pair never accumulates parallel edges.
 */
import type { UUID } from './knowledge';
import { isSymmetricRelationType, type RelationType } from './knowledge';

export interface NormalizedEndpoints {
  sourceId: UUID;
  targetId: UUID;
  /** True when the input endpoints were swapped to reach canonical order. */
  swapped: boolean;
}

export function normalizeEndpoints(
  sourceId: UUID,
  targetId: UUID,
  type: RelationType,
): NormalizedEndpoints {
  if (!isSymmetricRelationType(type)) {
    return { sourceId, targetId, swapped: false };
  }
  if (sourceId <= targetId) {
    return { sourceId, targetId, swapped: false };
  }
  return { sourceId: targetId, targetId: sourceId, swapped: true };
}

/**
 * Human-readable sentence for a relation in display direction. Symmetric types
 * read the same in both orders, so the caller may pass either endpoint first.
 */
export function describeRelation(
  type: RelationType,
  sourceLabel: string,
  targetLabel: string,
): string {
  switch (type) {
    case 'similar_to':
      return `“${sourceLabel}”与“${targetLabel}”内容相似`;
    case 'contradicts':
      return `“${sourceLabel}”与“${targetLabel}”存在矛盾`;
    case 'related_to':
      return `“${sourceLabel}”与“${targetLabel}”主题相关`;
    case 'extends':
      return `“${sourceLabel}”延伸了“${targetLabel}”`;
    case 'supports':
      return `“${sourceLabel}”为“${targetLabel}”提供理由或例证`;
    case 'example_of':
      return `“${sourceLabel}”是“${targetLabel}”的例子`;
    case 'depends_on':
      return `“${sourceLabel}”依赖“${targetLabel}”`;
    case 'causes':
      return `“${sourceLabel}”导致“${targetLabel}”`;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

/** English gloss used in exports and diagnostics. */
export const RELATION_TYPE_EN: Record<RelationType, string> = {
  similar_to: 'similar to',
  extends: 'extends',
  supports: 'supports',
  contradicts: 'contradicts',
  causes: 'causes',
  depends_on: 'depends on',
  example_of: 'example of',
  related_to: 'related to',
};

/** Review status labels the UI may show; never "true/false". */
export const REVIEW_STATUS_LABELS = {
  suggested: '待确认',
  accepted: '已确认',
  rejected: '已拒绝',
} as const;
