/**
 * Hashing helpers.
 *
 * SHA-256 over canonical JSON, lowercase hex. The same function is used for
 * capture fingerprints, run input snapshots, view content hashes and import
 * bundle hashes so two layers cannot disagree about "the same content".
 */
import 'server-only';

import { createHash } from 'node:crypto';

import { canonicalJson } from '@/domain/canonicalJson';

export function hashSha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Hash a value after canonicalizing it. */
export function hashCanonical(value: unknown): string {
  return hashSha256(canonicalJson(value));
}
