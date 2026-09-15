/**
 * `POST /api/import/validate` service (T071).
 *
 * The whole job is to answer "would this file restore?" without changing
 * anything (R05). Two consequences shape the code:
 *
 *   - Reading the target library is the *only* database access, and it is
 *     strictly a count query. There is no insert, no delete, no `PRAGMA` that
 *     could touch data, so "validation does not write" is a property of the
 *     statement set rather than a promise about control flow.
 *   - A validation that passes is **not** permission to commit. The report
 *     carries the bundle hash so the caller can prove it is committing the same
 *     bytes later, and `importKnowledge` re-runs every check (R06/R01).
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import {
  EMPTY_TARGET,
  isTargetEmpty,
  targetProblems,
  validateBundle,
  type ImportValidationReport,
  type TargetLibraryState,
} from '@/domain/importBundle';

/** Count knowledge entities; deliberately no content is read. */
export function readTargetState(db: DatabaseSync): TargetLibraryState {
  const count = (table: string): number => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
    return row?.n ?? 0;
  };

  return {
    items: count('knowledge_items'),
    relations: count('relations'),
    views: count('views'),
    tags: count('tags'),
    itemTags: count('item_tags'),
  };
}

/**
 * Validate a bundle against the contract and the target library.
 *
 * Never throws for a bad file: the UI needs a body it can render for an invalid
 * backup, and an invalid backup is an expected outcome rather than a server
 * error. Genuine failures (an unreadable database) still throw.
 */
export function validateImport(db: DatabaseSync, rawBundle: unknown): ImportValidationReport {
  const report = validateBundle(rawBundle);
  const target = readTargetState(db);

  if (isTargetEmpty(target)) return report;

  // Reported alongside structural errors rather than instead of them: a user
  // fixing their file should see both problems in one pass instead of
  // rediscovering the target restriction after each fix.
  return {
    ...report,
    valid: false,
    errors: [...report.errors, ...targetProblems(target)],
  };
}

export { EMPTY_TARGET };
