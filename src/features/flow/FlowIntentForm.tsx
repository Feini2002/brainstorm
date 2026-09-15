'use client';

/**
 * Flow intent form (T062).
 *
 * Three inputs and one button, in the order the decision is actually made:
 *
 *  1. **What to look at.** The intent is a viewing angle, and the hint under the
 *     field says so in Chinese rather than leaving the user to guess — plus the
 *     fact that unsupported links come back as 推测 或 关联, not as proven
 *     causality (T062-R01/R06).
 *  2. **Layout direction.** LR/TB, its own field, with no effect on the material
 *     or on the edge kinds (T062-R05, T062-C04).
 *  3. **The material, confirmed.** The count, the budget, and any difference
 *     between what is ticked and what actually resolves are shown *before* the
 *     send (T062-R04, T062-C05).
 *
 * Two things this component deliberately does not do:
 *
 *  - it does not evaluate the intent, so it cannot promise that the request will
 *    produce a causal edge; the server's evidence threshold decides that, and the
 *    notice says as much (T062-C06);
 *  - it does not post anything. `onSubmit` receives the validated body and the
 *    page owns the request, so typing has no path to the network at all
 *    (T062-C03/R02).
 */
import { useCallback, useMemo, useState } from 'react';

import { Button, Field, InlineError, Select, TextArea } from '@/components/ui/primitives';
import {
  FLOW_DIRECTIONS,
  FLOW_INFERENCE_NOTICE,
  FLOW_INTENT_HINT,
  FLOW_INTENT_PLACEHOLDER,
  buildFlowGenerationRequest,
  type FlowDirection,
  type FlowGenerationRequestContract,
  type FlowIntentErrors,
} from '@/domain/flowIntent';

const DIRECTION_LABELS: Record<FlowDirection, string> = {
  LR: '从左到右（LR）',
  TB: '从上到下（TB）',
};

export interface FlowIntentFormProps {
  /** Ids currently ticked. Counted and sent, never rendered as note text. */
  selectedIds: readonly string[];
  /** Confirmed titles, in resolution order. */
  resolved: { id: string; title: string }[];
  /** Ids ticked but no longer resolvable; reported, not hidden. */
  missingIds: readonly string[];
  /** True while the id list is being re-checked with the server. */
  confirming?: boolean;
  /** True while a generation is in flight, so the button cannot be double-fired. */
  busy?: boolean;
  /** Failure from the server for the last attempt, if any. */
  serverError?: string | null;
  intent: string;
  direction: FlowDirection;
  onIntentChange: (value: string) => void;
  onDirectionChange: (value: FlowDirection) => void;
  /**
   * The page performs the request. `true` means it was accepted and the draft may
   * be considered submitted; `false` keeps the draft and the error on screen.
   */
  onSubmit: (body: FlowGenerationRequestContract) => Promise<boolean>;
}

