'use client';

/**
 * Relation graph page (T043–T052).
 *
 * Assembly order, and why it is this order:
 *
 *   1. Read the saved view, adopt its scope and its stored layout.
 *   2. Read the subgraph (T043) with that scope applied.
 *   3. Render the canvas, filters, summary and inspector.
 *
 * Two pieces of state are *derived* rather than synchronized, and both for the
 * same reason — an effect that copies server data into local state re-runs on
 * every identity change and can overwrite what the user just did:
 *
 *   - the effective filter is "the user's edit for this view, else the view's own
 *     filter, else the default";
 *   - the layout baseline is adopted inside the async load path, so no render can
 *     observe a loaded view together with an un-adopted baseline.
 *
 * A view is real but optional: with no saved view the page still reads and draws
 * the graph from live knowledge. In that state the layout is honestly described as
 * unsaved and the save control says what to do about it, instead of appearing to
 * work and doing nothing.
 */
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { GraphFilter, TagDTO, ViewDTO } from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import { PageHeader } from '@/components/AppShell';
import { Button, Field, LoadingIndicator, SectionCard, Select } from '@/components/ui/primitives';
import { apiRequest } from '@/features/shared/apiClient';
import { DeleteViewDialog } from '@/features/shared/DeleteViewDialog';
import { useWorkspace } from '@/features/shared/workspace';
import { GraphFilters } from '@/features/graph/GraphFilters';
import { GraphInspector } from '@/features/graph/GraphInspector';
import { GraphLoadError, GraphNoData } from '@/features/graph/GraphEmptyState';
import { GraphSummary } from '@/features/graph/GraphSummary';
import { LayoutControls } from '@/features/graph/LayoutControls';
import { toFlowGraph } from '@/features/graph/graphAdapter';
import { layoutGraph } from '@/features/graph/layoutGraph';
import { useGraphQuery } from '@/features/graph/useGraphQuery';
import { useLayoutPersistence } from '@/features/graph/useLayoutPersistence';
import type { GraphDirection } from '@/features/graph/types';

/**
 * The canvas is client-only and loaded lazily (T045-R01): React Flow touches
 * `window` during render, so a static import would drag the library into the
 * server bundle and fail to prerender.
 */
const KnowledgeGraph = dynamic(
  () => import('@/features/graph/KnowledgeGraph').then((module) => module.KnowledgeGraph),
  {
    ssr: false,
    loading: () => <LoadingIndicator label="正在加载关系图画布" />,
  },
);

const EMPTY_FILTER: GraphFilter = { reviewStatuses: ['accepted', 'suggested'] };

/**
 * True when the user has actually narrowed something.
 *
 * `reviewStatuses` is present in the default filter, so its mere existence says
 * nothing; only a tag, a type, a raised score or an explicit stale toggle means
 * the result was filtered rather than the library being empty.
 */
function hasActiveFilter(filter: GraphFilter): boolean {
  return (
    filter.tagId !== undefined ||
    filter.type !== undefined ||
    (filter.minimumScore !== undefined && filter.minimumScore > 0) ||
    filter.includeStale === true
  );
}

interface ViewListItem {
  id: string;
  name: string;
  revision: number;
  kind: string;
}

/** The layout a canvas may adopt: positions, direction and the revision they came from. */
interface LayoutBaseline {
  positions: Record<string, { x: number; y: number }>;
  direction: GraphDirection;
  revision: number | null;
}

const NO_BASELINE: LayoutBaseline = { positions: {}, direction: 'TB', revision: null };

function baselineOf(view: ViewDTO | null): LayoutBaseline {
  if (!view || view.kind !== 'graph') return NO_BASELINE;
  return {
    positions: view.content.positions,
    direction: view.content.direction,
    revision: view.revision,
  };
}

/** The filter a saved view was built from; null when it saved an explicit selection. */
function filterOf(view: ViewDTO | null): GraphFilter | null {
  if (!view || view.kind !== 'graph') return null;
  if (view.selection.mode !== 'filter') return null;
  return view.selection.filter ?? EMPTY_FILTER;
}

/**
 * The filter the user last chose *for a specific view*.
 *
 * Carrying the view id alongside the filter is what makes the effective filter a
 * pure derivation: changing views changes the id, so the stale edit no longer
 * applies and the new view's own filter takes over. `null` means "nothing chosen
 * yet for this view".
 */
interface FilterChoice {
  viewId: string | null;
  filter: GraphFilter;
}

