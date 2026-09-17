/**
 * Graph read service (T043).
 *
 * Assembles a bounded, dangling-edge-free subgraph from the live knowledge base.
 * The heavy lifting is the pure `buildGraph` in `src/domain/graph.ts`; this module
 * only resolves the filter into real rows and hands the domain function complete
 * data, so a rule like "an edge needs both endpoints in the node set" has exactly
 * one implementation.
 *
 * Three deliberate choices:
 *
 *  1. **A tag filter resolves to item ids in SQL.** Tag membership lives in the
 *     `item_tags` join and `ItemDTO.tags` holds tag *labels*, not tag ids, so the
 *     membership set is read from the mapping table and passed to the domain
 *     function. Comparing a tag UUID against a list of labels is a comparison
 *     that can only ever be false — it silently emptied the graph.
 *  2. **`itemIds` narrows without being required.** An explicit selection is what
 *     a saved View stores, so the read path must accept it, but an absent list
 *     means "everything the filter matches" rather than "nothing".
 *  3. **Freshness is derived here, once.** Relations are read including stale and
 *     rejected rows so the domain filter can decide those questions; the
 *     per-edge classification and the summary come from that same read
 *     (T051-R06), so the notice can never disagree with the edges drawn.
 *
 * Reads only. Nothing here writes, and nothing here can reach an LLM.
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import type { GraphFilter, ItemDTO, RelationDTO, UUID } from '@/domain/knowledge';
import { buildGraph, type GraphReadResponse } from '@/domain/graph';
import { deriveGraphFreshnessFromDto, relationFreshness } from '@/domain/staleness';
import { listItems, listItemsByIds } from '@/server/repositories/items';
import { listRelations } from '@/server/repositories/relations';

export interface GetGraphDataInput {
  filter: GraphFilter;
  /** Explicit node restriction (a saved View's selection), or undefined for all. */
  itemIds?: readonly UUID[];
  /**
   * Saved positions from the View being rendered.
   *
   * Passed through so a node can report whether it already has a coordinate; the
   * read path never invents one (T044-R05).
   */
  positions?: Record<string, { x: number; y: number }>;
}

/**
 * How many items an unfiltered graph read pulls in.
 *
 * The domain function owns the *display* budget (`graphNodes` / `graphEdges`) and
 * reports what it truncated. This read budget sits above it so the counts it
 * reports are the real totals rather than an artefact of the SQL `LIMIT`: reading
 * exactly `graphNodes` rows would make "matched" and "shown" identical and the
 * truncation notice would never fire (T043-R03).
 *
 * Only used when no explicit selection is present; a saved view's ids are read
 * by id and are not subject to this window.
 */
const READ_FLOOR = 500;

export interface GraphRows {
  items: ItemDTO[];
  relations: RelationDTO[];
  /** Ids of items carrying `filter.tagId`, or null when no tag filter is set. */
  tagMemberIds: Set<string> | null;
  /** Items actually read for this query (capped window when no explicit ids). */
  readWindowCount: number;
  /** Full library matches for the current filter, independent of the read window. */
  libraryMatchedCount: number;
}

/** Item ids mapped to a tag, read from `item_tags` rather than from labels. */
export function tagMemberIds(db: DatabaseSync, tagId: UUID): Set<string> {
  const rows = db
    .prepare('SELECT item_id FROM item_tags WHERE tag_id = ?')
    .all(tagId) as { item_id: string }[];
  return new Set(rows.map((row) => String(row.item_id)));
}

/**
 * Read the item and relation rows a graph projection may use.
 *
 * Relations are read *before* the item cap is applied, and with staleness and
 * rejected rows included, because the domain filter decides those questions. A
 * pre-filtered read would make `includeStale: true` silently unobservable, and a
 * stale-count summary computed after the fact would report zero for a query that
 * merely hid the stale edges.
 */
