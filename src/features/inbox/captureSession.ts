/**
 * Capture request identity that survives a route change.
 *
 * The draft already lives in a module store so switching pages does not erase
 * typed text. The in-flight save must do the same: if the request identity lived
 * only inside a hook, unmounting the inbox would drop the key, skip organize, and
 * let a later retry become a different body. One pending save is enough; this is
 * not a job queue.
 */
import type { ItemDTO } from '@/domain/knowledge';

export type CaptureSourceType = ItemDTO['sourceType'];

export type CaptureMode = 'save' | 'save-and-organize';

export interface FrozenCaptureRequest {
  captureRequestId: string;
  mode: CaptureMode;
  rawText: string;
  sourceType: CaptureSourceType;
  sourceRef: string | null;
  draftRevision: number;
  organizeRequestKey?: string;
}

export interface PendingCapture extends FrozenCaptureRequest {
  /** Present after the create call succeeded; organize must not recreate the note. */
  savedItem?: ItemDTO;
  replayed?: boolean;
}

export interface OrganizeUiOutcome {
  state: 'succeeded' | 'conflict' | 'failed';
  itemId: string;
  message: string;
  code?: string;
  warnings: string[];
}

export function shouldCallOrganize(mode: CaptureMode): boolean {
  return mode === 'save-and-organize';
}

export function freezeCaptureRequest(input: {
  captureRequestId: string;
  mode: CaptureMode;
  rawText: string;
  sourceType: CaptureSourceType;
  sourceRef: string;
  draftRevision: number;
  organizeRequestKey?: string;
}): FrozenCaptureRequest {
  const trimmedRef = input.sourceRef.trim();
  return {
    captureRequestId: input.captureRequestId,
    mode: input.mode,
    rawText: input.rawText,
    sourceType: input.sourceType,
    sourceRef: trimmedRef.length > 0 ? trimmedRef : null,
    draftRevision: input.draftRevision,
    ...(input.mode === 'save-and-organize'
      ? { organizeRequestKey: input.organizeRequestKey }
      : {}),
  };
}

export function organizeConflictMessage(): string {
  return '原文已保存；整理依据已变化，本次未覆盖';
}

let pendingCapture: PendingCapture | null = null;
const pendingListeners = new Set<() => void>();

function notifyPending(): void {
  for (const listener of pendingListeners) listener();
}

export function subscribePendingCapture(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}

export function getPendingCapture(): PendingCapture | null {
  return pendingCapture;
}

export function setPendingCapture(next: PendingCapture | null): void {
  pendingCapture = next;
  notifyPending();
}

export function patchPendingCapture(patch: Partial<PendingCapture>): void {
  if (pendingCapture === null) return;
  pendingCapture = { ...pendingCapture, ...patch };
  notifyPending();
}

/** Test/teardown hook. Production code clears pending after a definitive save. */
export function clearPendingCapture(): void {
  pendingCapture = null;
  notifyPending();
}
