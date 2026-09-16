'use client';

/**
 * Flow page assembly (T062, T063, T065–T068).
 *
 * Two halves meet here. The top half generates: it confirms the material against
 * the server, takes an observation question and a layout direction, and posts one
 * request. The bottom half reads: it opens a saved flow from the local database,
 * draws it, lists its sources and exports it.
 *
 * Four page-level decisions, each of which a child component cannot make:
 *
 *  1. **Material is confirmed against the server, not against local state.**
 *     `/api/selection` re-reads every id and reports the deleted ones, so the count
 *     on screen is a fact rather than a number the browser made up (T021-R04,
 *     T062-R04). Counting is deliberately not a write: it costs nothing and does
 *     not touch a model.
 *  2. **Nothing is sent until the button.** Opening the page, editing the question
 *     and switching the direction issue no generation request and no paid call
 *     (T062-C03/R02) — there is no effect in this file that posts.
 *  3. **Opening a saved flow is a read, all the way down (T067-R06).** The
 *     freshness report, the list and the view itself are GETs; `generatedAt` is
 *     displayed and never written. The acceptance case counts external requests
 *     across repeated visits, and the only way that number stays zero is that no
 *     code path here calls the model.
 *  4. **A second click must not be a second interpretation of the same material.**
 *     The request is built once, at submit, from a frozen confirmation; if the ids
 *     change under it, the send is refused locally and re-confirmation is required
 *     instead of quietly using the newer set (T062-C05).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { FlowContent, ViewDTO, ViewSummaryDTO } from '@/domain/knowledge';
import { findUnsafeSvgMarkup } from '@/features/flow/sanitizeSvg';
import { PageHeader } from '@/components/AppShell';
import { Button, EmptyState, LoadingIndicator } from '@/components/ui/primitives';
import { ExportFlow } from '@/features/flow/ExportFlow';
import { FlowIntentForm } from '@/features/flow/FlowIntentForm';
import { FlowSourcePanel } from '@/features/flow/FlowSourcePanel';
import { MermaidRenderer } from '@/features/flow/MermaidRenderer';
import { SavedFlowList } from '@/features/flow/SavedFlowList';
import { DeleteViewDialog } from '@/features/shared/DeleteViewDialog';
import { ViewFreshnessBanner } from '@/features/shared/ViewFreshnessBanner';
import { ApiClientError, apiRequest } from '@/features/shared/apiClient';
import { useApiQuery } from '@/features/shared/useApiQuery';
import { useWorkspace } from '@/features/shared/workspace';
import {
  DEFAULT_FLOW_DIRECTION,
  describeFlowMaterial,
  summarizeFlowMaterial,
  type FlowDirection,
  type FlowGenerationRequestContract,
} from '@/domain/flowIntent';
import type { ViewFreshness } from '@/domain/view';
import { formatTime } from '@/features/shared/formatTime';

/**
 * What the server said about the ticked ids.
 *
 * `requestedKey` is the selection snapshot the resolution belongs to. Comparing it
 * at submit time is what turns "the ids changed" into a refusal instead of a
 * silent widening — the client told the server one set and would otherwise send
 * another.
 */
interface ConfirmedMaterial {
  requestedKey: string;
  resolved: { id: string; title: string }[];
  missingIds: string[];
  /** True when the server could not be asked yet, so the panel says so. */
  unconfirmed: boolean;
}

const EMPTY_MATERIAL: ConfirmedMaterial = {
  requestedKey: '',
  resolved: [],
  missingIds: [],
  unconfirmed: true,
};

type ViewState =
  | { status: 'loading' }
  | { status: 'ready'; view: ViewDTO | null; list: ViewSummaryDTO[] };

