/**
 * Candidate retrieval service (T034).
 *
 * Two independent channels, merged and de-duplicated by item id:
 *
 *   - **recency** — the 12 most recent *other* items, so freshly captured
 *     material always gets compared;
 *   - **lexical**  — literal matches on title / summary / rawText / tags, which is
 *     what lets a three-month-old note resurface when it shares a real term.
 *
 * The declared limitation matters as much as the algorithm: this is literal
 * recall, not semantic search. Material that says the same thing in different
 * words will be missed, and the UI copy says so rather than implying otherwise
 * (T034-C06). No LLM is called and nothing is written.
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import { LIMITS } from '@/domain/limits';
import {
  RETRIEVAL_VERSION,
  buildCandidateBrief,
  buildQueryTerms,
  escapeLikePattern,
  orderedTerms,
  scoreCandidate,
  sortCandidates,
  type CandidateBrief,
  type QueryTerms,
} from '@/domain/candidates';
import type { UUID } from '@/domain/knowledge';
import { getItem, listItems } from '@/server/repositories/items';
import { ITEM_COLUMNS } from '@/server/repositories/mappers';

export interface CandidateSearchResult {
  retrievalVersion: string;
  candidates: CandidateBrief[];
  /** Ids in send order; recorded on the run for traceability. */
  candidateIds: UUID[];
  /** Reasons the literal channel was thin, for the user-facing explanation. */
  notes: string[];
  /** Code points of all briefs combined, for the outbound budget check. */
  totalCodePoints: number;
}

interface ScoredRow {
  id: UUID;
  score: number;
  updatedAt: string;
  reason: string;
}

/**
 * The recency channel: newest first, excluding the target itself.
 *
 * `listItems` is reused rather than hand-written SQL so the tag join and column
 * set cannot drift from the library list.
 */
