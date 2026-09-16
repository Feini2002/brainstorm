import type { Page } from '@playwright/test';

/**
 * Console and page-error watch (T078-R03).
 *
 * The rule this file exists to enforce: **an unexpected browser-side error is a
 * test failure, and "expected" is a short, written list rather than a blanket
 * `page.on('pageerror', () => {})`.** A case that silently swallowed everything
 * would keep passing while the product logged React key warnings, unhandled
 * rejections or a crashed component; that is exactly the hidden instability
 * T078-C04 forbids.
 *
 * Two categories are kept apart, because conflating them is what makes an
 * error-watch useless:
 *
 *  - **`pageerror`** — an uncaught exception. Never excused. If the app throws,
 *    the case must fail and the stack is the location.
 *  - **`console.error`** — the browser's own line about a request that did not
 *    return 2xx, or a React warning. Excused only by a rule below, and every
 *    excused line is still recorded so a run can report *what* it let through
 *    instead of pretending nothing happened.
 *
 * The two rules are not conveniences:
 *
 *  1. `observeTraffic` (T024-R05) blocks every non-loopback host, and several
 *     cases deliberately request a remote asset to prove it is never fetched.
 *     Chromium logs that abort as `Failed to load resource:
 *     net::ERR_INTERNET_DISCONNECTED`. The case asserts the *point* of the
 *     abort (no external request succeeded), so the browser's line about its own
 *     blocked request is not a product defect.
 *  2. The API answers errors with the contract envelope and a non-2xx status
 *     (409 on a stale revision, `MODEL_NOT_CONFIGURED` on a missing key, …).
 *     A negative case is *about* receiving that status, which the case asserts.
 *     Chromium logs any non-2xx resource as `Failed to load resource: the server
 *     responded with a status of …`, so the status is not re-judged here.
 *
 * Everything else — including every `pageerror`, React warnings, unhandled
 * promise rejections, and content that failed to parse — fails the case.
 */
export interface ObservedError {
  kind: 'pageerror' | 'console';
  text: string;
  /** Set when a rule explains the line; `null` means it should have failed. */
  reason: string | null;
}

export interface ConsoleWatch {
  /** Everything seen, excused or not, in the order it arrived. */
  observed: () => readonly ObservedError[];
  /** Uncaught exceptions: always unexplained, so a non-empty list is a failure. */
  unexpectedPageErrors: () => string[];
  /** `console.error` lines that no rule explains. */
  unexpectedConsoleErrors: () => string[];
  /** Errors a rule explained, with the rule's reason, so nothing is hidden. */
  excused: () => { kind: 'pageerror' | 'console'; text: string; reason: string }[];
  /** Stop listening. Called by the fixture teardown; idempotent. */
  stop: () => void;
}

interface ExcuseRule {
  reason: string;
  matches: (text: string) => boolean;
}

/**
 * The complete allow-list. Adding an entry is a decision that the text is not a
 * product defect, so each one states why.
 */
const EXCUSE_RULES: readonly ExcuseRule[] = [
  {
    reason:
      'e2e 装置主动阻断外部主机（T024-R05）：这条是浏览器在报告它自己发起的请求被 abort，用例另行断言“没有任何外部请求成功”',
    matches: (text) =>
      /^Failed to load resource: net::ERR_(INTERNET_DISCONNECTED|FAILED|ABORTED|BLOCKED_BY_CLIENT|CONNECTION_REFUSED|UNSAFE_PORT|NAME_NOT_RESOLVED)/u.test(
        text,
      ),
  },
  {
    reason:
      '用法用例故意触发非 2xx（409 冲突、MODEL_NOT_CONFIGURED、500 等），用例自己断言了状态码与错误码；浏览器只是把同一件事又写了一遍',
    matches: (text) =>
      /^Failed to load resource: the server responded with a status of \d{3}/u.test(text),
  },
];

function excuseFor(text: string): string | null {
  for (const rule of EXCUSE_RULES) {
    if (rule.matches(text)) return rule.reason;
  }
  return null;
}

/**
 * Start watching one page.
 *
 * `page.on` is used rather than `page.route`/CDP so the watch also sees errors
 * from event handlers and effects, which never pass through the network layer.
 */
export function watchConsoleErrors(page: Page): ConsoleWatch {
  const observed: ObservedError[] = [];

  const onPageError = (error: Error): void => {
    // An uncaught exception is never excused; the message is kept verbatim so the
    // failure names the component rather than "something threw".
    observed.push({ kind: 'pageerror', text: error.message, reason: null });
  };
  const onConsole = (message: { type: () => string; text: () => string }): void => {
    if (message.type() !== 'error') return;
    const text = message.text();
    observed.push({ kind: 'console', text, reason: excuseFor(text) });
  };

  page.on('pageerror', onPageError);
  page.on('console', onConsole);

  return {
    observed: () => observed,
    unexpectedPageErrors: () =>
      observed.filter((entry) => entry.kind === 'pageerror').map((entry) => entry.text),
    unexpectedConsoleErrors: () =>
      observed
        .filter((entry) => entry.kind === 'console' && entry.reason === null)
        .map((entry) => entry.text),
    excused: () =>
      observed
        .filter((entry): entry is ObservedError & { reason: string } => entry.reason !== null)
        .map((entry) => ({ kind: entry.kind, text: entry.text, reason: entry.reason })),
    stop: () => {
      page.off('pageerror', onPageError);
      page.off('console', onConsole);
    },
  };
}
