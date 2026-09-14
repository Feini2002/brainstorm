/**
 * Time formatting for cards and timelines (T015-R03).
 *
 * Relative phrasing for anything recent, an absolute local timestamp once a
 * record is old enough that "3 days ago" stops being useful. The absolute form
 * is always available to assistive tech via the `title`, so the relative text is
 * never the only representation.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface FormattedTime {
  /** Short human text, e.g. "刚刚" / "3 小时前" / "2026-03-04 15:20". */
  label: string;
  /** Full local timestamp for the `title` attribute. */
  absolute: string;
  /** Machine-readable ISO string for `dateTime`. */
  iso: string;
}

/** Two-digit zero pad for the local timestamp. */
function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

export function formatLocalTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/**
 * @param iso  timestamp from the server
 * @param now  injectable clock so the formatting is testable without waiting
 */
export function formatTime(iso: string, now: Date = new Date()): FormattedTime {
  const date = new Date(iso);
  const absolute = formatLocalTimestamp(iso);
  if (Number.isNaN(date.getTime())) {
    return { label: iso, absolute: iso, iso };
  }

  const delta = now.getTime() - date.getTime();
  if (delta < 0) {
    // Clock skew between the browser and the server: show the exact time.
    return { label: absolute, absolute, iso };
  }

  let label: string;
  if (delta < MINUTE) label = '刚刚';
  else if (delta < HOUR) label = `${Math.floor(delta / MINUTE)} 分钟前`;
  else if (delta < DAY) label = `${Math.floor(delta / HOUR)} 小时前`;
  else if (delta < 7 * DAY) label = `${Math.floor(delta / DAY)} 天前`;
  else label = absolute;

  return { label, absolute, iso };
}