function recentCandidates(db: DatabaseSync, targetId: UUID, limit: number): ScoredRow[] {
  const page = listItems(db, {
    filters: {},
    sort: 'newest',
    limit: limit + 1,
    cursor: null,
  });
  const rows: ScoredRow[] = [];
  for (const item of page.items) {
    if (item.id === targetId) continue;
    rows.push({
      id: item.id,
      score: 0,
      updatedAt: item.updatedAt,
      reason: '最近保存的资料',
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

/**
 * The literal channel.
 *
 * One parameterised `LIKE` per query term over title, summary, rawText and the
 * tag labels; `%` and `_` in a term are escaped so a user search for "50%"
 * matches literally instead of matching everything. Hits are counted per term
 * (capped per term) and then scored by channel in the domain module.
 */
function lexicalCandidates(
  db: DatabaseSync,
  targetId: UUID,
  terms: QueryTerms,
): ScoredRow[] {
  const ordered = orderedTerms(terms);
  if (ordered.length === 0) return [];

  const hits = new Map<UUID, { row: Record<string, unknown>; tags: string[]; matches: number }>();

  for (const term of ordered) {
    const pattern = `%${escapeLikePattern(term)}%`;
    const rows = db
      .prepare(
        `SELECT ${ITEM_COLUMNS},
                (SELECT json_group_array(t.label)
                   FROM (SELECT t.label AS label
                           FROM item_tags it JOIN tags t ON t.id = it.tag_id
                          WHERE it.item_id = knowledge_items.id
                          ORDER BY it.position) AS t) AS tags_json,
                0 AS __unused
           FROM knowledge_items
          WHERE knowledge_items.id <> ?
            AND (
              knowledge_items.title LIKE ? ESCAPE '\\'
              OR knowledge_items.summary LIKE ? ESCAPE '\\'
              OR knowledge_items.raw_text LIKE ? ESCAPE '\\'
              OR EXISTS (
                SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id
                 WHERE it.item_id = knowledge_items.id AND t.normalized LIKE ? ESCAPE '\\'
              )
            )
          ORDER BY knowledge_items.updated_at DESC, knowledge_items.id DESC
          LIMIT ?`,
      )
      .all(
        targetId,
        pattern,
        pattern,
        pattern,
        pattern,
        LIMITS.literalHitsPerTerm,
      ) as Record<string, unknown>[];

    for (const row of rows) {
      const id = String(row.id);
      if (id === targetId) continue;
      const existing = hits.get(id);
      if (existing) {
        existing.matches += 1;
        continue;
      }
      hits.set(id, {
        row,
        tags: parseTagsJson(row.tags_json),
        matches: 1,
      });
    }
  }

  const scored: ScoredRow[] = [];
  for (const [id, entry] of hits) {
    const item = entry.row;
    const { score } = scoreCandidate({
      terms,
      tags: entry.tags,
      title: String(item.title ?? ''),
      summary: String(item.summary ?? ''),
      rawText: String(item.raw_text ?? ''),
    });
    // No channel hit at all means the row matched only through a term the
    // scorer does not weigh; keep it, but behind everything that scored.
    scored.push({
      id,
      score,
      updatedAt: String(item.updated_at ?? ''),
      reason: `字面命中 ${entry.matches} 个查询词`,
    });
  }

  return scored;
}

function parseTagsJson(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

/**
 * Build the candidate set for one organize run.
 *
 * Ordering is deterministic for identical input and library state: recency first
 * in recency order, then lexical results by score, `updatedAt`, and id. Two runs
 * over the same data therefore produce the same candidate hash (T034-R04).
 */
export function findCandidates(db: DatabaseSync, targetId: UUID): CandidateSearchResult {
  const target = getItem(db, targetId);

  const terms = buildQueryTerms({
    title: target.title,
    keywords: target.keywords,
    tags: target.tags,
    rawText: target.rawText,
  });
  const notes: string[] = [];

  const recent = recentCandidates(db, targetId, LIMITS.recentCandidateCount);
  const lexical = lexicalCandidates(db, targetId, terms);

  const merged = new Map<UUID, ScoredRow>();
  for (const entry of recent) merged.set(entry.id, entry);
  for (const entry of lexical) {
    const existing = merged.get(entry.id);
    if (existing) {
      // Same item found by both channels: keep the more specific reason, and
      // remember it so the ordering step treats it as a recency hit too.
      existing.score = Math.max(existing.score, entry.score);
      existing.reason = `${existing.reason}；${entry.reason}`;
      continue;
    }
    merged.set(entry.id, entry);
  }

  const recentIds = recent.map((entry) => entry.id);
  const ordered = sortCandidates(
    [...merged.values()].map((entry) => ({
      id: entry.id,
      score: entry.score,
      updatedAt: entry.updatedAt,
    })),
    recentIds,
  ).slice(0, LIMITS.candidateCount);

  if (terms.phrases.length === 0 && terms.words.length === 0 && terms.bigrams.length === 0) {
    notes.push('原文太短，没有提取到可检索的词，本次只比较了最近的资料。');
  }
  if (ordered.every((entry) => recentIds.includes(entry.id))) {
    notes.push('没有找到字面相关的旧资料，本次只比较了最近的资料。');
  }

  const briefs: CandidateBrief[] = [];
  for (const entry of ordered) {
    const source = merged.get(entry.id);
    if (!source) continue;
    const item = getItem(db, entry.id);
    briefs.push(
      buildCandidateBrief(
        {
          id: item.id,
          title: item.title,
          summary: item.summary,
          tags: item.tags,
          rawText: item.rawText,
          updatedAt: item.updatedAt,
        },
        terms,
        source.reason,
      ),
    );
  }

  return {
    retrievalVersion: RETRIEVAL_VERSION,
    candidates: briefs,
    candidateIds: briefs.map((brief) => brief.id),
    notes,
    totalCodePoints: briefs.reduce(
      (total, brief) =>
        total +
        Array.from(brief.title).length +
        Array.from(brief.summary).length +
        brief.tags.reduce((sum, tag) => sum + Array.from(tag).length, 0) +
        brief.evidenceSnippets.reduce((sum, snippet) => sum + Array.from(snippet.text).length, 0),
      0,
    ),
  };
}
