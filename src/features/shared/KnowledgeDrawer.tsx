'use client';

/**
 * Knowledge detail drawer (T018, T022, T023).
 *
 * One component owns reading, editing, deleting and relating a single record, so
 * the inbox and the library cannot show different versions of the same item. It
 * reads the item by id (so the URL can be shared and reloaded) and keeps the
 * local copy in sync after each successful write.
 *
 * The captured text is always shown verbatim alongside the raw text: an edit can
 * change `rawText`, but the originally captured wording is never lost.
 *
 * `StatusLine` is used instead of one shared `notice` string because save and
 * organize have separate outcomes (T025-R04): reporting "saved" must survive a
 * later failure that only concerns the model.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ItemDTO } from '@/domain/knowledge';
import { ITEM_STATUS_LABELS, ITEM_TYPE_LABELS } from '@/domain/knowledge';
import type { ManualField } from '@/domain/knowledge';
import { runStateLabel } from '@/domain/runDto';
import type { RunResult } from '@/domain/api';
import { Button, InlineError, LoadingIndicator } from '@/components/ui/primitives';
import { ApiClientError, apiRequest } from '@/features/shared/apiClient';
import { DeleteItemDialog } from '@/features/shared/DeleteItemDialog';
import { RelationEditor } from '@/features/shared/RelationEditor';
import { RelationReviewPanel } from '@/features/shared/RelationReviewPanel';
import { SourceReference } from '@/features/shared/SourceReference';
import { StatusLine } from '@/features/shared/MutationStatus';
import { formatTime } from '@/features/shared/formatTime';
import { useRunStatus } from '@/features/shared/useRunStatus';
import { RunDiagnosticsPanel } from '@/features/settings/RunDiagnostics';
import { EditItemForm, type EditPatch } from '@/features/library/EditItemForm';

export interface KnowledgeDrawerProps {
  itemId: string;
  onClose: () => void;
  /** Called after a successful edit or delete so lists can refresh. */
  onChanged?: (change: { id: string; deleted: boolean }) => void;
}

/** How many other records the relation editor offers as endpoints. */
const RELATION_CANDIDATE_LIMIT = 50;