export function readGraphRows(db: DatabaseSync, input: GetGraphDataInput): GraphRows {
  const members = input.filter.tagId ? tagMemberIds(db, input.filter.tagId) : null;

  /**
   * An explicit selection is a set of ids, so it is read by id.
   *
   * Paging with `listItems` and then intersecting the set was a real defect: a
   * saved view whose selection sat past the newest-N window looked as if every
   * selected record had been deleted, and the graph drew an empty canvas for a
   * view that was intact. The schema already bounds the id list, so the read is
   * bounded too — this is not an unbounded query.
   */
  const listed = input.itemIds
    ? null
    : listItems(db, {
        filters: {
          ...(input.filter.type ? { type: input.filter.type } : {}),
          ...(input.filter.tagId ? { tagId: input.filter.tagId } : {}),
        },
        sort: 'newest',
        limit: READ_FLOOR,
        cursor: null,
      });
  const items = input.itemIds ? listItemsByIds(db, input.itemIds) : listed!.items;

  const relations = listRelations(db, {
    includeStale: true,
    includeRejected: true,
  });

  return {
    items,
    relations,
    tagMemberIds: members,
    readWindowCount: items.length,
    libraryMatchedCount: input.itemIds ? items.length : listed!.totalMatched,
  };
}

/**
 * Build the displayable subgraph for one query.
 *
 * The response is the contract's GraphData plus a read-time `freshness` summary
 * and per-edge `freshness`/`hasSavedPosition` flags. All of it is derived from
 * the *same* relation and item read, so the graph a user sees and the counts
 * about it cannot disagree.
 */
export function getGraphData(
  db: DatabaseSync,
  input: GetGraphDataInput,
  datasetRevision: number,
): GraphReadResponse {
  const rows = readGraphRows(db, input);
  const versions = new Map<string, number>(rows.items.map((item) => [item.id, item.rawVersion]));

  /**
   * Only relations this read actually covers.
   *
   * `versions` is built from the items that were read, so classifying a relation
   * whose endpoint is outside that window would ask "is this endpoint's version
   * present?" and answer *no* — which `relationFreshness` reports as `missing`,
   * the classification the UI renders as 「端点已删除」. A record that simply was
   * not part of this read is not deleted, and claiming so is a false statement
   * about the user's data.
   *
   * Scoping the freshness set also makes the summary notice mean what it says:
   * `staleCount` becomes "stale relations *you are looking at*" rather than a
   * count polluted by unrelated notes elsewhere in the library, which is what
   * the 「有 N 条关系…默认隐藏」 line next to the canvas asserts.
   *
   * Deletion still surfaces correctly: `ON DELETE CASCADE` removes a relation
   * with its endpoint, and a relation returned with a dangling endpoint is
   * excluded here, so it never becomes a phantom edge or a false count.
   */
  const coveredRelations = rows.relations.filter(
    (relation) => versions.has(relation.sourceId) && versions.has(relation.targetId),
  );

  const freshness = deriveGraphFreshnessFromDto(coveredRelations, versions);
  const savedPositions = input.positions ?? {};

  const { data } = buildGraph(
    {
      items: rows.items,
      relations: coveredRelations,
      filter: input.filter,
      tagMemberIds: rows.tagMemberIds,
    },
    datasetRevision,
  );

  return {
    ...data,
    nodes: data.nodes.map((node) => ({
      ...node,
      hasSavedPosition: isSavedPosition(savedPositions[node.id]),
    })),
    edges: data.edges.map((edge) => ({
      ...edge,
      freshness: relationFreshness(edge, versions),
    })),
    freshness,
    scope: {
      ...data.scope,
      matchedNodeCount: rows.libraryMatchedCount,
      readWindowCount: rows.readWindowCount,
      libraryMatchedCount: rows.libraryMatchedCount,
    },
  };
}

function isSavedPosition(point: { x: number; y: number } | undefined): boolean {
  return point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y);
}
