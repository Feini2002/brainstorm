/**
 * Run lifecycle rules.
 *
 * A run is a ledger entry, not a queue (docs/03_contracts/01_data_contract.md §5).
 * Three independent timing concepts must not be conflated:
 *   - providerCallTimeoutMs: one network wait
 *   - operationDeadlineMs:   the whole operation, including one schema repair
 *   - runLeaseMs:            when a still-"running" row may be recovered
 */
import type { ISODate, RunState } from './knowledge';

export const TERMINAL_RUN_STATES: readonly RunState[] = [
  'succeeded',
  'failed',
  'interrupted',
  'conflict',
];

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

export function addMilliseconds(iso: ISODate, ms: number): ISODate {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/** Lease expiry check used by recovery; takes an injected clock for tests. */
export function isLeaseExpired(deadlineAt: ISODate, now: number): boolean {
  return Date.parse(deadlineAt) <= now;
}

export function remainingOperationTimeMs(
  startedAt: ISODate,
  operationDeadlineMs: number,
  now: number,
): number {
  const elapsed = now - Date.parse(startedAt);
  return operationDeadlineMs - elapsed;
}

/** Per-attempt timeout: never exceeds the remaining absolute operation budget. */
export function attemptTimeoutMs(
  providerCallTimeoutMs: number,
  operationStartedAt: ISODate,
  operationDeadlineMs: number,
  now: number,
): number {
  const remaining = remainingOperationTimeMs(operationStartedAt, operationDeadlineMs, now);
  return Math.max(0, Math.min(providerCallTimeoutMs, remaining));
}

export interface RunAttemptDecision {
  allowed: boolean;
  reason?: 'no_remaining_time' | 'attempt_limit';
}

/**
 * Whether another provider request may start. `attemptCount` is the number of
 * requests already issued; the contract allows at most `maxAttempts` total,
 * and a repair attempt may never be granted once the absolute budget is gone.
 */
export function canStartAttempt(input: {
  attemptCount: number;
  maxAttempts: number;
  operationStartedAt: ISODate;
  operationDeadlineMs: number;
  now: number;
}): RunAttemptDecision {
  if (input.attemptCount >= input.maxAttempts) {
    return { allowed: false, reason: 'attempt_limit' };
  }
  const remaining = remainingOperationTimeMs(
    input.operationStartedAt,
    input.operationDeadlineMs,
    input.now,
  );
  if (remaining <= 0) {
    return { allowed: false, reason: 'no_remaining_time' };
  }
  return { allowed: true };
}

/** Grace period added to the lease before late responses are rejected outright. */
export const LATE_RESPONSE_GRACE_MS = 0;
