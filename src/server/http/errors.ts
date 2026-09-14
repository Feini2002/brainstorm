/**
 * Server-side error plumbing for route handlers (T006-R02, T006-R04).
 *
 * Two jobs:
 *   1. turn a local-guard failure into the contract error code the client
 *      branches on, and
 *   2. log only safe codes and correlation ids — never provider bodies,
 *      Authorization headers or note text (T006-R04).
 */
import 'server-only';

import { AppError, type SafeError } from '@/domain/errors';
import { logSafe } from '@/server/observability/redaction';
import { guardFailureCode, type GuardFailure } from '@/server/security/localGuard';

/** Map a rejected request to the precise contract error code + safe message. */
export function guardError(failure: GuardFailure): AppError {
  const code = guardFailureCode(failure);
  switch (failure) {
    case 'token':
      return new AppError(code, '本地会话已过期，请刷新页面');
    case 'host':
      return new AppError(code, 'Host 不是受信的回环地址');
    case 'origin':
      return new AppError(code, '请求来源不是受信来源');
    case 'cross_site':
      return new AppError(code, '拒绝跨站请求');
    case 'content_type':
      return new AppError('VALIDATION', '请求体必须使用 application/json');
    default: {
      const exhaustive: never = failure;
      return new AppError(code, `请求被拒绝：${String(exhaustive)}`);
    }
  }
}

export class NotImplementedError extends AppError {
  constructor(message = '该能力在本版本未实现') {
    super('INTERNAL', message);
    this.name = 'NotImplementedError';
  }
}

/**
 * Log a failure using only its safe projection. Called once per failed request
 * so every 5xx leaves a traceable requestId without a secret in the log.
 */
export function logRequestFailure(input: {
  requestId: string;
  route: string;
  error: unknown;
  safe: SafeError;
  extra?: Record<string, string | number | boolean | null>;
}): void {
  // Client-caused failures are expected traffic, not incidents.
  const level = input.safe.code === 'INTERNAL' ? 'error' : 'warn';
  logSafe({
    level,
    message: `api ${input.route} ${input.safe.code}`,
    requestId: input.requestId,
    code: input.safe.code,
    retryable: input.safe.retryable,
    ...(input.extra ?? {}),
  });
}
