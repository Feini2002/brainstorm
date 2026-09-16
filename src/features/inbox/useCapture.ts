'use client';

/**
 * Capture state machine (T013-R03..R06, T025).
 *
 * The draft is the user's text and is only ever cleared by a confirmed write, and
 * only when it is still the exact snapshot that was submitted. "Exact" is decided
 * by a monotonic draft revision, not by comparing strings: if the user edits and
 * then types back to identical text, that is still new input and must survive
 * (T025-R05).
 *
 * **Where the draft lives.** In a module-level store, subscribed with
 * `useSyncExternalStore`, not in component state. That keeps the text in memory
 * only — nothing is written to localStorage or anywhere else (T025-R03) — while
 * still letting it survive a route change, so switching to the library and back
 * does not silently discard what the user was writing (T025-C04).
 *
 * Every submit uses a fresh `captureRequestId`, so a retry after a lost response
 * is a replay rather than a second note. An unresolved submission keeps its key
 * so the user can safely retry the same request (T025-R02).
 *
 * Save and organize are two separate outcomes. "已保存" comes from the create
 * response alone and is never rewritten by a later organize failure (T025-R04).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { ItemDTO } from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import { codePointLength } from '@/domain/text';
import { ApiClientError, apiRequest } from '@/features/shared/apiClient';
import { ACTIONS, failureKeepingSaved } from '@/features/shared/StatusLabel';
import { canSubmitDraft, hasUnsavedDraft } from './captureShortcuts';

export type CaptureSourceType = ItemDTO['sourceType'];

export interface CaptureResult {
  item: ItemDTO;
  replayed: boolean;
}

/** Where the write stands. `unknown` means the client cannot tell if it landed. */
export type CapturePhase = 'idle' | 'saving' | 'saved' | 'unknown' | 'failed';

/** Outcome of the optional organize step that follows a successful save. */
export interface OrganizeOutcome {
  ok: boolean;
  message: string;
}

export interface CaptureOutcome {
  item: ItemDTO;
  replayed: boolean;
  /** The record exists in the database; independent of the organize result. */
  stored: true;
}

export interface UseCaptureOptions {
  /** Called after a confirmed create so the caller can prepend the new card. */
  onCreated?: (result: CaptureResult) => void;
  /**
   * Optional second step, run only after the raw text is stored. Wired up in G2;
   * without it only "已保存" is reported.
   */
  organize?: (item: ItemDTO) => Promise<void>;
}

export interface UseCaptureApi {
  draft: string;
  setDraft: (value: string) => void;
  sourceType: CaptureSourceType;
  setSourceType: (value: CaptureSourceType) => void;
  sourceRef: string;
  setSourceRef: (value: string) => void;
  phase: CapturePhase;
  error: ApiClientError | null;
  /** True while the raw text cannot be submitted (empty or too long). */
  canSubmit: boolean;
  codePoints: number;
  limit: number;
  overLimit: boolean;
  /** Set once the text is stored; stays set even if a later step fails. */
  outcome: CaptureOutcome | null;
  /** Result of the organize phase that followed the last save, or null. */
  organizeOutcome: OrganizeOutcome | null;
  /** Outcome text for the status line. */
  notice: string | null;
  /**
   * Advice that belongs with the draft: save stored but organize not run, or the
   * last failure. Kept in the draft store so navigating away does not erase the
   * explanation (T024-R04). Never blocks input (T025-R06).
   */
  inputHint: string | null;
  /** Record a hint that must survive navigation, e.g. "model not configured". */
  setInputHint: (value: string | null) => void;
  submit: () => Promise<void>;
  /** Re-send the last submission with the same key (idempotent replay). */
  retry: () => Promise<void>;
  dismissError: () => void;
  /** Forget the previous outcome after the user has read it. */
  acknowledge: () => void;
}

/* -------------------------------------------------------------------------- */
/* In-memory draft store (shared across mounts, never persisted)              */
/* -------------------------------------------------------------------------- */

interface DraftSnapshot {
  text: string;
  sourceType: CaptureSourceType;
  sourceRef: string;
  /**
   * Durable hint that belongs next to the input rather than in a transient
   * status line (T024-R04).
   *
   * Two facts need to survive navigation: the text was stored but organizing was
   * never run, and the model connection is unusable. Both are about *what the
   * user should do next with this draft*, so they live with the draft instead of
   * vanishing when the user visits the library and comes back.
   */
  inputHint: string | null;
}

const EMPTY_DRAFT: DraftSnapshot = { text: '', sourceType: 'other', sourceRef: '', inputHint: null };
let draftSnapshot: DraftSnapshot = EMPTY_DRAFT;
const draftListeners = new Set<() => void>();

function subscribeDraft(listener: () => void): () => void {
  draftListeners.add(listener);
  return () => {
    draftListeners.delete(listener);
  };
}

function getDraft(): DraftSnapshot {
  return draftSnapshot;
}

