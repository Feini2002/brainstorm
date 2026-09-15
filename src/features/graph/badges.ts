/**
 * Shared status wording for graph edges (T044-R03, T048-R02).
 *
 * Two rules drive this file:
 *
 *  - **Never colour alone.** A `suggested` edge is marked with the words
 *    「待确认」, and a stale one with 「依据过期」, so the distinction survives a
 *    greyscale print, a colour-blind viewer and a dark theme (T050-R04).
 *  - **Never call a score a correctness rate.** `score` is how strongly the
 *    model judged two notes related; 「关联评分」 says that and 「置信度」 does
 *    not. A user who reads 0.8 as "80% correct" would over-trust the model.
 */
import type { RelationFreshness } from '@/domain/staleness';
import type { ReviewStatus } from '@/domain/knowledge';

export const REVIEW_STATUS_BADGE: Record<ReviewStatus, string | null> = {
  suggested: '待确认',
  accepted: null,
  // Rejected edges are excluded by default; when shown they must be unmistakable.
  rejected: '已拒绝',
};

export const FRESHNESS_BADGE: Record<RelationFreshness, string | null> = {
  fresh: null,
  stale: '依据过期',
  missing: '端点已删除',
};

/**
 * Short mark drawn on the canvas.
 *
 * Staleness outranks review status when both apply: a stale suggestion's more
 * urgent problem is that its evidence moved, not that nobody has confirmed it.
 */
export function reviewStatusBadge(
  status: ReviewStatus,
  freshness: RelationFreshness,
): string | null {
  const staleness = FRESHNESS_BADGE[freshness];
  if (staleness !== null) return staleness;
  return REVIEW_STATUS_BADGE[status];
}

/** Explanation of what `score` means, shown next to the number (T048-R02). */
export const SCORE_LABEL = '关联评分';

export function describeScore(origin: 'ai' | 'manual', score: number | null): string {
  if (origin === 'manual') return '人工建立，没有模型评分';
  if (score === null) return '本次模型没有给出评分';
  return `${SCORE_LABEL} ${score.toFixed(2)}（模型判断的关联强度，不是正确率）`;
}

/** Line style per relation type family, so type is readable without colour. */
export type EdgeLineStyle = 'solid' | 'dashed' | 'dotted';

export function lineStyleFor(
  status: ReviewStatus,
  freshness: RelationFreshness,
): EdgeLineStyle {
  // Staleness and pending review are the two states the user must be able to
  // tell apart at a glance, so each owns one line style. Confirmed edges — AI or
  // manual — are plain: a score is not a reason to draw them differently.
  if (freshness !== 'fresh') return 'dotted';
  if (status === 'suggested') return 'dashed';
  return 'solid';
}
