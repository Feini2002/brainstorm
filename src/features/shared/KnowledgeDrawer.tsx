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
import { Button, InlineError, LoadingIndicator } from '@/components/ui/primitives';
import { ApiClientError, apiRequest } from '@/features/shared/apiClient';
import { DeleteItemDialog } from '@/features/shared/DeleteItemDialog';
import { RelationEditor } from '@/features/shared/RelationEditor';
import { RelationReviewPanel } from '@/features/shared/RelationReviewPanel';
import { SourceReference } from '@/features/shared/SourceReference';
import { StatusLine } from '@/features/shared/MutationStatus';
import { formatTime } from '@/features/shared/formatTime';
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
  // Bumped by the retry button; state is only written from the async continuation.
  const [loadToken, setLoadToken] = useState(0);

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
