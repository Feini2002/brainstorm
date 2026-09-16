'use client';

/**
 * Mindmap page assembly (T057, T058).
 *
 * T057 owns the renderer and T058 the outline and sources; this page is where
 * they are put on screen together. It follows the graph page's structure
 * deliberately, because the two pages answer the same questions and should not
 * answer them differently:
 *
 *  1. **Open something (T053「保存的视图」).** The newest saved mindmap is adopted
 *     on mount. Showing an empty canvas until the user picks from a dropdown
 *     makes a saved projection look lost.
 *  2. **The view is real but optional.** With no saved mindmap the page explains
 *     what would create one, instead of drawing a fake tree.
 *  3. **Nothing here writes without a click.** Reading a projection never touches
 *     knowledge, and the page issues no model request on navigation (docs/02 §5
 *     「查看历史不会自动产生新模型请求」).
 *  4. **Both halves of the page are present.** Generation (`GenerateMindmapAction`,
 *     T055) acts on the current selection; regeneration (`RegenerateAction`,
 *     T059) acts on an open view. Without the first, the selection tray's
 *     「生成思维导图」 link had nowhere to lead (docs/02 §5 names one shared
 *     `GenerateAction` for both projection pages).
 *
 * Four layout decisions worth stating:
 *
 *  - **The outline is not an alternative to the canvas; it is a peer.** T057-C06
 *    requires that a failed render still shows a readable outline with reachable
 *    sources, so the outline is rendered unconditionally rather than inside the
 *    canvas's success branch.
 *  - **Selecting a node is page state, not renderer state.** The canvas highlights
 *    the selection without rebuilding (`setHighlight`), the outline marks the row,
 *    and both are driven by one id — so the picture and the list cannot disagree
 *    about which node is open.
 *  - **The source panel follows the selection, and defaults to the root.** An empty
 *    panel on open would suggest the map has no sources; the root's subtree sources
 *    are the honest summary of the whole projection.
 *  - **The expand level is applied by remounting.** It is a property of the
 *    transformed tree, not a runtime toggle, so changing it produces a new content
 *    identity — which is also what makes the one-fit-per-mount rule do the right
 *    thing when the user changes it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { MindmapContent, ViewDTO, ViewSummaryDTO } from '@/domain/knowledge';
import { PageHeader } from '@/components/AppShell';
import { Button, EmptyState, Field, LoadingIndicator, Select } from '@/components/ui/primitives';
import { ExportMindmap } from '@/features/mindmap/ExportMindmap';
import { GenerateMindmapAction } from '@/features/mindmap/GenerateMindmapAction';
import { MindmapOutline } from '@/features/mindmap/MindmapOutline';
import { MindmapRenderer } from '@/features/mindmap/MindmapRenderer';
import { RegenerateAction, type RegenerateOutcome } from '@/features/mindmap/RegenerateAction';
import { SourceList } from '@/features/shared/SourceList';
import { DeleteViewDialog } from '@/features/shared/DeleteViewDialog';
import { ViewFreshnessBanner } from '@/features/shared/ViewFreshnessBanner';
import { ApiClientError, apiRequest } from '@/features/shared/apiClient';
import { useApiQuery } from '@/features/shared/useApiQuery';
import { useWorkspace } from '@/features/shared/workspace';
import { formatTime } from '@/features/shared/formatTime';
import type { ViewFreshness } from '@/domain/view';

type ViewState =
  | { status: 'loading' }
  | { status: 'ready'; view: ViewDTO | null; list: ViewSummaryDTO[] };

/** Expand level choices, in the order a reader is likely to want them. */
const EXPAND_CHOICES = [
  { value: '1', label: '只展开主题' },
  { value: '2', label: '展开两层' },
  { value: '3', label: '展开三层' },
  { value: '-1', label: '全部展开' },
] as const;

