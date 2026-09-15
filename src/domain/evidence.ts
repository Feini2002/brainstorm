/**
 * Evidence verification for AI relations (T039).
 *
 * The check performed here is exactly one thing, and it is deliberately not
 * overstated: **the quote must appear verbatim in the sender's current raw
 * text**. That proves a citation exists. It does *not* prove the relation is
 * semantically true — two real sentences can still be joined by a wrong causal
 * claim, and the contract says so explicitly (docs/03_contracts/08 §3). Which is
 * why a passing relation is still only `suggested` and still needs review.
 *
 * Three details that are easy to get wrong:
 *   - the quote is matched against the *code point* content of rawText, and the
 *     version recorded is the server's own `rawVersion`, never the model's claim;
 *   - for a symmetric type whose endpoints are swapped, the evidence map must be
 *     swapped too, or the source version would be attached to the target quote
 *     (T039-R04);
 *   - a relation below the score floor is dropped, and the floor is described as
 *     a noise gate, not a probability of correctness (T039-R02).
 */
import type { Evidence, RelationType, UUID } from './knowledge';
import { isSymmetricRelationType } from './knowledge';
import { LIMITS } from './limits';

export interface RawEvidenceInput {
  itemId: string;
  quote: string;
}

export interface EndpointVersions {
  sourceId: UUID;
  targetId: UUID;
  sourceRawVersion: number;
  targetRawVersion: number;
}

export type EvidenceRejection =
  | 'quote_not_found'
  | 'quote_empty'
  | 'unknown_item'
  | 'wrong_endpoint';

/**
 * A discriminated result rather than `{ok, evidence?, rejection?}`.
 *
 * The failure branch carries no `evidence` field at all, so a caller cannot read
 * a half-filled quote list and store it. A relation is either fully verified or
 * it is dropped with a reason; there is no partial state to misuse.
 */
export type EvidenceVerification =
  | { ok: true; evidence: Evidence[] }
  | { ok: false; rejection: EvidenceRejection; detail: string };

/**
 * Verify quotes against live raw text.
 *
 * `liveRawText` must be keyed by item id and carry the text as read in the same
 * transaction as the version check; passing stale text here would let an edited
 * note keep a citation it no longer contains.
 */
export function verifyEvidence(
  quotes: readonly RawEvidenceInput[],
  liveRawText: ReadonlyMap<UUID, string>,
  endpoints: EndpointVersions,
): EvidenceVerification {
  if (quotes.length === 0) {
    return { ok: false, rejection: 'quote_empty', detail: '关系缺少证据引用' };
  }

  const evidence: Evidence[] = [];
  for (const quote of quotes) {
    if (quote.quote.trim().length === 0) {
      return { ok: false, rejection: 'quote_empty', detail: '引用为空' };
    }
    if (Array.from(quote.quote).length > LIMITS.evidenceQuoteCodePoints) {
      return { ok: false, rejection: 'quote_not_found', detail: '引用超过长度上限' };
    }

    const text = liveRawText.get(quote.itemId);
    if (text === undefined) {
      return { ok: false, rejection: 'unknown_item', detail: '引用指向未发送的条目' };
    }
    if (!text.includes(quote.quote)) {
      // The failure mode this catches is a paraphrase or an invented sentence.
      return {
        ok: false,
        rejection: 'quote_not_found',
        detail: '引用的文字没有逐字出现在该条原文里',
      };
    }
    if (quote.itemId !== endpoints.sourceId && quote.itemId !== endpoints.targetId) {
      return { ok: false, rejection: 'wrong_endpoint', detail: '引用不属于这条关系的两端' };
    }

    evidence.push({
      itemId: quote.itemId,
      // The server's version, never a value supplied by the model.
      rawVersion:
        quote.itemId === endpoints.sourceId
          ? endpoints.sourceRawVersion
          : endpoints.targetRawVersion,
      quote: quote.quote,
    });
  }

  return { ok: true, evidence };
}

/**
 * Canonicalize endpoints and their evidence together.
 *
 * For symmetric types the stored row orders endpoints by id. The *evidence* is
 * not symmetric: each quote belongs to one specific item, so reordering the
 * endpoints without reordering the versions would attach the wrong raw version
 * to a quote. Both move as one unit (T039-R04).
 */
export interface NormalizedRelation {
  sourceId: UUID;
  targetId: UUID;
  sourceRawVersion: number;
  targetRawVersion: number;
  evidence: Evidence[];
  swapped: boolean;
}

export function normalizeRelationWithEvidence(
  type: RelationType,
  input: EndpointVersions,
  evidence: readonly Evidence[],
): NormalizedRelation {
  if (!isSymmetricRelationType(type)) {
    return { ...input, evidence: [...evidence], swapped: false };
  }

  const needsSwap = input.sourceId > input.targetId;
  if (!needsSwap) {
    return { ...input, evidence: [...evidence], swapped: false };
  }

  return {
    sourceId: input.targetId,
    targetId: input.sourceId,
    sourceRawVersion: input.targetRawVersion,
    targetRawVersion: input.sourceRawVersion,
    // Evidence keeps its own itemId; its rawVersion must follow the item, which
    // it already does because it was attached by itemId above.
    evidence: [...evidence],
    swapped: true,
  };
}

/** `score` gate. Below the floor the suggestion is dropped, not downgraded. */
export function meetsScoreFloor(score: number | null): boolean {
  if (score === null) return false;
  return score >= LIMITS.relationScoreFloor;
}

/** Human-readable reason for a dropped relation, suitable for a warning list. */
export function describeRejection(rejection: EvidenceRejection): string {
  switch (rejection) {
    case 'quote_not_found':
      return '引用无法在原文中逐字找到';
    case 'quote_empty':
      return '缺少引用';
    case 'unknown_item':
      return '引用了本次没有发送的条目';
    case 'wrong_endpoint':
      return '引用不属于这条关系的两端';
    default:
      return '证据未通过校验';
  }
}
