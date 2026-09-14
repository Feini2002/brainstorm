/**
 * Unicode-safe text measurement.
 *
 * The data contract counts "characters" in Unicode code points, never UTF-16
 * code units, and counts JSON/network sizes in UTF-8 bytes. Mixing the two is a
 * documented defect class, so both helpers live here and nowhere else.
 */

/** Unicode code point count (`Array.from(text).length`). */
export function codePointLength(text: string): number {
  let count = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of text) count += 1;
  return count;
}

/** UTF-8 byte length of the string. */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** True when `text.trim()` is non-empty. Used only to reject empty input. */
export function hasVisibleContent(text: string): boolean {
  return text.trim().length > 0;
}

/** Truncate to at most `max` code points without splitting surrogate pairs. */
export function truncateCodePoints(text: string, max: number): string {
  if (max <= 0) return '';
  const points = Array.from(text);
  if (points.length <= max) return text;
  return points.slice(0, max).join('');
}

/**
 * Collapse runs of whitespace to a single space and trim. Used for tag and
 * keyword normalization keys only — never applied to captured/raw text.
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}