export function KnowledgeDrawer({ itemId, onClose, onChanged }: KnowledgeDrawerProps) {
  const [item, setItem] = useState<ItemDTO | null>(null);
  const [candidates, setCandidates] = useState<ItemDTO[]>([]);
  const [loadError, setLoadError] = useState<ApiClientError | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [relationNotice, setRelationNotice] = useState<string | null>(null);
  const [relationRefresh, setRelationRefresh] = useState(0);
  /**
   * The organize run started from this drawer.
   *
   * Kept here so two things can happen together: the run is watched while it is
   * in flight (T040-R06 — the drawer stays open and the status line reports the
   * real state), and when it settles the record is re-read so the user sees the
   * organized fields without reloading the page.
   */
  const [organizeRunId, setOrganizeRunId] = useState<string | null>(null);
  const [organizing, setOrganizing] = useState(false);
  // Bumped by the retry button; state is only written from the async continuation.
  const [loadToken, setLoadToken] = useState(0);

  const rereadItem = useCallback(async () => {
    const loaded = await apiRequest<ItemDTO>(`/api/items/${itemId}`);
    setItem(loaded);
  }, [itemId]);

  /**
   * One organize attempt, started by the user from the detail drawer.
   *
   * A fresh request key makes this a new paid action; a retry after a failure is
   * therefore deliberate rather than automatic (T035-C05). The drawer does not
   * wait on the response to update its status: the run id comes back first when
   * another call already holds the slot, and `useRunStatus` then reports the real
   * outcome — which is what stops a reload from looking like a lost operation.
   */
  const organize = useCallback(async () => {
    if (!item || organizing) return;
    setOrganizing(true);
    setSaveNotice(null);
    try {
      const result = await apiRequest<RunResult>(`/api/items/${item.id}/organize`, {
        method: 'POST',
        body: { requestKey: crypto.randomUUID(), expectedRevision: item.revision },
      });
      setOrganizeRunId(result.runId);
      if (result.state !== 'running') {
        await rereadItem();
        onChanged?.({ id: item.id, deleted: false });
      }
    } catch (caught) {
      setSaveNotice(
        caught instanceof ApiClientError ? `整理未完成：${caught.message}` : '整理未完成',
      );
    } finally {
      setOrganizing(false);
    }
  }, [item, organizing, onChanged, rereadItem]);

  const runStatus = useRunStatus({
    runId: organizeRunId,
    onSettled: (run) => {
      // Terminal state reached: re-read the record so the organized fields and
      // the derived status on screen match what was actually committed.
      if (run.state === 'succeeded') {
        void rereadItem().then(() => onChanged?.({ id: itemId, deleted: false }));
      }
    },
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await apiRequest<ItemDTO>(`/api/items/${itemId}`);
        if (cancelled) return;
        setItem(loaded);
        setLoadError(null);
      } catch (caught) {
        if (cancelled) return;
        setLoadError(
          caught instanceof ApiClientError
            ? caught
            : new ApiClientError({ code: 'INTERNAL', message: '无法读取这条记录', retryable: true }),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId, loadToken]);

  /**
   * Candidate endpoints for the relation editor.
   *
   * Fetched per drawer instance and kept to one page: the editor's purpose is
   * linking to a note the user has in mind, not browsing the whole library.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await apiRequest<{ items: ItemDTO[] }>('/api/items', {
          query: { limit: RELATION_CANDIDATE_LIMIT, sort: 'newest' },
        });
        if (!cancelled) setCandidates(page.items);
      } catch {
        // A missing candidate list only limits the editor; it must not block
        // reading the record itself.
        if (!cancelled) setCandidates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId, loadToken]);

  // Escape closes the drawer unless a confirmation is open (which handles its own).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !confirmingDelete) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmingDelete, onClose]);

  const submitEdit = useCallback(
    async (patch: EditPatch, options: { unlockFields?: ManualField[] }) => {
      if (!item) return;
      const updated = await apiRequest<ItemDTO>(`/api/items/${item.id}`, {
        method: 'PATCH',
        body: {
          expectedRevision: item.revision,
          patch,
          ...(options.unlockFields ? { unlockFields: options.unlockFields } : {}),
        },
      });
      setItem(updated);
      setEditing(false);
      setSaveNotice('已保存修改');
      onChanged?.({ id: updated.id, deleted: false });
    },
    [item, onChanged],
  );

  const confirmDelete = useCallback(async () => {
    if (!item) return;
    await apiRequest<{ deletedId: string }>(`/api/items/${item.id}`, {
      method: 'DELETE',
      body: { expectedRevision: item.revision },
    });
    onChanged?.({ id: item.id, deleted: true });
    onClose();
  }, [item, onChanged, onClose]);

  const otherCandidates = candidates.filter((entry) => entry.id !== item?.id);

  /**
   * Short name per item id for the relation panel.
   *
   * Built from the candidate page plus the open item; a relation endpoint that
   * is outside that page falls back to a truncated id rather than triggering a
   * request per row.
   */
  const itemLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const candidate of candidates) {
      map.set(
        candidate.id,
        candidate.title.trim() || candidate.capturedText.split('\n')[0]?.slice(0, 16) || candidate.id,
      );
    }
    if (item) {
      map.set(item.id, item.title.trim() || item.capturedText.split('\n')[0]?.slice(0, 16) || item.id);
    }
    return map;
  }, [candidates, item]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" role="presentation">
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        data-testid="knowledge-drawer"
        className="flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-[var(--line)] bg-[var(--surface)] p-4"
      >
        <header className="mb-3 flex items-start justify-between gap-2">
          <h2 id="drawer-title" className="text-base font-semibold text-[var(--ink)]">
            {item ? item.title.trim() || '未命名记录' : '记录详情'}
          </h2>
          <Button variant="ghost" data-testid="drawer-close" onClick={onClose}>
            关闭
          </Button>
        </header>

        {loading ? <LoadingIndicator label="正在读取" /> : null}

        {loadError ? (
          <InlineError message={loadError.message}>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setLoading(true);
                  setLoadToken((value) => value + 1);
                }}
              >
                重新读取
              </Button>
              {loadError.code === 'NOT_FOUND' ? (
                <Button variant="ghost" onClick={onClose}>
                  关闭
                </Button>
              ) : null}
            </div>
          </InlineError>
        ) : null}

        {item && !loading ? (
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-[var(--ink-muted)]">
              <dt>状态</dt>
              <dd className="text-[var(--ink)]">{ITEM_STATUS_LABELS[item.status]}</dd>
              <dt>类型</dt>
              <dd className="text-[var(--ink)]">{ITEM_TYPE_LABELS[item.type]}</dd>
              <dt>版本</dt>
              <dd className="text-[var(--ink)]">revision {item.revision}</dd>
              <dt>创建</dt>
              <dd className="text-[var(--ink)]">{formatTime(item.createdAt).absolute}</dd>
            </dl>

            <section className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold text-[var(--ink)]">原文（保存时的内容）</h3>
              <p className="whitespace-pre-wrap rounded-md border border-[var(--line)] bg-[var(--surface-raised)] p-3 text-sm text-[var(--ink)]">
                {item.capturedText}
              </p>
            </section>

            {item.rawText !== item.capturedText ? (
              <section className="flex flex-col gap-1">
                <h3 className="text-sm font-semibold text-[var(--ink)]">当前原文</h3>
                <p className="whitespace-pre-wrap rounded-md border border-[var(--line)] p-3 text-sm text-[var(--ink)]">
                  {item.rawText}
                </p>
              </section>
            ) : null}

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-[var(--ink)]">来源</h3>
              <SourceReference item={item} />
            </section>

            <RelationReviewPanel
              item={item}
              labels={itemLabels}
              refreshToken={item.revision + relationRefresh}
              {...(onChanged
                ? { onChanged: () => onChanged({ id: item.id, deleted: false }) }
                : {})}
            />

            <StatusLine message={saveNotice} />

            {/*
              The organize action lives here because this is where the user is
              looking at one record and deciding whether it needs the model. While
              the run is in flight the status line reports the *run's* state, not
              a local guess: that is what makes "关掉页面不会自动整理完" honest
              (T040-R06) instead of a spinner that claims progress it cannot see.
            */}
            <section className="flex flex-col gap-2" data-testid="drawer-organize-section">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  data-testid="drawer-organize"
                  disabled={organizing || runStatus.polling}
                  onClick={() => void organize()}
                >
                  {organizing ? '整理中…' : runStatus.polling ? '正在等待模型…' : '用模型整理这一条'}
                </Button>
                {runStatus.run ? (
                  <span className="text-xs text-[var(--ink-muted)]" data-testid="drawer-run-state">
                    运行状态：{runStateLabel(runStatus.run.state)}
                  </span>
                ) : null}
              </div>
              {runStatus.error ? <InlineError message={runStatus.error.message} /> : null}
              {organizeRunId ? <RunDiagnosticsPanel runId={organizeRunId} /> : null}
            </section>

            {editing ? (
              <EditItemForm
                key={`${item.id}-${item.revision}`}
                item={item}
                onSubmit={submitEdit}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    data-testid="drawer-edit"
                    onClick={() => {
                      setSaveNotice(null);
                      setEditing(true);
                    }}
                  >
                    编辑
                  </Button>
                  <Button
                    variant="danger"
                    data-testid="drawer-delete"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    删除
                  </Button>
                </div>

                <RelationEditor
                  source={item}
                  candidates={otherCandidates}
                  onCreated={() => {
                    setRelationNotice('关系已保存');
                    setRelationRefresh((value) => value + 1);
                    onChanged?.({ id: item.id, deleted: false });
                  }}
                />
                <StatusLine message={relationNotice} />
              </div>
            )}
          </div>
        ) : null}
      </aside>

      {confirmingDelete && item ? (
        <DeleteItemDialog
          itemLabel={item.title.trim() || item.capturedText.slice(0, 30)}
          onConfirm={confirmDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      ) : null}
    </div>
  );
}