export default function FlowPage() {
  const workspace = useWorkspace();
  const selectedIds = workspace.selection.itemIds;

  // ---- Generate half -----------------------------------------------------
  const [intent, setIntent] = useState('');
  const [direction, setDirection] = useState<FlowDirection>(DEFAULT_FLOW_DIRECTION);
  const [material, setMaterial] = useState<ConfirmedMaterial>(EMPTY_MATERIAL);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);

  /** The exact selection the current confirmation describes. */
  const selectedKey = useMemo(() => [...selectedIds].sort().join(','), [selectedIds]);

  /**
   * One in-flight resolution at a time; a newer one supersedes an older reply.
   *
   * Without the sequence number, ticking three items quickly could leave the panel
   * showing the resolution of the *first* tick while the send uses the third.
   */
  const confirmSeq = useRef(0);

  const confirmMaterial = useCallback(
    async (ids: readonly string[]): Promise<ConfirmedMaterial | null> => {
      if (ids.length === 0) {
        setMaterial({ requestedKey: '', resolved: [], missingIds: [], unconfirmed: false });
        return null;
      }
      const seq = confirmSeq.current + 1;
      confirmSeq.current = seq;
      setConfirming(true);
      try {
        // A read: no model, no cost, safe on every change.
        const resolution = await apiRequest<{
          itemIds: string[];
          sources: { id: string; title: string; excerpt: string }[];
        }>('/api/selection', { query: { itemId: [...ids] } });
        if (seq !== confirmSeq.current) return null;

        const resolvedIds = resolution.sources.map((source) => source.id);
        const summary = summarizeFlowMaterial({ requestedIds: ids, resolvedIds });
        const next: ConfirmedMaterial = {
          requestedKey: [...resolvedIds].sort().join(','),
          resolved: resolution.sources.map((source) => ({
            id: source.id,
            // The title may be empty for a capture that never got one; the
            // excerpt is the honest fallback and is what the server already built.
            title: source.title.trim().length > 0 ? source.title : source.excerpt,
          })),
          missingIds: summary.missingIds,
          unconfirmed: false,
        };
        setMaterial(next);
        return next;
      } catch (caught) {
        if (seq !== confirmSeq.current) return null;
        // A failed *confirmation* is not a failed generation: the message says what
        // could not be checked, and the send button stays refused because the
        // material is still unconfirmed.
        setMaterial({ ...EMPTY_MATERIAL, requestedKey: '' });
        setServerError(
          caught instanceof ApiClientError
            ? caught.message
            : '无法向本地服务核对材料，请稍后重试',
        );
        return null;
      } finally {
        if (seq === confirmSeq.current) setConfirming(false);
      }
    },
    [],
  );

  /**
   * Re-confirm whenever the ticked set changes.
   *
   * The work is handed to a microtask rather than started in the effect body: both
   * the empty case (which sets state) and `confirmMaterial` (whose `setConfirming`
   * runs before its first `await`) would otherwise write state synchronously inside
   * the effect and cascade a render. A tick and the read that confirms it are one
   * paint apart, which is the same order a user sees.
   */
  useEffect(() => {
    queueMicrotask(() => {
      if (selectedIds.length === 0) {
        setMaterial({ requestedKey: '', resolved: [], missingIds: [], unconfirmed: false });
        return;
      }
      void confirmMaterial(selectedIds);
    });
    // `selectedKey` is the identity that matters; `selectedIds` is a new array
    // every render and would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, confirmMaterial]);

  const summary = useMemo(
    () =>
      summarizeFlowMaterial({
        requestedIds: material.requestedKey.length > 0 ? material.requestedKey.split(',') : [],
        resolvedIds: material.resolved.map((entry) => entry.id),
      }),
    [material],
  );
  const materialNotice = describeFlowMaterial(summary);

  // ---- Read half ---------------------------------------------------------
  const [viewState, setViewState] = useState<ViewState>({ status: 'loading' });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [refreshingList, setRefreshingList] = useState(false);
  const [freshnessVersion, setFreshnessVersion] = useState(0);
  /** Set while the delete-view confirmation is open (T082-R05, T082-C05). */
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const view = viewState.status === 'ready' ? viewState.view : null;
  const viewList = useMemo(
    () => (viewState.status === 'ready' ? viewState.list : []),
    [viewState],
  );
  const viewId = view?.id ?? null;
  const content: FlowContent | null = view?.kind === 'flow' ? view.content : null;

  /** Reload the saved-flow list. A read; never a generation. */
  const loadList = useCallback(async (): Promise<ViewSummaryDTO[]> => {
    const list = await apiRequest<{ views: ViewSummaryDTO[] }>('/api/views', {
      query: { kind: 'flow', limit: 50 },
    });
    return list.views;
  }, []);

  const adoptView = useCallback((next: ViewDTO | null, list: ViewSummaryDTO[]) => {
    setViewState({ status: 'ready', view: next, list });
    setSelectedNodeId(firstNodeIdOf(next));
  }, []);

  /**
   * Which view the user has asked for *now*, so a slow reply cannot win.
   *
   * Opening a saved flow is a read, and two reads can overlap: clicking the second
   * row before the first row's `GET /api/views/{id}` lands would otherwise let the
   * first reply overwrite the second — the picture and the source panel would then
   * describe a flow the picker no longer shows (T066-C01, T069-C03). Every load
   * takes a sequence number and only the newest may commit. The mount load takes
   * one too, so it cannot overwrite a click that happened while it was in flight.
   */
  const viewSeq = useRef(0);

  /** Load one view and adopt it, unless a newer selection has superseded it. */
  const loadView = useCallback(
    async (nextId: string, list: ViewSummaryDTO[]): Promise<void> => {
      const seq = viewSeq.current + 1;
      viewSeq.current = seq;
      try {
        const loaded = await apiRequest<ViewDTO>(`/api/views/${nextId}`);
        if (seq !== viewSeq.current) return;
        adoptView(loaded, list);
      } catch (caught) {
        if (seq !== viewSeq.current) return;
        setOpenError(caught instanceof ApiClientError ? caught.message : '打开这张流程图失败');
      }
    },
    [adoptView],
  );

  /** Adopt the newest saved flow once, on mount. */
  useEffect(() => {
    const seq = viewSeq.current + 1;
    viewSeq.current = seq;
    void (async () => {
      try {
        const list = await loadList();
        if (seq !== viewSeq.current) return;
        const first = list[0];
        if (!first) {
          adoptView(null, []);
          return;
        }
        const loaded = await apiRequest<ViewDTO>(`/api/views/${first.id}`);
        if (seq !== viewSeq.current) return;
        adoptView(loaded, list);
      } catch {
        // No saved flow is a normal state, not an error the user must fix.
        if (seq === viewSeq.current) adoptView(null, []);
      }
    })();
  }, [adoptView, loadList]);

  const selectView = useCallback(
    (nextId: string | null) => {
      setOpenError(null);
      if (nextId === null) {
        // Clearing is itself a selection, so it must also cancel an in-flight open.
        viewSeq.current += 1;
        adoptView(null, viewList);
        return;
      }
      void loadView(nextId, viewList);
    },
    [adoptView, loadView, viewList],
  );

  const refreshList = useCallback(() => {
    setRefreshingList(true);
    void (async () => {
      try {
        const list = await loadList();
        setViewState((current) =>
          current.status === 'ready' ? { status: 'ready', view: current.view, list } : current,
        );
      } catch {
        // A failed list refresh leaves the rows already on screen in place; they
        // are still the truth about what this library contains.
      } finally {
        setRefreshingList(false);
      }
    })();
  }, [loadList]);

  /**
   * Delete the open flow view — the view only (T082-R05, T082-C05).
   *
   * The knowledge behind it is untouched: this removes one projection row. The
   * list is re-read afterwards and the newest remaining flow adopted, so the
   * page never keeps showing a view that no longer exists. `expectedRevision`
   * comes from the view on screen, so a rename made elsewhere fails as a
   * conflict rather than being silently discarded.
   */
  const deleteView = useCallback(async () => {
    const target = view;
    if (!target) return;
    await apiRequest<{ deletedId: string }>(`/api/views/${target.id}`, {
      method: 'DELETE',
      body: { expectedRevision: target.revision },
    });
    const list = await loadList();
    const next = list[0];
    if (!next) {
      viewSeq.current += 1;
      adoptView(null, []);
    } else {
      await loadView(next.id, list);
    }
    setConfirmingDelete(false);
  }, [adoptView, loadList, loadView, view]);

  /**
   * Freshness is read, never inferred from the DTO.
   *
   * `ViewDTO.isStale` says *that* something moved; this says what. Kept on its own
   * request so opening a view stays one read.
   */
  const freshness = useApiQuery<ViewFreshness>(
    viewId === null ? '' : `/api/views/${viewId}/freshness`,
    { enabled: viewId !== null, version: freshnessVersion },
  );

  /**
   * Submit one confirmed request.
   *
   * The guards run before the network call, and each one refuses rather than
   * repairs: no material, unconfirmed material, material that changed since the
   * confirmation, or more than the budget.
   *
   * The "changed since confirmation" guard re-reads the ids from the server *at the
   * click*, because the panel on screen may describe a set that has since lost a
   * record. Sending the frozen list would put a deleted id in the request and change
   * what the flow is built from without the user seeing it; instead the click is
   * refused, the panel refreshes, and the second click sends the set the user has
   * now actually seen (T062-C05).
   */
  const submit = useCallback(
    async (body: FlowGenerationRequestContract): Promise<boolean> => {
      setServerError(null);
      setNotices([]);

      if (material.unconfirmed) {
        setServerError('还没有核对材料，请先点“核对材料”确认要发送的记录');
        return false;
      }

      if (workspace.selection.removedIds.length > 0) {
        setServerError(
          `有 ${workspace.selection.removedIds.length} 条已选材料已经被删除并从选择中移除，请先确认新的材料集合再生成`,
        );
        return false;
      }

      const sentKey = [...body.selection.itemIds].sort().join(',');
      const fresh = await confirmMaterial(body.selection.itemIds);
      if (fresh === null) {
        setServerError('无法向本地服务确认材料，本次没有发起生成');
        return false;
      }
      if (fresh.requestedKey !== sentKey) {
        setServerError('材料在确认之后发生了变化，请查看下面的最新材料并重新确认，再点一次生成');
        return false;
      }
      if (summary.overBudget) {
        setServerError(`选中的材料超过单次上限 ${summary.limit} 条，请减少选择`);
        return false;
      }

      setBusy(true);
      try {
        const result = await apiRequest<{
          runId: string;
          viewId?: string;
          state: string;
          warnings: string[];
          resultMissing?: boolean;
        }>('/api/views/mermaid/generate', { method: 'POST', body });

        setNotices([
          result.viewId ? '已经生成流程视图。' : '本次没有生成流程视图。',
          ...result.warnings,
        ]);

        if (result.viewId) {
          // Adopt the new view and refresh the list so the previous answer to the
          // same question stays selectable next to it (T067-C04). A read, not a new
          // generation.
          const [loaded, list] = await Promise.all([
            apiRequest<ViewDTO>(`/api/views/${result.viewId}`),
            loadList(),
          ]);
          adoptView(loaded, list);
          setFreshnessVersion((value) => value + 1);
          workspace.notifyChanged();
        } else {
          refreshList();
        }
        return true;
      } catch (caught) {
        setServerError(caught instanceof ApiClientError ? caught.message : '生成流程图失败');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [
      adoptView,
      confirmMaterial,
      loadList,
      material.unconfirmed,
      refreshList,
      summary.limit,
      summary.overBudget,
      workspace,
    ],
  );

  /**
   * The sanitized SVG currently on screen, for the export.
   *
   * Lifted here rather than kept inside the renderer because the export button
   * lives in a sibling section: the *only* SVG this page may offer for download is
   * the one the renderer purified, so the renderer publishes it upward and nothing
   * recomputes it (T068-R04 「不直接下载原始Mermaid返回值」).
   */
  const [sanitizedSvg, setSanitizedSvg] = useState<string | null>(null);
  const handleSvgReady = useCallback((svg: string | null) => setSanitizedSvg(svg), []);

  const loading = viewState.status === 'loading';

  return (
    <>
      <PageHeader
        title="流程图"
        description="按观察问题把材料整理成受限流程图；图只是投影，边是否有依据由材料决定。"
      />

      <div className="flex flex-col gap-4">
        {/*
          The selection lives in the shared tray (T021). This page states its own
          scope so a user who arrived from a filtered list knows what will be sent.
        */}
        <section
          className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3"
          aria-label="材料核对"
          data-testid="flow-scope"
        >
          <p className="text-sm text-[var(--ink)]" data-testid="flow-scope-count">
            {selectedIds.length === 0 ? '当前没有选中材料' : `已选 ${selectedIds.length} 条材料`}
          </p>
          <Button
            variant="secondary"
            data-testid="flow-confirm-material"
            disabled={selectedIds.length === 0 || confirming}
            onClick={() => void confirmMaterial(selectedIds)}
          >
            {confirming ? '正在核对…' : '核对材料'}
          </Button>
          {material.unconfirmed && selectedIds.length > 0 ? (
            <span className="text-xs text-[var(--warn-ink)]" data-testid="flow-confirm-required">
              生成前需要先向本地服务核对一次，确认没有已删除的记录。
            </span>
          ) : null}
          {materialNotice ? (
            <span className="text-xs text-[var(--warn-ink)]" data-testid="flow-material-notice">
              {materialNotice}
            </span>
          ) : null}
        </section>

        {selectedIds.length === 0 ? (
          <EmptyState
            title="还没有可以整理的流程材料"
            description="流程图由选中的材料生成：在资料库或收件箱勾选要观察的记录，选择条会把你带到这一页。已有的流程视图仍然可以打开和导出。"
            action={
              <p className="text-xs text-[var(--ink-muted)]">
                没有配好模型连接时也可以先选材料、写好观察问题。
              </p>
            }
          />
        ) : null}

        <FlowIntentForm
          selectedIds={selectedIds}
          resolved={material.resolved}
          missingIds={material.missingIds}
          confirming={confirming}
          busy={busy}
          serverError={serverError}
          intent={intent}
          direction={direction}
          onIntentChange={setIntent}
          onDirectionChange={setDirection}
          onSubmit={submit}
        />

        {busy ? <LoadingIndicator label="正在生成流程视图" /> : null}

        {notices.length > 0 ? (
          <div className="flex flex-col gap-1 text-sm" data-testid="flow-outcome">
            {notices.map((notice) => (
              <p key={notice} className="text-[var(--ink)]">
                {notice}
              </p>
            ))}
          </div>
        ) : null}

        {/* ---- Saved flows: the read half ---- */}
        <SavedFlowList
          views={viewList}
          activeId={viewId}
          disabled={loading}
          onSelect={selectView}
          onRefresh={refreshList}
          refreshing={refreshingList}
        />

        {openError ? (
          <p role="alert" className="text-sm text-[var(--danger)]" data-testid="flow-open-error">
            {openError}
          </p>
        ) : null}

        {view ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="danger"
              data-testid="flow-delete-view"
              onClick={() => setConfirmingDelete(true)}
            >
              删除这张视图
            </Button>
            <span className="text-xs text-[var(--ink-muted)]">
              删除的是这个流程视图，知识条目与关系不受影响。
            </span>
          </div>
        ) : null}

        {loading ? <LoadingIndicator label="正在读取流程图" /> : null}

        {viewState.status === 'ready' && content === null ? (
          <EmptyState
            title="还没有可显示的流程图"
            description="流程图由选中的材料生成：写下想观察的关系，再点生成。已保存的流程图会一直留在上面的列表里，随时可以重新打开和导出。"
            action={
              <p className="text-xs text-[var(--ink-muted)]">
                没有模型连接时，已经保存的流程图仍然可以打开、查看来源和导出。
              </p>
            }
          />
        ) : null}

        {content && view ? (
          <>
            {/*
              Freshness sits above the picture: it is about the *projection's*
              relationship to the knowledge base, and it must stay reachable when
              the canvas itself cannot be drawn (T067-R03, T067-C02).
            */}
            {freshness.data ? (
              <ViewFreshnessBanner
                freshness={freshness.data}
                onOpenItem={(itemId) => workspace.openItem(itemId)}
              />
            ) : null}

            {view ? (
              <p className="text-xs text-[var(--ink-muted)]" data-testid="flow-view-meta">
                生成于 {view.generatedAt ? formatTime(view.generatedAt).absolute : '未知时间'}，
                共 {view.sourceSnapshot.items.length} 条来源、{view.sourceSnapshot.relations.length}{' '}
                条关系。打开不会重新调用模型。
              </p>
            ) : null}

            <div className="flex flex-col gap-4 lg:flex-row">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <MermaidRenderer
                  content={content}
                  selectedNodeId={selectedNodeId}
                  onNodeSelect={setSelectedNodeId}
                  onSanitizedSvg={handleSvgReady}
                />
              </div>
            </div>

            <FlowSourcePanel
              content={content}
              snapshot={view.sourceSnapshot}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
              onOpenItem={workspace.openItem}
            />

            <ExportFlow
              viewId={view.id}
              freshness={freshness.data}
              sanitizedSvg={sanitizedSvg}
              isSanitizedSvgSafe={(svg) => findUnsafeSvgMarkup(svg).length === 0}
            />
          </>
        ) : null}
      </div>

      {confirmingDelete && view ? (
        <DeleteViewDialog
          viewName={view.name}
          kindLabel="流程"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={deleteView}
        />
      ) : null}
    </>
  );
}

/** The first node's id, so the source panel opens on something rather than nothing. */
function firstNodeIdOf(view: ViewDTO | null): string | null {
  if (!view || view.kind !== 'flow') return null;
  return view.content.nodes[0]?.id ?? null;
}
