/**
 * Card and timeline display rules (T015-R01/R02/R06).
 *
 * Pure functions rather than JSX inline expressions. The repo's Vitest runs in a
 * node environment with no renderer, so a rule that lives inside `{cond ? a : b}`
 * cannot be asserted at all — and these are the rules the acceptance cases turn
 * on: an unorganized note must still be identifiable, a stale badge must not be
 * shown for a record that is current, and "does this card have any content" must
 * not depend on the organized title, which does not exist yet.
 */
import { isStructuredStale, type ItemDTO } from '@/domain/knowledge';

/** Label used when a record has no title of its own (T015-C01). */
export const UNTITLED_LABEL = '未命名';

/**
 * The card heading.
 *
 * Falls back to a bounded plain-text preview of the captured text — never to an
 * empty string and never by asking a model for a title (T015-R01). A record with
 * no title must still look like a record.
 */
export function cardTitle(item: Pick<ItemDTO, 'title' | 'capturedText'>): string {
  const title = item.title.trim();
  if (title.length > 0) return title;
  const preview = collapseForPreview(item.capturedText);
  return preview.length > 0 ? preview : UNTITLED_LABEL;
}

/** Newlines and runs of whitespace are collapsed so a heading stays one line. */
function collapseForPreview(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * How much of the captured text the card itself shows before the CSS clamp.
 *
 * The card is a list item, so a ten-thousand-character note must not be mounted
 * in full (T015-C06): the detail drawer is where the whole text lives.
 */
export const CARD_PREVIEW_CODE_POINTS = 200;

export function cardPreview(
  item: Pick<ItemDTO, 'capturedText'>,
  max = CARD_PREVIEW_CODE_POINTS,
): string {
  const points = Array.from(item.capturedText);
  return points.length <= max ? item.capturedText : `${points.slice(0, max).join('')}…`;
}

/**
 * Whether the card should show the "source changed" badge.
 *
 * A record whose stored organization was derived from an older raw version is
 * stale; one that was never organized has nothing to be stale (T015-R06), and a
 * badge there would only add noise.
 */
export function showsStaleBadge(item: Pick<ItemDTO, 'structuredBaseRawVersion' | 'rawVersion'>): boolean {
  return (
    item.structuredBaseRawVersion !== null &&
    isStructuredStale(item.structuredBaseRawVersion, item.rawVersion)
  );
}

/**
 * Whether the card can be opened to show the original text.
 *
 * Every state — raw, processing, failed, stale — keeps its content readable: a
 * failed organize must not make the user's material disappear (T015-R06/C05).
 */
export function hasReadableContent(item: Pick<ItemDTO, 'capturedText' | 'rawText'>): boolean {
  return item.rawText.trim().length > 0 || item.capturedText.trim().length > 0;
}

/**
 * The timeline's "showing N of M" line.
 *
 * Stated explicitly rather than implied, so the user can tell a truncated page
 * from a complete list (T015-C04: one new record must not appear twice — the
 * count is what the user compares against).
 */
export function timelineSummary(input: { shown: number; totalMatched: number }): string {
  if (input.shown >= input.totalMatched) return `共 ${input.totalMatched} 条`;
  return `共 ${input.totalMatched} 条，显示最新 ${input.shown} 条`;
}
