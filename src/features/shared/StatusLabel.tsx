'use client';

/**
 * Status and action vocabulary (T082-R01, T082-R02, T082-R03).
 *
 * The state machine was already correct; the *words* were not centralised. Four
 * action verbs were being written independently in each feature — 「保存」「整理」
 * 「生成」「审核」 — and the two failure modes that follow are exactly what T082
 * exists to stop:
 *
 *  - **Drift.** `ITEM_STATUS_LABELS.error` said 「整理失败」 while the capture box
 *    reported an organize failure with its own sentence, and the drawer had a
 *    third. Three strings for one state is three chances to describe a different
 *    event.
 *  - **Overloading one word for two actions.** 「加载中」 was the default label of
 *    every loader on all six pages, so a background refetch of the graph and a
 *    relation review request looked identical to a screen reader.
 *
 * Three rules this module makes mechanical rather than aspirational:
 *
 *  1. **The four actions are named separately (R01).** Saving writes raw text,
 *     organizing asks the model for structured fields, generating creates a
 *     view, reviewing is a human judgement about a relation. Each has one verb
 *     here and no feature file spells its own.
 *  2. **A score is 关联评分 and a stale thing is 依据已变化 (R02).** `score` is
 *     how strongly the model judged two notes related. Calling it 正确率 (or a
 *     stale record 数据损坏) would tell the user something the system does not
 *     know. `describeScore` in `features/graph/badges` already kept the first
 *     half; the words live here now so an export, a badge and an inspector cannot
 *     disagree.
 *  3. **Waiting is not failure, and neither is emptiness (R03).** A loader is
 *     only for "an action is in flight"; empty, absent-relation, no-key and
 *     failed states each get their own sentence. {@link waitingLabel} names the
 *     one action being waited on, so two concurrent requests are distinguishable.
 *
 * Deliberately a client module: it holds JSX for the two status atoms used
 * inside pages, and it must not import the server layer (eslint
 * `feini/features-no-server`).
 */
import type { ReactNode } from 'react';

import type { ItemStatus } from '@/domain/knowledge';

/* -------------------------------------------------------------------------- */
/* R01: the four actions, one verb each                                       */
/* -------------------------------------------------------------------------- */

/**
 * The action nouns/verbs the UI is allowed to use.
 *
 * These are contracts, not decoration: tests reference the same strings, and a
 * second spelling of one of them is how "保存" and "整理" start to mean the same
 * thing again.
 */
export const ACTIONS = {
  /** Raw text is written to the database. Nothing is sent to a model. */
  save: '保存',
  /** The model produces structured fields for an already-saved record. */
  organize: '整理',
  /** A projection (mindmap / flow / graph view) is created from material. */
  generate: '生成',
  /** A human accepts or rejects a relation the model suggested. */
  review: '审核',
} as const;

/** In-flight wording: the named action is running, not finished. */
export function waitingFor(verb: string): string {
  return `正在${verb}…`;
}

/** In-flight wording for one of the four named actions. */
export function waitingLabel(action: keyof typeof ACTIONS): string {
  return waitingFor(ACTIONS[action]);
}

/* -------------------------------------------------------------------------- */
/* R02: score and freshness wording                                           */
/* -------------------------------------------------------------------------- */

/**
 * What `score` is called everywhere.
 *
 * 「关联评分」 states what the number measures — the model's judgement of how
 * strongly two notes relate. 「正确率」 would assert a ground truth the model does
 * not have (docs/03_contracts/01_data_contract.md).
 */
export const SCORE_LABEL = '关联评分';

/** The sentence that stops 0.82 from reading as "82% correct". */
export const SCORE_DISCLAIMER = '模型判断的关联强度，不是正确率';

/** One-line gloss for a score shown alone, without a number. */
export function describeScoreMeaning(input: { origin: 'ai' | 'manual'; score: number | null }): string {
  if (input.origin === 'manual') return '人工建立，没有模型评分';
  if (input.score === null) return '本次模型没有给出评分';
  return `${SCORE_LABEL} ${input.score.toFixed(2)}（${SCORE_DISCLAIMER}）`;
}

/**
 * What a stale record or relation is called.
 *
 * 「依据已变化」 and 「需重新整理」 describe an actionable state: the stored
 * conclusion was drawn from an older raw text. 「数据损坏」 is a different claim —
 * it says the data is broken — and would send the user looking for a bug and,
 * worse, would make them afraid to edit anything (T082-R02).
 */
export const STALE_LABEL = '依据已变化';

/** Short badge form, for a canvas edge or a list row with no space. */
export const STALE_BADGE = '依据已变化';

/** Full sentence for a list with room; names the action that fixes it. */
export const STALE_HINT = '依据已变化，需重新整理';

/** A deleted source is not a version change and must not borrow this wording. */
export const MISSING_SOURCE_LABEL = '来源已删除';

/* -------------------------------------------------------------------------- */
/* R03: waiting, empty, absent, missing-key and failed are five things        */
/* -------------------------------------------------------------------------- */

/**
 * The five situations that used to share 「加载中」 or a generic failure.
 *
 * Each one names what the user should do next, because "something went wrong"
 * and "you have not written anything yet" have different fixes and a user who
 * cannot tell them apart goes hunting for a bug that is not there (T082-R03).
 */
