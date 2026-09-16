'use client';

/**
 * First generation of a mindmap from the current selection (T055 entry point).
 *
 * The mindmap page reads saved projections, and T059 owns *re*generating them.
 * Neither one can create the first map: `RegenerateAction` only appears next to a
 * saved view, so before this component existed the selection tray's
 * 「生成思维导图」 link led to a page with no way to act on the material it
 * carried. `docs/02_architecture/03_ui_information_design.md` §5 names the
 * missing half explicitly — both projection pages share a `GenerateAction`; this
 * is the mindmap one.
 *
 * Three things it deliberately does:
 *
 *  1. **States the scope before sending.** The count, the budget and the fact
 *     that a ticked record was deleted are shown here, because those are the
 *     cases where the map would rest on less than the user believes
 *     (T021-C03/C04, T054-C06).
 *  2. **Refuses rather than widens.** An empty or over-budget selection, or one
 *     holding an id already known to be deleted, disables the button and says
 *     why. It never drops an id and sends the rest silently.
 *  3. **Owns no request.** `onGenerate` receives the ids and the page performs
 *     the call, so nothing here can write a View or reach the model on its own.
 */
import { useCallback, useState } from 'react';

import { Button, InlineError } from '@/components/ui/primitives';
import { LIMITS } from '@/domain/limits';

export interface GenerateMindmapActionProps {
  /** Ids currently ticked; the only thing this component contributes to a request. */
  selectedIds: readonly string[];
  /**
   * Ids dropped because their record no longer exists.
   *
   * Generation is refused while this is non-empty: the server would report the
   * missing ids as a warning, but the user should confirm the shrunken set
   * *before* a paid call is built from it rather than read it afterwards.
   */
  removedIds: readonly string[];
  /** True while any generation is in flight, so the button cannot be double-fired. */
  busy?: boolean;
  /** Failure from the server for the last attempt, if any. */
  serverError?: string | null;
  /** What the server said about the run that just finished. */
  notices?: readonly string[];
  /**
   * The page performs the request. `true` means a new view was produced or the
   * outcome was reported; the draft is then considered spent.
   */
  onGenerate: (itemIds: string[]) => Promise<boolean>;
}

export function GenerateMindmapAction({
  selectedIds,
  removedIds,
  busy = false,
  serverError = null,
  notices = [],
  onGenerate,
}: GenerateMindmapActionProps) {
  const [running, setRunning] = useState(false);

  const limit = LIMITS.selectedItemsPerProjection;
  const count = selectedIds.length;
  const overBudget = count > limit;

  /**
   * Why the button is unavailable, or null when it is ready.
   *
   * Rendered as text next to the button rather than only disabling it: a greyed
   * control with no reason is the same dead end this component was added to fix.
   */
  const blockedReason =
    count === 0
      ? '还没有选中材料。先在资料库或收件箱勾选要整理的内容，选择条会把你带到这一页。'
      : overBudget
        ? `一次最多整理 ${limit} 条材料，当前选中 ${count} 条，请减少 ${count - limit} 条。`
        : removedIds.length > 0
          ? `有 ${removedIds.length} 条已选材料已经被删除，请先确认新的材料集合再生成。`
          : null;

  const start = useCallback(async () => {
    // The guards are re-checked at the click, not only at render: a selection can
    // change between the two, and a `disabled` attribute is a hint to the user,
    // not a constraint on the caller.
    if (blockedReason !== null) return;
    setRunning(true);
    try {
      await onGenerate([...selectedIds]);
    } finally {
      setRunning(false);
    }
  }, [blockedReason, onGenerate, selectedIds]);

  const disabled = busy || running || blockedReason !== null;

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3"
      aria-label="生成脑图"
      data-testid="mindmap-generate-section"
    >
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-[var(--ink)]" data-testid="mindmap-generate-count">
          {count === 0 ? '当前没有选中材料' : `已选 ${count} / ${limit} 条材料`}
        </p>
        <Button
          data-testid="mindmap-generate"
          disabled={disabled}
          onClick={() => void start()}
        >
          {running ? '正在生成…' : '生成脑图'}
        </Button>
        <span className="text-xs text-[var(--ink-muted)]" data-testid="mindmap-generate-scope">
          {blockedReason === null
            ? `本次会发送 ${count} 条材料，图只是投影，来源始终指向真实记录`
            : '补齐上面的材料后即可生成'}
        </span>
      </div>

      {blockedReason !== null ? (
        <p className="text-xs text-[var(--warn-ink)]" data-testid="mindmap-generate-blocked">
          {blockedReason}
        </p>
      ) : null}

      {serverError ? (
        <InlineError message={serverError}>
          <span className="text-xs" data-testid="mindmap-generate-error-note">
            本次没有保存新的脑图，已有脑图保持原样。
          </span>
        </InlineError>
      ) : null}

      {notices.length > 0 ? (
        <div className="flex flex-col gap-1 text-xs" data-testid="mindmap-generate-outcome">
          {notices.map((notice) => (
            <p key={notice} className="text-[var(--ink)]">
              {notice}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
