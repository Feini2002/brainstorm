/**
 * Hashing helpers.
 *
 * SHA-256 over canonical JSON, lowercase hex. The same function is used for
 * capture fingerprints, run input snapshots, view content hashes and import
 * bundle hashes so two layers cannot disagree about "the same content".
 *
 * The implementation is `domain/hash.ts`; this module exists so server code can
 * keep importing a `server-only`-guarded path. Two copies of the algorithm would
 * be two things that could drift, and a silently different hash is exactly the
 * failure a content hash is supposed to prevent.
 */
import 'server-only';

export { hashCanonical, hashSha256 } from '@/domain/hash';