type ViewState =
  | { status: 'loading' }
  | { status: 'ready'; view: ViewDTO | null; list: ViewListItem[] };

export default function GraphPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const [choice, setChoice] = useState<FilterChoice | null>(null);
  const [tags, setTags] = useState<TagDTO[]>([]);
  const [libraryTotal, setLibraryTotal] = useState<number | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [viewState, setViewState] = useState<ViewState>({ status: 'loading' });
  const [viewNotice, setViewNotice] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fitToken, setFitToken] = useState(0);
  /** Set while the delete-view confirmation is open (T082-R05, T082-C05). */
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const view = viewState.status === 'ready' ? viewState.view : null;
  const viewList = useMemo(
    () => (viewState.status === 'ready' ? viewState.list : []),
    [viewState],
  );
  const viewReady = viewState.status === 'ready';
  const viewId = view?.id ?? null;

  const baseline = useMemo(() => baselineOf(view), [view]);
  const persistence = useLayoutPersistence({ viewId, baseline });
  const resetLayout = persistence.reset;

  /**
   * The filter actually sent to the read.
   *
   * Restoring only a view's *positions* drew the saved coordinates over a
   * different set of records: a view saved by filter is a statement about which
   * notes to read, and that statement has to come back too. Purely derived, so no
   * effect can race the user's own edit.
   */
  const filter = useMemo(() => {
    if (choice && choice.viewId === viewId) return choice.filter;
    return filterOf(view) ?? EMPTY_FILTER;
  }, [choice, viewId, view]);

  /**
   * Adopt a loaded view: scope, stored layout, and a fit of the viewport.
   *
   * Called from async load paths only — never from an effect, and never from a
   * render. `resetLayout` is what marks the baseline ready, so "the view is set"
   * and "the stored positions are in place" become the same event; that is what
   * the gate in T047-C06 asks for.
   */
  const adoptView = useCallback(
    (next: ViewDTO | null, list: ViewListItem[]) => {
      resetLayout(baselineOf(next));
      setViewState({ status: 'ready', view: next, list });
      setFitToken((value) => value + 1);
    },
    [resetLayout],
  );

  /**
   * Load the most recent saved graph view once, on mount.
   *
   * The list is kept so a saved view scope stays escapable: once a view is open
   * the read is narrowed to its selection, and without a way back the graph would
   * look as though the rest of the library had been deleted. The picker offers
   * 「整个知识库」 for that.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await apiRequest<{ views: ViewListItem[] }>('/api/views', {
          query: { kind: 'graph', limit: 20 },
        });
        const first = list.views[0];
        if (!first) {
          if (!cancelled) adoptView(null, []);
          return;
        }
        const loaded = await apiRequest<ViewDTO>(`/api/views/${first.id}`);
        if (!cancelled) adoptView(loaded, list.views);
      } catch {
        // No saved view is a normal state, not an error the user must fix.
        if (!cancelled) adoptView(null, []);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adoptView]);

  /** Switch to a saved view (or back to the whole library with `null`). */
  const selectView = useCallback(
    (nextId: string | null) => {
      setSaveError(null);
      setSelectedEdgeId(null);
      if (nextId === null) {
        setViewNotice('已切回整个知识库的范围，筛选条件也一并清除');
        adoptView(null, viewList);
        return;
      }
      setViewNotice(null);
      void (async () => {
        try {
          const loaded = await apiRequest<ViewDTO>(`/api/views/${nextId}`);
          adoptView(loaded, viewList);
        } catch {
          setSaveError('打开视图失败');
        }
      })();
    },
    [adoptView, viewList],
  );

  /**
   * Item ids the read is restricted to.
   *
   * A saved view carries either an explicit selection or a filter; an explicit one
   * is sent as `itemIds` so reopening the view restores the same scope (T052-C05).
   * `undefined` means "everything", which is both the unsaved-canvas case and the
   * explicit 「整个知识库」 choice.
   */
  const scopeItemIds = useMemo(() => {
    if (!view || view.kind !== 'graph') return undefined;
    return view.selection.mode === 'explicit' ? view.selection.itemIds : undefined;
  }, [view]);

  const query = useGraphQuery({ filter, itemIds: scopeItemIds, enabled: viewReady });
  const graph = query.data;

  // Tag dictionary and library size come from their own endpoints; neither is part
  // of the graph read, and both are optional for drawing the canvas.
  //
  // Both halves settle asynchronously (a request always resolves in a later
  // microtask), so the effect body never sets state synchronously.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await apiRequest<{ tags: TagDTO[] }>('/api/tags');
        if (!cancelled) setTags(page.tags);
      } catch {
        if (!cancelled) setTags([]);
      }
      try {
        const items = await apiRequest<{ totalMatched: number }>('/api/items', {
          query: { limit: 1 },
        });
        if (!cancelled) setLibraryTotal(items.totalMatched);
      } catch {
        if (!cancelled) setLibraryTotal(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace.refreshToken]);

  // Re-read when records change elsewhere (new capture, edit, delete).
  useEffect(() => {
    if (workspace.refreshToken > 0) query.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.refreshToken]);

  /**
   * Merge saved positions with the current subgraph.
   *
   * `toFlowGraph` owns node/edge construction and reports which nodes lack a
   * coordinate; the page does not re-derive identity or labels (T044-R01).
   */
  const flow = useMemo(() => {
    if (!graph) return null;
    return toFlowGraph({
      graph,
      positions: persistence.positions,
      freshness: graph.freshness.byRelationId,
      selectedItemId: workspace.openItemId,
      selectedRelationId: selectedEdgeId,
    });
  }, [graph, persistence.positions, selectedEdgeId, workspace.openItemId]);

  const missingNodeIds = useMemo(
    () => (flow ? flow.nodes.filter((node) => node.data.needsLayout).map((node) => node.id) : []),
    [flow],
  );

  /** Run Dagre over the whole graph. Explicit user action only (T046-R01). */
  const autoLayoutAll = useCallback(() => {
    if (!graph) return;
    const result = layoutGraph({
      nodes: graph.nodes.map((node) => ({ id: node.id })),
      edges: graph.edges.map((edge) => ({ sourceId: edge.sourceId, targetId: edge.targetId })),
      direction: persistence.direction,
    });
    if (!result.ok) {
      // Invalid output is refused and the previous layout is kept (T046-R05).
      setSaveError(result.reason);
      return;
    }
    setSaveError(null);
    persistence.moveNodes(result.positions);
    setFitToken((value) => value + 1);
  }, [graph, persistence]);

  /** Place only the nodes that have no saved coordinate (T047-R04). */
  const layoutMissing = useCallback(() => {
    if (!graph) return;
    const missing = new Set(missingNodeIds);
    const result = layoutGraph({
      nodes: graph.nodes.filter((node) => missing.has(node.id)).map((node) => ({ id: node.id })),
      edges: graph.edges
        .filter((edge) => missing.has(edge.sourceId) && missing.has(edge.targetId))
        .map((edge) => ({ sourceId: edge.sourceId, targetId: edge.targetId })),
      direction: persistence.direction,
    });
    if (!result.ok) {
      setSaveError(result.reason);
      return;
    }
    setSaveError(null);
    // Existing coordinates are untouched; only the missing ones are added.
    persistence.moveNodes(result.positions);
    setFitToken((value) => value + 1);
  }, [graph, missingNodeIds, persistence]);

  /**
   * A saved view whose content has no coordinates gets exactly one auto-layout.
   *
   * Without this every node sits at the origin: React Flow stacks them into what
   * looks like a single card, and the user has to discover the auto-layout button
   * to see their graph at all. The contract asks for "no positions ⇒ run Dagre
   * once"; the ref-guard is what keeps it to once per view.
   *
   * No state is set here — `autoLayoutAll` moves nodes through the persistence
   * hook, which owns the debounce and the write.
   */
  const autoLaidViews = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!viewReady || !view || view.kind !== 'graph' || !graph) return;
    if (Object.keys(baseline.positions).length > 0) return;
    if (graph.nodes.length === 0) return;
    if (autoLaidViews.current.has(view.id)) return;
    autoLaidViews.current.add(view.id);
    autoLayoutAll();
  }, [viewReady, view, graph, baseline.positions, autoLayoutAll]);

  const createView = useCallback(async () => {
    if (!graph) return;
    setSaveBusy(true);
    setSaveError(null);
    try {
      // An explicit selection is preferred while it fits: it survives later edits
      // to other records, which a filter would silently sweep in.
      const selection =
        graph.nodes.length > 0 && graph.nodes.length <= LIMITS.selectedItemsPerProjection
          ? { mode: 'explicit' as const, itemIds: graph.nodes.map((node) => node.id) }
          : { mode: 'filter' as const, filter };
      const created = await apiRequest<ViewDTO>('/api/views', {
        method: 'POST',
        body: {
          name: `关系图 ${new Date().toLocaleString('zh-CN')}`,
          selection,
          positions: persistence.positions,
          direction: persistence.direction,
        },
      });
      adoptView(created, [created, ...viewList]);
      setViewNotice('已保存这个布局，下次打开会恢复');
    } catch {
      setSaveError('保存视图失败');
    } finally {
      setSaveBusy(false);
    }
  }, [adoptView, filter, graph, persistence.direction, persistence.positions, viewList]);

  const selectedEdge = useMemo(
    () => graph?.edges.find((edge) => edge.id === selectedEdgeId) ?? null,
    [graph, selectedEdgeId],
  );
  const labelOf = useCallback(
    (itemId: string) => graph?.nodes.find((node) => node.id === itemId)?.label ?? itemId,
    [graph],
  );

  const loading = !viewReady || (query.loading && !graph);
  const error = query.error;

  /**
   * Delete the open graph view — the view only.
   *
   * The knowledge items and relations are untouched; what goes is the saved read
   * scope and the stored layout (T053-R03, T082-R05). Afterwards the list is
   * re-read and the page falls back to the whole library rather than keeping a
   * scope that no longer exists. `expectedRevision` is the revision shown, so a
   * layout change made in another window surfaces as a conflict.
   */
  const deleteView = useCallback(async () => {
    const target = view;
    if (!target) return;
    await apiRequest<{ deletedId: string }>(`/api/views/${target.id}`, {
      method: 'DELETE',
      body: { expectedRevision: target.revision },
    });
    const list = await apiRequest<{ views: ViewListItem[] }>('/api/views', {
      query: { kind: 'graph', limit: 50 },
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

  return (
    <>
      <PageHeader title="关系图" description="节点来自知识条目，边来自关系；这里只是投影，不改动原文。" />

      <div className="flex flex-col gap-4">
        <GraphFilters
          filter={filter}
          onChange={(next) => {
            // Changing the filter changes what is read; it never writes (T048-R01).
            setSelectedEdgeId(null);
            setChoice({ viewId, filter: next });
          }}
          tags={tags}
          hiddenStaleCount={graph?.freshness.staleCount ?? 0}
          disabled={loading}
        />

        {/*
          The scope picker. A saved view narrows the read to its selection, so an
          explicit 「整个知识库」 option is required — otherwise opening a view would
          make the rest of the library look deleted (T052 「受限视图不代表数据丢失」).
        */}
        <section
          className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3"
          aria-label="读取范围"
          data-testid="graph-scope"
        >
          <Field label="读取范围" htmlFor="graph-view-select">
            <Select
              id="graph-view-select"
              data-testid="graph-view-select"
              value={viewId ?? ''}
              disabled={loading}
              onChange={(event) => selectView(event.target.value || null)}
            >
              <option value="">整个知识库（不套用保存的布局）</option>
              {viewList.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </Select>
          </Field>
          {view ? (
            <>
              <span className="text-xs text-[var(--ink-muted)]" data-testid="graph-scope-hint">
                读取范围来自这个视图的选择；清除它不会删除任何知识。
              </span>
              {/*
                Deleting a saved *view*. It lives beside the scope picker because
                it is a statement about the saved projection, and it says what it
                does not touch — the knowledge stays, only the read scope and the
                stored layout go (T082-R05).
              */}
              <Button
                variant="danger"
                data-testid="graph-delete-view"
                onClick={() => setConfirmingDelete(true)}
              >
                删除这个视图
              </Button>
            </>
          ) : null}
        </section>

        <LayoutControls
          direction={persistence.direction}
          onDirectionChange={(next) => {
            persistence.setDirection(next);
            setFitToken((value) => value + 1);
          }}
          onAutoLayout={autoLayoutAll}
          onLayoutMissing={layoutMissing}
          missingCount={missingNodeIds.length}
          busy={persistence.saving || saveBusy}
          dirty={persistence.dirty}
          // With no saved view there is nothing to write into. Saying so is the
          // honest version of a button that looked enabled and did nothing.
          canSave={viewId !== null}
          saveDisabledReason="还没有保存视图，拖动只在本页有效；先在下面「保存为视图」。"
          onSave={() => void persistence.save()}
        />

        {viewId === null ? (
          <SectionCard
            title="这个布局还没有保存"
            description="拖动和自动布局目前只在本页有效。保存后会写入视图，刷新仍然保留。"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                data-testid="graph-create-view"
                disabled={saveBusy || !graph || graph.nodes.length === 0}
                onClick={() => void createView()}
              >
                {saveBusy ? '保存中…' : '保存为视图'}
              </Button>
              <span className="text-xs text-[var(--ink-muted)]">
                保存视图只写布局与来源版本，不改动任何知识条目。
              </span>
            </div>
          </SectionCard>
        ) : null}

        {persistence.conflict ? (
          <div
            role="alert"
            data-testid="graph-layout-conflict"
            className="flex flex-col gap-2 rounded-md border border-[var(--danger)] bg-[var(--surface)] p-3 text-sm text-[var(--danger)]"
          >
            <span>布局已被其他窗口修改。你的拖动仍保留在本地，没有被覆盖。</span>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => resetLayout(baseline)}>
                重新载入对方版本
              </Button>
              <Button
                variant="danger"
                onClick={() =>
                  void persistence.save({ expectedRevision: view?.revision ?? undefined })
                }
              >
                用我的布局覆盖
              </Button>
            </div>
          </div>
        ) : null}

        {persistence.error ? (
          <p role="alert" className="text-sm text-[var(--danger)]">
            {persistence.error.message}
          </p>
        ) : null}
        {saveError ? (
          <p role="alert" className="text-sm text-[var(--danger)]" data-testid="graph-save-error">
            {saveError}
          </p>
        ) : null}
        {viewNotice ? (
          <p role="status" className="text-sm text-[var(--success)]">
            {viewNotice}
          </p>
        ) : null}

        {loading ? <LoadingIndicator label="正在读取关系图" /> : null}

        {error ? <GraphLoadError error={error} onRetry={query.reload} /> : null}

        {/*
          The drawer is driven by `openItemId`, which survives a filter change. If
          that record is no longer part of the subgraph the drawer is not "broken"
          — it is simply out of scope, and saying so is better than an unexplained
          panel for a node the user can no longer see (T048-R03).
        */}
        {!loading &&
        !error &&
        graph &&
        workspace.openItemId &&
        !graph.nodes.some((node) => node.id === workspace.openItemId) ? (
          <p
            role="status"
            className="text-xs text-[var(--ink-muted)]"
            data-testid="graph-selection-out-of-scope"
          >
            当前打开的记录不在这次筛选范围内。它没有被删除，清除筛选或调整条件即可重新看到。
          </p>
        ) : null}

        {!loading && !error && graph ? (
          graph.nodes.length === 0 ? (
            <GraphNoData
              // "Filtered" must mean the filter narrowed something away. The
              // default filter still carries `reviewStatuses`, so a truthy check
              // on the object would always claim filtering and hide the far more
              // useful "记录第一条内容" message from a genuinely empty library.
              filtered={hasActiveFilter(filter) && (libraryTotal ?? 0) > 0}
              onOpenLibrary={() => router.push('/library')}
              onResetFilters={() => setChoice({ viewId, filter: EMPTY_FILTER })}
            />
          ) : (
            <>
              <GraphSummary
                graph={graph}
                libraryTotal={libraryTotal}
                onSelectRelation={setSelectedEdgeId}
                onOpenLibrary={() => router.push('/library')}
              />
              {flow ? (
                <KnowledgeGraph
                  nodes={flow.nodes}
                  edges={flow.edges}
                  onNodesMoved={persistence.moveNodes}
                  onNodeOpen={workspace.openItem}
                  onEdgeSelected={setSelectedEdgeId}
                  onPaneClick={() => setSelectedEdgeId(null)}
                  selectedEdgeId={selectedEdgeId}
                  fitViewToken={fitToken}
                />
              ) : null}
              <GraphInspector
                edge={selectedEdge}
                sourceLabel={selectedEdge ? labelOf(selectedEdge.sourceId) : ''}
                targetLabel={selectedEdge ? labelOf(selectedEdge.targetId) : ''}
                onReviewed={() => {
                  // Only the affected edges are re-read; the whole page is not
                  // reloaded (T049-R03).
                  query.reload();
                }}
                onOpenItem={workspace.openItem}
                onClose={() => setSelectedEdgeId(null)}
              />
            </>
          )
        ) : null}
      </div>

      {confirmingDelete && view ? (
        <DeleteViewDialog
          viewName={view.name}
          kindLabel="关系图"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={deleteView}
        />
      ) : null}
    </>
  );
}
