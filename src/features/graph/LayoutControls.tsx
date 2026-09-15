'use client';

/**
 * Layout controls (T046-R01).
 *
 * Auto-layout is a button, not an effect. Nothing here runs on render, so a
 * filter change or a title edit can never silently re-run Dagre and throw away
 * the arrangement the user made (T047-R04). The direction switch is a *choice*
 * the user then applies, which is why it is a separate control from the button.
 */
import { Button, Field, Select } from '@/components/ui/primitives';
import type { GraphDirection } from '@/features/graph/types';

export interface LayoutControlsProps {
  direction: GraphDirection;
  onDirectionChange: (next: GraphDirection) => void;
  /** Re-run Dagre over every node. */
  onAutoLayout: () => void;
  /** Layout only the nodes that have no saved position. */
  onLayoutMissing: () => void;
  missingCount: number;
  busy?: boolean;
  /** True when the view has unsaved changes. */
  dirty?: boolean;
  /**
   * False when there is nowhere to persist to (no saved view yet).
   *
   * Without this the save button renders enabled, accepts a click, and returns
   * silently from the hook because `viewId` is null — the worst kind of button,
   * one that appears to work. The page instead asks the user to save a view first.
   */
  canSave?: boolean;
  /** Shown in place of the button's action when `canSave` is false. */
  saveDisabledReason?: string;
  onSave: () => void;
}

export function LayoutControls({
  direction,
  onDirectionChange,
  onAutoLayout,
  onLayoutMissing,
  missingCount,
  busy = false,
  dirty = false,
  canSave = true,
  saveDisabledReason,
  onSave,
}: LayoutControlsProps) {
  return (
    <section
      className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3"
      aria-label="布局"
      data-testid="layout-controls"
    >
      <Field label="布局方向" htmlFor="graph-direction">
        <Select
          id="graph-direction"
          data-testid="graph-direction"
          value={direction}
          disabled={busy}
          onChange={(event) => onDirectionChange(event.target.value as GraphDirection)}
        >
          <option value="TB">从上到下</option>
          <option value="LR">从左到右</option>
        </Select>
      </Field>

      <Button
        variant="secondary"
        data-testid="graph-auto-layout"
        disabled={busy}
        onClick={onAutoLayout}
      >
        自动布局整张图
      </Button>
      {missingCount > 0 ? (
        <Button
          variant="secondary"
          data-testid="graph-layout-missing"
          disabled={busy}
          onClick={onLayoutMissing}
        >
          只排布 {missingCount} 个新节点
        </Button>
      ) : null}

      <Button
        variant="primary"
        data-testid="graph-save-layout"
        disabled={busy || !dirty || !canSave}
        title={canSave ? undefined : saveDisabledReason}
        onClick={onSave}
      >
        {!canSave ? '尚未保存布局' : busy ? '保存中…' : dirty ? '保存布局' : '布局已保存'}
      </Button>
      {!canSave && saveDisabledReason ? (
        <span className="text-xs text-[var(--ink-muted)]" data-testid="graph-save-disabled-hint">
          {saveDisabledReason}
        </span>
      ) : null}
    </section>
  );
}