export default function MindmapPage() {
  const workspace = useWorkspace();
  const selectedIds = workspace.selection.itemIds;
  const [viewState, setViewState] = useState<ViewState>({ status: 'loading' });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [fitToken, setFitToken] = useState(0);
  const [expandLevel, setExpandLevel] = useState(2);
  const [openError, setOpenError] = useState<string | null>(null);
  /** Set while the delete-view confirmation is open (T082-R05, T082-C05). */
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const view = viewState.status === 'ready' ? viewState.view : null;
  const viewList = useMemo(
    () => (viewState.status === 'ready' ? viewState.list : []),
    [viewState],
  );
  const viewReady = viewState.status === 'ready';
  const viewId = view?.id ?? null;

  const content: MindmapContent | null = view?.kind === 'mindmap' ? view.content : null;

  /**
   * Adopt a loaded view.
   *
   * The selection is reset here rather than in an effect on `viewId`: an effect
   * would also fire when the user picks a node and the id unchanged, and it would
   * run *after* the first render of the new content, briefly showing the previous
   * view's node.
   */
  const adoptView = useCallback((next: ViewDTO | null, list: ViewSummaryDTO[]) => {
    setViewState({ status: 'ready', view: next, list });
    setSelectedNodeId(rootIdOf(next));
    setFitToken((value) => value + 1);
  }, []);

  /** Load the newest saved mindmap once, on mount. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await apiRequest<{ views: ViewSummaryDTO[] }>('/api/views', {
          query: { kind: 'mindmap', limit: 50 },
        });
        const first = list.views[0];
        if (!first) {
          if (!cancelled) adoptView(null, []);
          return;
        }
        const loaded = await apiRequest<ViewDTO>(`/api/views/${first.id}`);
        if (!cancelled) adoptView(loaded, list.views);
      } catch {
        // No saved mindmap is a normal state, not an error the user must fix.
        if (!cancelled) adoptView(null, []);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adoptView]);

  const selectView = useCallback(
    (nextId: string | null) => {
      setOpenError(null);
      if (nextId === null) {
        adoptView(null, viewList);
        return;
      }
      void (async () => {
        try {
          const loaded = await apiRequest<ViewDTO>(`/api/views/${nextId}`);
          adoptView(loaded, viewList);
        } catch (caught) {
          setOpenError(
            caught instanceof ApiClientError ? caught.message : '打开这张脑图失败',
          );
        }
      })();
    },
    [adoptView, viewList],
  );

  /**
   * The node whose sources are shown.
   *
   * Falls back to the root so the panel is never empty for a map that does have
   * sources. The lookup is by id, and a stale id (from a view switch) simply
   * yields null rather than throwing.
   */
  const activeNode = useMemo(() => {
    if (!content) return null;
    if (selectedNodeId === null) return null;
    return content.nodes.find((node) => node.id === selectedNodeId) ?? null;
  }, [content, selectedNodeId]);

  /**
   * Freshness is read, never inferred from the DTO.
   *
   * `ViewDTO.isStale` says *that* something moved; this says what, and what
   * regenerating would send. Kept on its own request so opening a view stays one
   * read, and refreshed by `freshnessVersion` after a regeneration rather than by
   * polling.
   */
  const [freshnessVersion, setFreshnessVersion] = useState(0);
  const freshness = useApiQuery<ViewFreshness>(
    viewId === null ? '' : `/api/views/${viewId}/freshness`,
    { enabled: viewId !== null, version: freshnessVersion },
  );
  const [regenerating, setRegenerating] = useState(false);

  /**
   * Regenerate into a *new* view and adopt it.
   *
   * The old view is left untouched by the server; this page then adopts the new
   * one and refreshes the list so both are selectable (T059-R02). The ids sent
   * are the ones the confirmation dialog showed, so the request matches what the
   * user agreed to.
   */
  const regenerate = useCallback(
    async (input: { requestKey: string; itemIds: string[] }): Promise<RegenerateOutcome> => {
      setRegenerating(true);
      try {
        const result = await apiRequest<{
          viewId?: string;
          state: 'succeeded' | 'conflict' | 'failed';
          warnings: string[];
        }>('/api/views/mindmap/generate', {
          method: 'POST',
          body: {
            requestKey: input.requestKey,
            selection: { mode: 'explicit', itemIds: input.itemIds },
          },
        });

        const list = await apiRequest<{ views: ViewSummaryDTO[] }>('/api/views', {
          query: { kind: 'mindmap', limit: 50 },
        });

        if (result.viewId) {
          const loaded = await apiRequest<ViewDTO>(`/api/views/${result.viewId}`);
          adoptView(loaded, list.views);
        } else {
          // A conflict or failure produced no view: keep showing the old one, and
          // refresh the list because the attempt may still have added a run.
          setViewState((current) =>
            current.status === 'ready' ? { status: 'ready', view: current.view, list: list.views } : current,
          );
        }
        setFreshnessVersion((value) => value + 1);

        return {
          viewId: result.viewId ?? null,
          state: result.state,
          warnings: result.warnings,
        };
      } finally {
        setRegenerating(false);
      }
    },
    [adoptView],
  );

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [generateNotices, setGenerateNotices] = useState<string[]>([]);

  /**
   * First generation: build a *new* view from the current selection.
   *
   * Nothing is overwritten — the server inserts a View and this page adopts it,
   * refreshing the list so any earlier map stays selectable next to the new one
   * (T059-R02 applies to the first map for the same reason). A refusal or failure
   * leaves every existing view exactly as it was.
   *
   * The ids come straight from the selection store: no note text is sent, and the
   * server re-reads the material itself, which is what keeps the saved view's
   * provenance trustworthy (T054-R01).
   */
  const generate = useCallback(
    async (itemIds: string[]): Promise<boolean> => {
      setGenerateError(null);
      setGenerateNotices([]);
      setGenerating(true);
      try {
        const result = await apiRequest<{
          viewId?: string;
          state: string;
          warnings: string[];
        }>('/api/views/mindmap/generate', {
          method: 'POST',
          body: {
            // Minted per explicit click: a double click is one request, a retry
            // after a failure is a new one, and the server deduplicates on it.
            requestKey: crypto.randomUUID(),
            selection: { mode: 'explicit', itemIds },
          },
        });

        const list = await apiRequest<{ views: ViewSummaryDTO[] }>('/api/views', {
          query: { kind: 'mindmap', limit: 50 },
        });

        setGenerateNotices([
          result.viewId ? '已经生成脑图。' : '本次没有生成脑图。',
          ...result.warnings,
        ]);

        if (result.viewId) {
          const loaded = await apiRequest<ViewDTO>(`/api/views/${result.viewId}`);
          adoptView(loaded, list.views);
          setFreshnessVersion((value) => value + 1);
        } else {
          // A conflict or failure produced no view: keep showing whatever is open
          // and refresh the list, because the attempt may still have added a run.
          setViewState((current) =>
            current.status === 'ready'
              ? { status: 'ready', view: current.view, list: list.views }
              : current,
          );
        }

        return true;
      } catch (caught) {
        setGenerateError(caught instanceof ApiClientError ? caught.message : '生成脑图失败');
        return false;
      } finally {
        setGenerating(false);
      }
    },
    [adoptView],
  );

  /**
   * Delete the open view — the view only.
   *
   * The server removes the view row and nothing else (T053-R03); this handler
   * then re-reads the list and adopts whatever is newest, rather than leaving a
   * canvas showing a projection that no longer exists. `expectedRevision` is the
   * revision the page displayed, so a change made in another window surfaces as a
   * conflict instead of being discarded.
   */
  const deleteView = useCallback(async () => {
    const target = view;
    if (!target) return;
    await apiRequest<{ deletedId: string }>(`/api/views/${target.id}`, {
      method: 'DELETE',
      body: { expectedRevision: target.revision },
    });
    const list = await apiRequest<{ views: ViewSummaryDTO[] }>('/api/views', {
      query: { kind: 'mindmap', limit: 50 },
    });
    const next = list.views[0];
    if (!next) {
      adoptView(null, []);
    } else {
      const loaded = await apiRequest<ViewDTO>(`/api/views/${next.id}`);
      adoptView(loaded, list.views);
    }
    setConfirmingDelete(false);
  }, [adoptView, view]);

  const loading = !viewReady;

  return (
    <>
      <PageHeader
        title="脑图"
        description="把选中的材料整理成层级脑图；图只是投影，来源始终指向真实记录。"
        actions={
          viewReady && content ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                data-testid="mindmap-fit"
                onClick={() => setFitToken((value) => value + 1)}
              >
                适应窗口
              </Button>
              {/*
                Deleting a *view* sits next to the read controls, not inside the
                canvas: it is about the saved projection, not about the notes, and
                it must stay reachable when the canvas cannot render (T082-R05).
              */}
              <Button
                variant="danger"
                data-testid="mindmap-delete-view"
                onClick={() => setConfirmingDelete(true)}
              >
                删除这张视图
              </Button>
            </div>
          ) : null
        }
      />

      <div className="flex flex-col gap-4">
        <section
          className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3"
          aria-label="读取范围"
          data-testid="mindmap-scope"
        >
          <Field label="已保存的脑图" htmlFor="mindmap-view-select">
            <Select
              id="mindmap-view-select"
              data-testid="mindmap-view-select"
              value={viewId ?? ''}
              disabled={loading}
              onChange={(event) => selectView(event.target.value || null)}
            >
              <option value="">不打开已保存的脑图</option>
              {viewList.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                  {entry.isStale ? '（来源已变化）' : ''}
                </option>
              ))}
            </Select>
          </Field>

          {content ? (
            <Field label="展开层级" htmlFor="mindmap-expand-level">
              <Select
                id="mindmap-expand-level"
                data-testid="mindmap-expand-level"
                value={String(expandLevel)}
                onChange={(event) => setExpandLevel(Number(event.target.value))}
              >
                {EXPAND_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          {view ? (
            <p className="text-xs text-[var(--ink-muted)]" data-testid="mindmap-view-meta">
              生成于 {view.generatedAt ? formatTime(view.generatedAt).absolute : '未知时间'}，
              共 {view.sourceSnapshot.items.length} 条来源。打开不会重新调用模型。
            </p>
          ) : null}
        </section>

        {/*
          The generate half (T055's missing entry point). It sits next to the read
          half rather than after it, because the two answer different questions:
          this one acts on the ids the user just ticked, while the saved list and
          `RegenerateAction` act on a view that already exists. A page that only
          offered the second could not create the first map at all.
        */}
        <GenerateMindmapAction
          selectedIds={selectedIds}
          removedIds={workspace.selection.removedIds}
          busy={generating}
          serverError={generateError}
          notices={generateNotices}
          onGenerate={generate}
        />

        {openError ? (
          <p role="alert" className="text-sm text-[var(--danger)]" data-testid="mindmap-open-error">
            {openError}
          </p>
        ) : null}

        {/*
          Freshness and its regenerate action sit above the map rather than inside
          the canvas: they are about the *projection's* relationship to the
          knowledge base, and they must stay reachable when the canvas itself
          cannot be drawn (T057-C06, T059-C06).
        */}
        {view && freshness.data ? (
          <div className="flex flex-col gap-3">
            <ViewFreshnessBanner
              freshness={freshness.data}
              onOpenItem={(itemId) => workspace.openItem(itemId)}
            />
            <RegenerateAction
              freshness={freshness.data}
              busy={regenerating}
              onRegenerate={regenerate}
            />
            <ExportMindmap viewId={view.id} freshness={freshness.data} />
          </div>
        ) : null}

        {loading ? <LoadingIndicator label="正在读取脑图" /> : null}

        {viewReady && !content ? (
          <EmptyState
            title="还没有可显示的脑图"
            description="脑图由选中的材料生成：在资料库或收件箱勾选要整理的内容，再从选择条进入这里，用上面的「生成脑图」创建第一张。已保存的脑图会一直留在上面这个列表里，随时可以重新打开和导出。"
            action={
              <p className="text-xs text-[var(--ink-muted)]">
                没有模型连接时，已经保存的脑图仍然可以打开、查看来源和导出。
              </p>
            }
          />
        ) : null}

        {content && view ? (
          <>
            {/*
              The canvas and the outline sit side by side on a wide screen and
              stack on a narrow one. The outline is *always* rendered, including
              when the canvas reports an error, because T057-C06 requires the
              sources to stay reachable when the picture cannot be drawn.
            */}
            <div className="flex flex-col gap-4 lg:flex-row">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <MindmapRenderer
                  content={content}
                  initialExpandLevel={expandLevel}
                  selectedNodeId={selectedNodeId}
                  onNodeSelect={setSelectedNodeId}
                  fitToken={fitToken}
                />
              </div>

              <MindmapOutline
                content={content}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
              />
            </div>

            {activeNode ? (
              <SourceList
                itemIds={activeNode.itemIds}
                snapshot={view.sourceSnapshot}
                nodeLabel={activeNode.label}
                onOpenItem={workspace.openItem}
              />
            ) : (
              <p className="text-sm text-[var(--ink-muted)]" data-testid="mindmap-source-hint">
                在大纲或脑图里点一个节点，这里会列出它的来源原文。
              </p>
            )}
          </>
        ) : null}
      </div>

      {confirmingDelete && view ? (
        <DeleteViewDialog
          viewName={view.name}
          kindLabel="脑图"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={deleteView}
        />
      ) : null}
    </>
  );
}

/**
 * The id of the tree's root, or null.
 *
 * The root's own sources are the whole map's sources (validation makes a group's
 * `itemIds` the union of its subtree), so adopting it on open gives the reader the
 * most informative panel without a click.
 */
function rootIdOf(view: ViewDTO | null): string | null {
  if (!view || view.kind !== 'mindmap') return null;
  return view.content.nodes.find((node) => node.parentId === null)?.id ?? null;
}
