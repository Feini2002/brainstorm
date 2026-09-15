/**
 * Submit shortcut rules for the capture box (T013-R03).
 *
 * Kept out of the component so the rule is testable without a renderer: the
 * repo's Vitest runs in a node environment with no jsdom, and "Enter during IME
 * composition must not submit" is exactly the kind of rule that silently breaks
 * when it only exists inside a JSX handler.
 *
 * Two independent signals are checked because browsers disagree:
 *
 *   - `isComposing` is the standard flag, but Safari has historically reported
 *     Enter that *ends* composition with `isComposing === false`.
 *   - `keyCode === 229` is the legacy "the IME is consuming this key" marker and
 *     covers the Safari case and some older Chinese IMEs.
 *
 * A half-finished candidate must never be saved, so the guard is deliberately
 * conservative: any sign of composition wins over the shortcut.
 */

/** The shape of the keyboard event the rule needs. Structural, not a DOM type. */
export interface ShortcutKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** True when the key event is part of an in-progress IME composition. */
export function isComposingKey(event: ShortcutKeyEvent): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

/**
 * Whether this key event should submit the draft.
 *
 * Ctrl+Enter (Cmd+Enter on macOS) submits; plain Enter always inserts a newline.
 * Composition takes precedence over both.
 */
export function shouldSubmitFromKeyboard(event: ShortcutKeyEvent): boolean {
  if (isComposingKey(event)) return false;
  return event.key === 'Enter' && (event.ctrlKey === true || event.metaKey === true);
}

/**
 * Whether the draft may be sent at all.
 *
 * Whitespace-only input is rejected *before* the request is built (T013-C04):
 * an empty record would pollute the timeline and the graph, and there is no
 * server-side reason to spend a request discovering that.
 *
 * `codePoints` is compared against the same `LIMITS.rawTextCodePoints` the wire
 * schema uses, so the client cannot offer something the server will refuse
 * (T013-C05).
 */
export function canSubmitDraft(input: {
  text: string;
  codePoints: number;
  limit: number;
  saving: boolean;
}): boolean {
  if (input.saving) return false;
  if (input.text.trim().length === 0) return false;
  return input.codePoints <= input.limit;
}

/**
 * Whether the "unsaved changes" guard should be armed on unload.
 *
 * Registered only when there is text the server has not accepted. Comparing
 * against `lastAccepted` (rather than `''`) matters: after a successful save the
 * draft is cleared, but if the user typed again the draft differs from what was
 * stored and the warning is correct.
 */
export function hasUnsavedDraft(draft: string, lastAccepted: string | null): boolean {
  if (draft.trim().length === 0) return false;
  return draft !== (lastAccepted ?? '');
}