/** Server render has no user input yet; the empty draft is the correct snapshot. */
function getServerDraft(): DraftSnapshot {
  return EMPTY_DRAFT;
}

function patchDraft(patch: Partial<DraftSnapshot>): void {
  draftSnapshot = { ...draftSnapshot, ...patch };
  for (const listener of draftListeners) listener();
}

/** Test/teardown hook: dropping the in-memory draft is the only way to clear it. */
export function clearCaptureDraft(): void {
  patchDraft(EMPTY_DRAFT);
}

/* -------------------------------------------------------------------------- */
/* Draft rules (T013-C03/C04/C05)                                             */
/* -------------------------------------------------------------------------- */

export interface CaptureSubmission {
  text: string;
  /** The draft revision that was submitted; see the module comment above. */
  revision: number;
}

/**
 * Apply a confirmed write to the draft.
 *
 * Clears only when the draft is still the exact snapshot that was submitted.
 * "Exact" is decided by the revision counter, not by comparing strings: if the
 * user edits and then types back to identical text, that is still new input and
 * must survive. This is the rule that stops a slow response from erasing the
 * next thought (T013-C03), and it is exposed as a function because a subtle
 * comparison like this is worth asserting directly.
 */
export function applyAcceptedWrite(
  current: { text: string; revision: number },
  submitted: CaptureSubmission,
): { text: string; revision: number; cleared: boolean } {
  if (current.revision !== submitted.revision || current.text !== submitted.text) {
    return { text: current.text, revision: current.revision, cleared: false };
  }
  return { text: '', revision: current.revision, cleared: true };
}

/* -------------------------------------------------------------------------- */

let keyCounter = 0;

/**
 * Generate a capture request id.
 *
 * `crypto.randomUUID` needs a secure context, which http://127.0.0.1 is, but
 * the fallback keeps the hook usable under a plain-http host without throwing.
 */
export function newCaptureRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  keyCounter += 1;
  return `capture-${Date.now().toString(36)}-${keyCounter}`;
}

