/**
 * Error codes, retryability and HTTP mapping.
 *
 * Single source for reference/contracts/error_codes.json. UI branches on
 * `code`, never on the localized message; `retryable` means "the user may
 * explicitly retry", never "the client retries automatically".
 */

export interface SafeError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  fieldErrors?: Record<string, string[]>;
}

export const ERROR_CODES = {
  VALIDATION: { httpStatus: 400, retryable: false },
  BODY_TOO_LARGE: { httpStatus: 413, retryable: false },
  LOCAL_ORIGIN_REJECTED: { httpStatus: 403, retryable: false },
  SESSION_EXPIRED: { httpStatus: 403, retryable: false },
  NOT_FOUND: { httpStatus: 404, retryable: false },
  REVISION_CONFLICT: { httpStatus: 409, retryable: false },
  CAPTURE_KEY_CONFLICT: { httpStatus: 409, retryable: false },
  RUN_KEY_CONFLICT: { httpStatus: 409, retryable: false },
  RUN_BUSY: { httpStatus: 409, retryable: true },
  MODEL_NOT_CONFIGURED: { httpStatus: 422, retryable: false },
  ENDPOINT_REJECTED: { httpStatus: 422, retryable: false },
  PROVIDER_AUTH: { httpStatus: 502, retryable: false },
  PROVIDER_ENDPOINT: { httpStatus: 502, retryable: false },
  PROVIDER_RATE_LIMIT: { httpStatus: 502, retryable: true },
  PROVIDER_UNAVAILABLE: { httpStatus: 502, retryable: true },
  PROVIDER_NETWORK: { httpStatus: 502, retryable: true },
  PROVIDER_TIMEOUT: { httpStatus: 504, retryable: true },
  PROVIDER_REFUSAL: { httpStatus: 422, retryable: false },
  PROVIDER_TRUNCATED: { httpStatus: 422, retryable: false },
  PROVIDER_PROTOCOL: { httpStatus: 502, retryable: false },
  STRUCTURED_INVALID: { httpStatus: 422, retryable: true },
  SOURCE_CHANGED: { httpStatus: 409, retryable: true },
  RUN_INTERRUPTED: { httpStatus: 409, retryable: true },
  IMPORT_NONEMPTY: { httpStatus: 409, retryable: false },
  IMPORT_INVALID: { httpStatus: 422, retryable: false },
  DATABASE_BUSY: { httpStatus: 409, retryable: true },
  INTERNAL: { httpStatus: 500, retryable: false },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export function isErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, value);
}

export function httpStatusForError(code: ErrorCode): number {
  return ERROR_CODES[code].httpStatus;
}

export function isRetryable(code: ErrorCode): boolean {
  return ERROR_CODES[code].retryable;
}

/**
 * Domain/transport error carrying a contract code. Messages are safe to show to
 * the user: they must never embed API keys, provider bodies or note text.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly fieldErrors?: Record<string, string[]>;

  constructor(code: ErrorCode, message: string, fieldErrors?: Record<string, string[]>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (fieldErrors) this.fieldErrors = fieldErrors;
  }

  toSafeError(): SafeError {
    const safe: SafeError = {
      code: this.code,
      message: this.message,
      retryable: isRetryable(this.code),
    };
    if (this.fieldErrors) safe.fieldErrors = this.fieldErrors;
    return safe;
  }
}

export function notFound(message = '未找到该记录'): AppError {
  return new AppError('NOT_FOUND', message);
}

export function revisionConflict(message = '该记录已被其他窗口更新'): AppError {
  return new AppError('REVISION_CONFLICT', message);
}

export function validationError(
  message = '输入不合法',
  fieldErrors?: Record<string, string[]>,
): AppError {
  return new AppError('VALIDATION', message, fieldErrors);
}

/** Normalize any thrown value into a SafeError without leaking internals. */
export function toSafeError(error: unknown): SafeError {
  if (error instanceof AppError) return error.toSafeError();
  return {
    code: 'INTERNAL',
    message: '本地服务出现未预期错误',
    retryable: false,
  };
}
