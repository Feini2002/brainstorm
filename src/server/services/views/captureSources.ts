/**
 * Source capture for a projection (T054).
 *
 * The browser sends *which* records it wants organised; it never sends the text
 * or the versions. This module re-reads them from the database, so the material
 * a view claims to be based on is the committed state rather than whatever the
 * page happened to be showing (T054-R01, T054-C02). A draft still sitting in an
 * input box is not a confirmed source, and a hostile client cannot substitute
 * one by typing a plausible summary into a request body — there is no field on
 * the request that could carry it.
 *
 * What comes out is the input to everything downstream: the snapshot (what went
 * in, at which versions), the items themselves (for the prompt and for budget
 * measurement), the relations between them, and the budget verdict.
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import type { ItemDTO, SelectionSpec, SourceSnapshot, UUID } from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import { buildSnapshot, checkSourceBudget, type SourceBudgetResult } from '@/domain/sourceSnapshot';
import { listItems, listItemsByIds } from '@/server/repositories/items';
import { listRelations } from '@/server/repositories/relations';

export interface CaptureSourcesInput {
  /** Either an explicit id list or a filter; the caller has already validated it. */
  selection: SelectionSpec;
  /**
   * Measure the prompt that will actually be built, not just the raw text.
   *
   * The prompt builder knows how much envelope it adds (instructions, schema,
   * candidate briefs), and that overhead is real context. Passing the estimate in
   * keeps this module from guessing, while the *decision* stays here so it is one
   * rule rather than one per caller.
   */
  estimateCodePoints?: (items: readonly ItemDTO[]) => number;
}

export interface CapturedSources {
  snapshot: SourceSnapshot;
  /** The items, in the order they were resolved, for the prompt and the budget. */
  items: ItemDTO[];
  /** Relations whose *both* endpoints are in this selection. */
  relations: { id: UUID; sourceId: UUID; targetId: UUID; revision: number }[];
  budget: SourceBudgetResult;
  /** Ids the user asked for that no longer exist, so the UI can say so. */
  missingItemIds: UUID[];
}

/**
 * Resolve a selection to live rows and a snapshot.
 *
 * `missingItemIds` is reported instead of thrown: a selection saved yesterday may
 * legitimately name a record deleted since, and the honest outcome is to generate
 * from what remains *and say what is gone*, not to fail the whole request or to
 * pretend the set is complete.
 */
export function captureSources(db: DatabaseSync, input: CaptureSourcesInput): CapturedSources {
  const { items, missingItemIds } = resolveItems(db, input.selection);

  // Relations are filtered to those *between* the selected items. A relation with
  // one endpoint outside the selection describes material the model was not
  // shown, so claiming the view rests on it would be false provenance.
  const selected = new Set(items.map((item) => item.id));
  const relations = listRelations(db, { includeStale: true, includeRejected: true })
    .filter((relation) => selected.has(relation.sourceId) && selected.has(relation.targetId))
    .map((relation) => ({
      id: relation.id,
      sourceId: relation.sourceId,
      targetId: relation.targetId,
      revision: relation.revision,
    }));

  const snapshot = buildSnapshot(
    items.map((item) => ({
      id: item.id,
      rawVersion: item.rawVersion,
      revision: item.revision,
    })),
    relations.map((relation) => ({ id: relation.id, revision: relation.revision })),
  );

  const estimatedCodePoints =
    input.estimateCodePoints?.(items) ??
    // Without a caller-provided estimator, measure the material alone. This
    // under-counts the envelope but never over-counts, so it cannot reject a
    // request that would have fitted.
    items.reduce((total, item) => total + Array.from(item.rawText).length, 0);

  const budget = checkSourceBudget({
    itemCount: items.length,
    estimatedCodePoints,
  });

  return { snapshot, items, relations, budget, missingItemIds };
}

/**
 * Throw the budget refusal as a user-facing error.
 *
 * Kept separate from `captureSources` so a caller can inspect the budget (the UI
 * wants to show the numbers *before* submitting) and only convert it to a 400 at
 * the boundary where a request is actually refused. The numbers live in the
 * message because that is the part the user acts on: "40 / 40" in a field-error
 * array reads like a form bug, "请减少 3 条" reads like an instruction.
 */
export function assertWithinBudget(budget: SourceBudgetResult): void {
  if (budget.ok) return;
  throw new AppError(
    'VALIDATION',
    `${budget.message ?? '所选材料超出单次整理上限'}（已选 ${budget.itemCount} 条 / 上限 ${LIMITS.selectedItemsPerProjection} 条，约 ${budget.estimatedCodePoints} 字 / 上限 ${LIMITS.outboundContextCodePoints} 字）`,
  );
}

function resolveItems(
  db: DatabaseSync,
  selection: SelectionSpec,
): { items: ItemDTO[]; missingItemIds: UUID[] } {
  if (selection.mode === 'explicit') {
    const requested = [...new Set(selection.itemIds)];
    const items = listItemsByIds(db, requested);
    const found = new Set(items.map((item) => item.id));
    return { items, missingItemIds: requested.filter((id) => !found.has(id)) };
  }

  // A filter selection is resolved *now*, and the resolved ids are then recorded
  // in the snapshot. The filter itself is stored on the view as the description
  // of how the set was chosen, but it is never re-evaluated to change history —
  // a tag gaining members must not silently rewrite yesterday's mindmap
  // (T054-C04).
  const filter = selection.filter;
  const items = listItems(db, {
    filters: {
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.tagId ? { tagId: filter.tagId } : {}),
    },
    sort: 'newest',
    limit: LIMITS.selectedItemsPerProjection,
    cursor: null,
  }).items;
  return { items, missingItemIds: [] };
}