export function useCapture(options: UseCaptureOptions = {}): UseCaptureApi {
  const draftState = useSyncExternalStore(subscribeDraft, getDraft, getServerDraft);
  const { text: draft, sourceType, sourceRef, inputHint } = draftState;

  const [phase, setPhase] = useState<CapturePhase>('idle');
  const [error, setError] = useState<ApiClientError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CaptureOutcome | null>(null);
  const [organizeOutcome, setOrganizeOutcome] = useState<OrganizeOutcome | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  /** The exact text the server last accepted; null before any successful write. */
  const [lastSubmittedText, setLastSubmittedText] = useState<string | null>(null);

  // The async continuation must read the values as of the submit, not as of the
  // render that created the callback. Refs are written from effects only.
  const snapshotRef = useRef(draftState);
  useEffect(() => {
    snapshotRef.current = draftState;
  }, [draftState]);
  const draftRevisionRef = useRef(draftRevision);
  useEffect(() => {
    draftRevisionRef.current = draftRevision;
  }, [draftRevision]);
  // Read by `submit`, which runs from an event handler and must see the current
  // phase without being re-created on every phase change.
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  /**
   * Update the draft text.
   *
   * Typing the next note also retires the advice about the previous one. The hint
   * is deliberately *not* cleared by a successful save: "保存并整理" without a
   * model writes the hint while the save is still in flight, and the create
   * response arriving afterwards would immediately erase the explanation the user
   * just asked for (T013-R06). The hint describes the last submission, so the
   * right moment to drop it is when a different submission begins — which is here.
   */
  const setDraft = useCallback((value: string) => {
    patchDraft({ text: value });
    setDraftRevision((current) => current + 1);
    if (draftSnapshot.inputHint !== null) patchDraft({ inputHint: null });
  }, []);

  const setSourceType = useCallback((value: CaptureSourceType) => {
    patchDraft({ sourceType: value });
  }, []);

  const setSourceRef = useCallback((value: string) => {
    patchDraft({ sourceRef: value });
  }, []);

  const setInputHint = useCallback((value: string | null) => {
    patchDraft({ inputHint: value });
  }, []);

  /** The submission awaiting a definitive outcome, if any. */
  const pendingRef = useRef<{ key: string; text: string; revision: number } | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const codePoints = codePointLength(draft);
  const overLimit = codePoints > LIMITS.rawTextCodePoints;
  const canSubmit = canSubmitDraft({
    text: draft,
    codePoints,
    limit: LIMITS.rawTextCodePoints,
    saving: phase === 'saving',
  });

  // Registering this while there is unsaved text covers reload/close, the two
  // ways a draft can be lost that the in-memory store cannot prevent.
  useEffect(() => {
    if (!hasUnsavedDraft(draft, lastSubmittedText)) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [draft, lastSubmittedText]);

  const send = useCallback(
    async (key: string, text: string, revision: number, snapshot: DraftSnapshot) => {
      setPhase('saving');
      setError(null);
      setNotice(null);
      setOrganizeOutcome(null);
      const sourceRefValue = snapshot.sourceRef.trim();
      try {
        const result = await apiRequest<CaptureResult>('/api/items', {
          method: 'POST',
          body: {
            captureRequestId: key,
            rawText: text,
            sourceType: snapshot.sourceType,
            sourceRef: sourceRefValue.length > 0 ? sourceRefValue : null,
          },
        });
        if (!mountedRef.current) return;
        pendingRef.current = null;
        // Clear only the exact snapshot that was submitted. Anything typed since
        // carries a higher draft revision and is kept (T025-R05 / T013-C03).
        const applied = applyAcceptedWrite(
          { text: draftSnapshot.text, revision: draftRevisionRef.current },
          { text, revision },
        );
        if (applied.cleared) patchDraft({ text: '', sourceRef: '' });
        setOutcome({ item: result.item, replayed: result.replayed, stored: true });
        setLastSubmittedText(text);
        setPhase('saved');
        setNotice(
          result.replayed ? `这条内容已经${ACTIONS.save}过，未重复创建` : `已${ACTIONS.save}`,
        );
        options.onCreated?.(result);

        // Second step, kept visibly separate: whatever happens here, the record
        // is already stored and the UI keeps saying so.
        if (options.organize) {
          try {
            await options.organize(result.item);
            if (!mountedRef.current) return;
            setOrganizeOutcome({ ok: true, message: `${ACTIONS.organize}完成` });
            patchDraft({ inputHint: null });
          } catch (caught) {
            if (!mountedRef.current) return;
            setOrganizeOutcome({
              ok: false,
              message:
                caught instanceof ApiClientError
                  ? failureKeepingSaved(ACTIONS.organize, caught.message)
                  : failureKeepingSaved(ACTIONS.organize, '未知原因'),
            });
            // T024-R04 / T025-R04: the AI step failed, the note did not. Put that
            // beside the input so it survives navigation, and say what still works.
            patchDraft({
              inputHint: `${ACTIONS.organize}没完成，原文已经${ACTIONS.save}好。你仍可以继续记录、改标签、建立关系；稍后在资料库里重新${ACTIONS.organize}这一条即可。`,
            });
          }
        }
      } catch (caught) {
        if (!mountedRef.current) return;
        if (caught instanceof ApiClientError) {
          setError(caught);
          // A conflict means this key is spent; the next attempt needs a new one.
          if (caught.code === 'CAPTURE_KEY_CONFLICT') pendingRef.current = null;
          // The server may have committed; the user retries the same key.
          setPhase(caught.retryable ? 'unknown' : 'failed');
          // Persisted with the draft so the explanation cannot be lost by
          // navigating away mid-problem (T024-R04).
          patchDraft({
            inputHint: caught.retryable
              ? `这次的${ACTIONS.save}结果还不确定。重试会复用同一次请求，不会重复创建；你也可以先复制文本再离开。`
              : `这次没能${ACTIONS.save}：${caught.message}。文本仍在下面，可以直接重试。`,
          });
          return;
        }
        setError(
          new ApiClientError({
            code: 'INTERNAL',
            message: `${ACTIONS.save}时出现未预期错误`,
            retryable: false,
          }),
        );
        setPhase('failed');
      }
    },
    [options],
  );

  /**
   * The in-flight guard lives here, not only on the disabled button.
   *
   * Ctrl+Enter calls `submit` directly, so a keyboard shortcut could otherwise
   * start a second capture with a fresh key while the first is still saving —
   * producing two records from one thought. Rejecting here keeps the button and
   * the shortcut on one rule.
   */
  const submit = useCallback(async () => {
    const snapshot = snapshotRef.current;
    const text = snapshot.text;
    if (text.trim().length === 0 || codePointLength(text) > LIMITS.rawTextCodePoints) return;
    if (phaseRef.current === 'saving') return;
    const key = newCaptureRequestId();
    const revision = draftRevisionRef.current;
    pendingRef.current = { key, text, revision };
    await send(key, text, revision, snapshot);
  }, [send]);

  const retry = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending) {
      await submit();
      return;
    }
    // The same key and the same text: a replay, not a new record.
    await send(pending.key, pending.text, pending.revision, snapshotRef.current);
  }, [send, submit]);

  const dismissError = useCallback(() => setError(null), []);

  const acknowledge = useCallback(() => {
    setNotice(null);
    setOutcome(null);
    setOrganizeOutcome(null);
    setLastSubmittedText(null);
    setPhase('idle');
    patchDraft({ inputHint: null });
  }, []);

  return {
    draft,
    setDraft,
    sourceType,
    setSourceType,
    sourceRef,
    setSourceRef,
    phase,
    error,
    canSubmit,
    codePoints,
    limit: LIMITS.rawTextCodePoints,
    overLimit,
    outcome,
    organizeOutcome,
    notice,
    inputHint,
    setInputHint,
    submit,
    retry,
    dismissError,
    acknowledge,
  };
}