export const EMPTY_STATES = {
  /** No records at all. Capture is still available. */
  noItems: '还没有任何记录。在收件箱写一句就会出现在这里，没有模型也可以保存原文。',
  /** Records exist but none match the current filter or query. */
  noMatches: '没有匹配的记录。换个关键字，或清除筛选条件。',
  /** A record with no relations is a normal, readable state. */
  noRelations: '这条记录还没有关系。可以在详情里建立人工关系，或运行整理让模型给出建议。',
  /** Nothing is selected, so no projection can be generated yet. */
  noSelection: '还没有选中材料。先在资料库或收件箱勾选要整理的内容，再从选择条进入这里。',
} as const;

/**
 * Wording for "the model is not configured yet".
 *
 * The critical half is the second sentence: a missing key must never read as
 * "the app does not work". Capture, search, edit, delete, manual relations and
 * every saved view stay usable (T024-R01, T082-C03).
 */
export const NO_MODEL_HINT =
  '还没有配置模型连接。保存原文、搜索、编辑、删除、人工关系和已保存的视图都不需要模型，照常可用。';

/** What the model is needed *for*, so the prerequisite is stated, not implied. */
export const MODEL_REQUIRED_FOR = '「保存并整理」、生成脑图和生成流程图需要先在设置里配置模型。';

/**
 * A failed follow-up action always says what survived.
 *
 * The pattern is deliberate: state the completed part first, then the failure,
 * then the recovery. A user who reads only the first clause must not conclude
 * that their text was lost (T082-C01). `action` is one of {@link ACTIONS}, so the
 * sentence cannot call a failed organize a failed save.
 */
export function failureKeepingSaved(action: string, reason: string): string {
  return `原文已保存，但${action}没完成：${reason}。原文和已有整理结果都还在，可以稍后重试。`;
}

/* -------------------------------------------------------------------------- */
/* R05: danger actions state their blast radius                               */
/* -------------------------------------------------------------------------- */

/**
 * The three irreversible actions and what each one does *not* touch.
 *
 * A confirmation that only says «确定删除？» makes two very different operations
 * look alike, and the user discovers the difference afterwards (T082-R05).
 * Stating the boundary is what makes the destructive choice informed.
 */
export const DANGER_SCOPE = {
  /** Deleting a knowledge record. */
  deleteItem: '这条记录的原文与整理结果都会被删除，无法撤销。已经保存的视图不会被删除，但会提示依据已变化。',
  /** Deleting a saved view — a different operation from deleting knowledge. */
  deleteView: '只会删除这个视图。知识条目、标签与关系都不受影响，原文仍然在资料库里。',
  /** Removing the stored API key. */
  deleteKey: '只会删除保存的 Key。知识条目、标签、关系和已保存的视图都不受影响，离线记录照常可用。',
  /** Restoring a backup bundle. */
  restore: '只能恢复到空知识库；已经有内容时服务端会直接拒绝，不会合并，也不会覆盖。恢复不触发整理，也不带回 Key。',
} as const;

/* -------------------------------------------------------------------------- */
/* Small presentational atoms                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A state badge: a word, never only a colour (T050-R04, T082-R06).
 *
 * `title` carries the long form so a truncated row still has the full sentence
 * available, and the text is real text rather than a CSS background so it
 * survives greyscale, high contrast and a 150% font scale.
 */
export function StatusBadge({
  label,
  tone = 'muted',
  title,
  testId,
}: {
  label: string;
  tone?: 'muted' | 'warn' | 'danger' | 'success';
  title?: string;
  testId?: string;
}) {
  const toneClass = {
    muted: 'border-[var(--line)] text-[var(--ink-muted)]',
    warn: 'border-[var(--warn)] text-[var(--warn-ink)]',
    danger: 'border-[var(--danger)] text-[var(--danger)]',
    success: 'border-[var(--success)] text-[var(--success)]',
  }[tone];
  return (
    <span
      {...(testId ? { 'data-testid': testId } : {})}
      {...(title ? { title } : {})}
      className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs leading-normal ${toneClass}`}
    >
      {label}
    </span>
  );
}

/**
 * The one loader atom. Every call site must name the action it is waiting on.
 *
 * `label` is required on purpose: a default would let a new call site say
 * 「加载中」 again, which is the ambiguity R03 removes. The ellipsis is added
 * here so "正在搜索" and "正在读取脑图" cannot each decide their own punctuation.
 */
export function WaitingStatus({ label }: { label: string }) {
  return (
    <span role="status" aria-live="polite" className="text-sm text-[var(--ink-muted)]">
      {label}…
    </span>
  );
}

/** Map an item status to the words the rest of the UI uses for it (R01/R02). */
export const ITEM_STATUS_WORDS: Record<ItemStatus, string> = {
  raw: '仅保存（还没整理）',
  processing: '整理中',
  done: '已整理',
  error: '整理失败',
  stale: STALE_LABEL,
};

/** One sentence per status, so a status is never a bare word in a list. */
export function itemStatusExplanation(status: ItemStatus): string {
  switch (status) {
    case 'raw':
      return '原文已经保存，还没有运行整理；现在就可以搜索、编辑和建立人工关系。';
    case 'processing':
      return '整理进行中，可以先去忙别的；结果写入后状态会自己变化。';
    case 'error':
      return '上次整理没有成功，原文仍然保留；可以直接重试整理。';
    case 'stale':
      return '原文改过，当前整理结果基于旧版本；重新整理会更新，旧结果不会被悄悄改写。';
    case 'done':
    default:
      return '整理结果对应当前原文。';
  }
}

/** Convenience wrapper so a caller can render an explanation in one line. */
export function StatusExplanation({ status }: { status: ItemStatus }): ReactNode {
  return <span className="text-xs text-[var(--ink-muted)]">{itemStatusExplanation(status)}</span>;
}
