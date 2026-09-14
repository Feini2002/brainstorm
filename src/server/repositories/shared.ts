/**
 * Small shared helpers for repositories.
 */
import 'server-only';

import { AppError } from '@/domain/errors';

export function requireRow<T extends Record<string, unknown>>(
  row: T | undefined,
  what: string,
): T {
  if (!row) throw new AppError('INTERNAL', `数据库未返回预期行：${what}`);
  return row;
}

/** Current timestamp in the ISO form used across the schema. */
export function nowIso(): string {
  return new Date().toISOString();
}