export function FlowIntentForm({
  selectedIds,
  resolved,
  missingIds,
  confirming = false,
  busy = false,
  serverError = null,
  intent,
  direction,
  onIntentChange,
  onDirectionChange,
  onSubmit,
}: FlowIntentFormProps) {
  const [submitted, setSubmitted] = useState(false);
  const [running, setRunning] = useState(false);
  const [localErrors, setLocalErrors] = useState<FlowIntentErrors>({});

  /**
   * A dry run of the same builder the submit uses, with a fixed placeholder key.
   *
   * It exists so "would this be refused?" is answered while the user types rather
   * than as a 400 afterwards. It is never sent, and the placeholder key is a
   * constant, so this preview cannot collide with the real request key.
   */
  const preview = useMemo(
    () =>
      buildFlowGenerationRequest({
        requestKey: '00000000-0000-4000-8000-000000000000',
        itemIds: selectedIds,
        draft: { intent, direction },
      }),
    [direction, intent, selectedIds],
  );

  const intentError = localErrors.intent;
  const materialError = localErrors.selection;

  const submit = useCallback(async () => {
    setSubmitted(true);
    const built = buildFlowGenerationRequest({
      // Minted per explicit user action: a double click is one request, a retry
      // after a failure is a new one (the server deduplicates on this key).
      requestKey: crypto.randomUUID(),
      itemIds: selectedIds,
      draft: { intent, direction },
    });
    if (!built.ok) {
      setLocalErrors(built.errors);
      return;
    }
    setLocalErrors({});
    setRunning(true);
    try {
      const accepted = await onSubmit(built.body);
      if (accepted) setSubmitted(false);
    } finally {
      setRunning(false);
    }
  }, [direction, intent, onSubmit, selectedIds]);

  const disabled = busy || running || confirming;

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4"
      aria-label="流程观察设置"
      data-testid="flow-intent-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Field label="想从材料里观察什么关系" htmlFor="flow-intent">
        <TextArea
          id="flow-intent"
          data-testid="flow-intent"
          rows={4}
          value={intent}
          placeholder={FLOW_INTENT_PLACEHOLDER}
          onChange={(event) => {
            onIntentChange(event.target.value);
            // Typing invalidates the previous complaint, so a red line never
            // looks like it describes the sentence just typed.
            if (submitted) setLocalErrors((current) => ({ ...current, intent: undefined }));
          }}
        />
      </Field>
      <p className="text-xs text-[var(--ink-muted)]" data-testid="flow-intent-hint">
        {FLOW_INTENT_HINT}
      </p>
      {intentError ? (
        <p role="alert" className="text-xs text-[var(--danger)]" data-testid="flow-intent-error">
          {intentError}
        </p>
      ) : null}

      <Field label="图的走向" htmlFor="flow-direction">
        <Select
          id="flow-direction"
          data-testid="flow-direction"
          value={direction}
          onChange={(event) => onDirectionChange(event.target.value as FlowDirection)}
        >
          {FLOW_DIRECTIONS.map((value) => (
            <option key={value} value={value}>
              {DIRECTION_LABELS[value]}
            </option>
          ))}
        </Select>
      </Field>
      <p className="text-xs text-[var(--ink-muted)]" data-testid="flow-direction-hint">
        走向只影响排版，不改变会被整理的材料，也不会让原本是推测的连接变成因果。
      </p>

      <div
        className="flex flex-col gap-2 rounded-md border border-[var(--line)] bg-[var(--surface-raised)] p-3"
        data-testid="flow-material"
      >
        <p className="text-sm text-[var(--ink)]" data-testid="flow-material-count">
          {confirming
            ? '正在向本地服务核对材料…'
            : `将发送 ${resolved.length > 0 ? resolved.length : selectedIds.length} 条材料（上限 ${
                preview.ok ? preview.body.selection.itemIds.length : selectedIds.length
              } 条已选）`}
        </p>
        {resolved.length > 0 ? (
          <ul className="flex flex-col gap-1" data-testid="flow-material-titles">
            {resolved.slice(0, 8).map((entry) => (
              <li key={entry.id} className="truncate text-xs text-[var(--ink-muted)]">
                {entry.title}
              </li>
            ))}
            {resolved.length > 8 ? (
              <li className="text-xs text-[var(--ink-muted)]">还有 {resolved.length - 8} 条…</li>
            ) : null}
          </ul>
        ) : (
          <p className="text-xs text-[var(--ink-muted)]" data-testid="flow-material-empty">
            还没有核对到材料。先到资料库或收件箱勾选要观察的记录，再点上面的“核对材料”。
          </p>
        )}

        {/*
          A record deleted after it was ticked is reported here. The alternative —
          sending whatever still resolves and saying nothing — is the failure this
          panel exists to prevent (T062-C05).
        */}
        {missingIds.length > 0 ? (
          <p className="text-xs text-[var(--warn-ink)]" data-testid="flow-material-missing">
            有 {missingIds.length} 条已选材料已经被删除，本次不会发送。请核对后再确认新的集合。
          </p>
        ) : null}

        {materialError ? (
          <p role="alert" className="text-xs text-[var(--danger)]" data-testid="flow-material-error">
            {materialError}
          </p>
        ) : null}

        <p className="text-xs text-[var(--ink-muted)]" data-testid="flow-inference-notice">
          {FLOW_INFERENCE_NOTICE}
        </p>
      </div>

      {serverError ? (
        <InlineError message={serverError}>
          <span className="text-xs" data-testid="flow-submit-error-note">
            本次没有保存新的流程视图，已有视图保持原样。
          </span>
        </InlineError>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" data-testid="flow-submit" disabled={disabled}>
          {running ? '正在生成…' : '生成流程图'}
        </Button>
        <span className="text-xs text-[var(--ink-muted)]" data-testid="flow-submit-scope">
          {preview.ok
            ? `本次会发送 ${preview.body.selection.itemIds.length} 条材料与 1 个观察问题`
            : '补齐上面的必填项后即可生成'}
        </span>
      </div>
    </form>
  );
}
