'use client';

/**
 * Local diagnostics panel (T074).
 *
 * The server can report versions, counts, latencies and a lock probe. It cannot
 * report one thing: whether what arrived was actually *drawn*. A network 200
 * means the data reached the browser, and a container with zero height will
 * happily receive a successful response and show nothing — which is exactly the
 * "blank graph" the user then reports as "it's broken" (T074-C03). So this panel
 * measures the surfaces it can see and refuses to call that state a success.
 *
 * Three further decisions, each of which is a rule:
 *
 *  - **The copyable summary is a whitelist built by a named function.** It is not
 *    a serialization of whatever the server sent: there is no key in
 *    `DiagnosticsExport` that could hold a secret, note text, a full endpoint URL
 *    or the session token (T074-R05). The session token never enters this
 *    component at all — `apiClient` attaches it to the request — so it could not
 *    be included even by accident.
 *  - **The retention policy is shown next to the counters.** The bound is a
 *    contract value, so stating it is how the user can check it, rather than
 *    taking "logs are bounded" on trust (T074-R04).
 *  - **Every implicated layer gets its own first check.** The panel never
 *    collapses several failures into one "reinstall dependencies" suggestion
 *    (T074-R06).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  FAILURE_LAYER_LABELS,
  type DiagnosticsReport,
  type FailureLayer,
  type FailureLayerEntry,
  type LatencyStats,
} from '@/domain/api';
import { Button, InlineError, LoadingIndicator, SectionCard } from '@/components/ui/primitives';
import { useApiQuery } from '@/features/shared/useApiQuery';

/** One measured drawing surface: either the panel's content area or a marked element. */
export interface RenderSurface {
  name: string;
  width: number;
  height: number;
}

/** A container that received its data but cannot show it. */
export interface RenderIssue {
  layer: 'render';
  label: string;
  nextStep: string;
  evidence: string[];
  surfaces: RenderSurface[];
}

/** Elements the app may mark so this panel also watches *their* box, not just its own. */
export const RENDER_SURFACE_ATTRIBUTE = 'data-diagnostic-surface';

/**
 * Classify measured surfaces.
 *
 * A surface is unusable when either dimension is zero. Width is checked as well
 * as height because `height: 100%` inside a zero-width column produces the same
 * invisible result, and reporting only the height would describe half the
 * condition. A surface whose name is present but whose box could not be measured
 * is *not* reported as broken: a missing measurement is not evidence of a
 * rendering fault.
 */
export function assessRenderSurfaces(surfaces: readonly RenderSurface[]): RenderIssue | null {
  const collapsed = surfaces.filter((surface) => surface.height <= 0 || surface.width <= 0);
  if (collapsed.length === 0) return null;
  return {
    layer: 'render',
    label: FAILURE_LAYER_LABELS.render,
    nextStep:
      '把窗口拉大到能容下内容，或取消把容器压成 0 高度的样式（例如 height:0 / overflow:hidden）后重新载入页面。',
    evidence: collapsed.map(
      (surface) =>
        `渲染容器「${surface.name}」的尺寸为 ${surface.width}×${surface.height}，没有可绘制区域`,
    ),
    surfaces: [...collapsed],
  };
}

/**
 * Merge the locally-observed render layer into the server's layer list.
 *
 * The render layer is *added to*, never substituted for, the server's findings:
 * a blank canvas while the database is also locked is two things to look at, and
 * hiding one behind the other would send the user to fix the wrong component.
 */
export function withRenderIssue(
  layers: readonly FailureLayerEntry[],
  issue: RenderIssue | null,
): FailureLayerEntry[] {
  if (issue === null) return [...layers];
  const entry: FailureLayerEntry = {
    layer: issue.layer,
    label: issue.label,
    nextStep: issue.nextStep,
    evidence: issue.evidence,
  };
  const existing = layers.findIndex((item) => item.layer === 'render');
  if (existing === -1) return [...layers, entry];
  const merged = [...layers];
  merged[existing] = {
    ...entry,
    evidence: [...new Set([...(layers[existing]?.evidence ?? []), ...entry.evidence])],
  };
  return merged;
}

/* -------------------------------------------------------------------------- */
/* The copyable summary: an explicit whitelist (T074-R05)                     */
/* -------------------------------------------------------------------------- */

export interface DiagnosticsExportLatency {
  route: string;
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  lastMs: number | null;
}

/**
 * What may leave the page.
 *
 * Note what is absent rather than copied: the data-directory *kind* is kept but
 * its path was never in the server DTO; `endpointHost` is a hostname, not a URL
 * with a path or query; counts are numbers; error entries carry a code rather
 * than a message that could quote a provider's text. There is no field for the
 * session token, and this component never reads one.
 */
export interface DiagnosticsExport {
  application: string;
  version: string;
  node: string;
  platform: string;
  arch: string;
  protocolVersion: number;
  runMode: string;
  dataDir: { kind: string; exists: boolean; writable: boolean | null };
  database: {
    schemaVersion: number | null;
    supportedSchemaVersion: number;
    datasetRevision: number;
    lockProbe: string;
  };
  counts: DiagnosticsReport['counts'];
  model: {
    adapter: string;
    endpointHost: string | null;
    model: string;
    apiKeyConfigured: boolean;
    structuredMode: string;
    tokenField: string;
    schemaRepairEnabled: boolean;
  };
  capabilities: string[];
  telemetry: 'none';
  renderers: { kind: string; version: string }[];
  errorCodes: { code: string; layer: string; source: string; count: number }[];
  runLatency: { finished: number; p50Ms: number | null; p95Ms: number | null };
  apiLatency: DiagnosticsExportLatency[];
  journal: { capacity: number; retained: number; recorded: number; suppressedRepeats: number };
  layers: { layer: string; label: string; nextStep: string; evidence: string[] }[];
}

/** Largest number of API routes listed in the shareable summary. */
const EXPORT_CAPABILITY_LIMIT = 40;

/**
 * Project the report (plus the locally-observed render issue) onto the whitelist.
 *
 * Every field is named. `capabilities` is capped so a growing route table cannot
 * turn the summary into a long paste, and both latency lists are capped by the
 * server's own sample bound.
 */
export function toDiagnosticsExport(
  report: DiagnosticsReport,
  issue: RenderIssue | null,
  appVersionOverride?: string,
): DiagnosticsExport {
  return {
    application: report.application,
    version: appVersionOverride ?? report.version,
    node: report.node,
    platform: report.platform,
    arch: report.arch,
    protocolVersion: report.protocolVersion,
    runMode: report.runMode,
    dataDir: {
      kind: report.dataDir.kind,
      exists: report.dataDir.exists,
      writable: report.dataDir.writable,
    },
    database: {
      schemaVersion: report.database.schemaVersion,
      supportedSchemaVersion: report.database.supportedSchemaVersion,
      datasetRevision: report.database.datasetRevision,
      lockProbe: report.database.lockProbe,
    },
    counts: { ...report.counts },
    model: {
      adapter: report.model.adapter,
      endpointHost: report.model.endpointHost,
      model: report.model.model,
      apiKeyConfigured: report.model.apiKeyConfigured,
      structuredMode: report.model.structuredMode,
      tokenField: report.model.tokenField,
      schemaRepairEnabled: report.model.schemaRepairEnabled,
    },
    capabilities: report.capabilities.slice(0, EXPORT_CAPABILITY_LIMIT),
    telemetry: report.observability.telemetry,
    renderers: report.observability.renderers.map((renderer) => ({ ...renderer })),
    errorCodes: report.observability.errorCodes.map((observed) => ({
      code: observed.code,
      layer: observed.layer,
      source: observed.source,
      count: observed.count,
    })),
    runLatency: {
      finished: report.observability.runLatency.finished,
      p50Ms: report.observability.runLatency.stats.p50Ms,
      p95Ms: report.observability.runLatency.stats.p95Ms,
    },
    apiLatency: report.observability.apiLatency.routes.map((entry) => ({
      route: entry.route,
      count: entry.stats.count,
      p50Ms: entry.stats.p50Ms,
      p95Ms: entry.stats.p95Ms,
      lastMs: entry.stats.lastMs,
    })),
    journal: {
      capacity: report.observability.journal.capacity,
      retained: report.observability.journal.retained,
      recorded: report.observability.journal.recorded,
      suppressedRepeats: report.observability.journal.suppressedRepeats,
    },
    layers: withRenderIssue(report.layers, issue).map((layer) => ({
      layer: layer.layer,
      label: layer.label,
      nextStep: layer.nextStep,
      evidence: [...layer.evidence],
    })),
  };
}

export function diagnosticsExportToJson(
  report: DiagnosticsReport,
  issue: RenderIssue | null,
  appVersionOverride?: string,
): string {
  return JSON.stringify(toDiagnosticsExport(report, issue, appVersionOverride), null, 2);
}

/** Short Chinese lines for a user who would rather read it before pasting. */
export function diagnosticsExportToText(
  report: DiagnosticsReport,
  issue: RenderIssue | null,
  appVersionOverride?: string,
): string {
  const exported = toDiagnosticsExport(report, issue, appVersionOverride);
  const lines: string[] = [
    'feini-brain 本地诊断（已脱敏，可直接粘贴）',
    `应用：${exported.application} ${exported.version} · 协议 ${exported.protocolVersion} · 运行模式 ${exported.runMode}`,
    `Node：${exported.node}（${exported.platform}/${exported.arch}）`,
    `数据目录：${exported.dataDir.kind === 'default' ? '默认 .data' : '自定义'} · ` +
      `存在 ${exported.dataDir.exists ? '是' : '否'} · ` +
      `可写 ${exported.dataDir.writable === null ? '未知' : exported.dataDir.writable ? '是' : '否'}`,
    `数据库 schema：${exported.database.schemaVersion ?? '未知'}` +
      `（本程序支持 ${exported.database.supportedSchemaVersion}）· ` +
      `dataset revision ${exported.database.datasetRevision}`,
    `写锁探测：${describeLockProbe(exported.database.lockProbe) }`,
    `计数：条目 ${valueOrUnknown(exported.counts.items)} · 关系 ${valueOrUnknown(exported.counts.relations)} · ` +
      `视图 ${valueOrUnknown(exported.counts.views)} · 标签 ${valueOrUnknown(exported.counts.tags)} · ` +
      `运行 ${valueOrUnknown(exported.counts.runs)}`,
    `模型：${exported.model.model || '（未配置）'} @ ${exported.model.endpointHost ?? '（未配置）'} · ` +
      `Key 已配置 ${exported.model.apiKeyConfigured ? '是' : '否'}`,
    `第三方遥测：${exported.telemetry === 'none' ? '无（不发起任何外部请求）' : exported.telemetry}`,
    `日志保留：上限 ${exported.journal.capacity} 条，当前保留 ${exported.journal.retained} 条，` +
      `累计 ${exported.journal.recorded} 条，限流折叠 ${exported.journal.suppressedRepeats} 次`,
  ];

  lines.push(
    `运行耗时（已完成 ${exported.runLatency.finished} 次）：` +
      `中位 ${formatMs(exported.runLatency.p50Ms)} · P95 ${formatMs(exported.runLatency.p95Ms)}`,
  );

  if (exported.apiLatency.length === 0) {
    lines.push('接口耗时：暂无样本（未观测到的耗时不写 0）');
  } else {
    for (const entry of exported.apiLatency) {
      lines.push(
        `接口耗时 ${entry.route}：样本 ${entry.count} · 中位 ${formatMs(entry.p50Ms)} · ` +
          `P95 ${formatMs(entry.p95Ms)} · 最近 ${formatMs(entry.lastMs)}`,
      );
    }
  }

  for (const renderer of exported.renderers) {
    lines.push(`渲染器：${renderer.kind} · ${renderer.version}`);
  }

  if (exported.errorCodes.length === 0) {
    lines.push('错误码：无记录');
  } else {
    for (const observed of exported.errorCodes) {
      lines.push(
        `错误码：${observed.code}（层级 ${observed.layer} · 来源 ${observed.source} · ${observed.count} 次）`,
      );
    }
  }

  if (exported.layers.length === 0) {
    lines.push('失败层级：未发现指向具体层级的证据');
  } else {
    lines.push('失败层级与首要排查入口：');
    for (const layer of exported.layers) {
      lines.push(`- ${layer.label}：${layer.nextStep}`);
      for (const item of layer.evidence) lines.push(`  · ${item}`);
    }
  }

  return lines.join('\n');
}

function valueOrUnknown(value: number | null): number | string {
  return value === null ? '未知' : value;
}

function formatMs(value: number | null): string {
  return value === null ? '未知' : `${value} 毫秒`;
}

export function describeLockProbe(probe: string): string {
  if (probe === 'ok') return '正常（当前没有其它连接持有写锁）';
  if (probe === 'locked') return '另一个连接正持有写锁（这是本地存储问题，不是模型问题）';
  return '未知（本次未执行探测）';
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                      */
/* -------------------------------------------------------------------------- */

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the manual path; a local page may be denied clipboard access.
  }
  return false;
}

/**
 * The element whose box the panel measures for itself.
 *
 * It has to be the *content* region rather than the outer wrapper, because the
 * wrapper also holds the "recheck" control: if the panel collapsed itself, a
 * control inside the collapsed box would be unclickable, so the one affordance
 * that could explain the blank page would be hidden by the condition it exists
 * to report. The outer wrapper therefore stays measurable and interactive.
 */
export const PANEL_SURFACE_TESTID = 'diagnostics-surface';

/** Measure this element's own box plus any element the app marked as a drawing surface. */
export function measureSurfaces(root: HTMLElement | null): RenderSurface[] {
  if (root === null || typeof document === 'undefined') return [];
  const surfaces: RenderSurface[] = [];
  const own = root.getBoundingClientRect();
  surfaces.push({ name: '诊断面板', width: Math.round(own.width), height: Math.round(own.height) });

  for (const element of Array.from(document.querySelectorAll(`[${RENDER_SURFACE_ATTRIBUTE}]`))) {
    const box = element.getBoundingClientRect();
    surfaces.push({
      name: element.getAttribute(RENDER_SURFACE_ATTRIBUTE) || '未命名容器',
      width: Math.round(box.width),
      height: Math.round(box.height),
    });
  }
  return surfaces;
}

function LatencyRow({ label, stats }: { label: string; stats: LatencyStats }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-[var(--ink-muted)]">{label}</dt>
      <dd className="text-sm text-[var(--ink)]" data-testid={`diagnostics-latency-${label}`}>
        {stats.count === 0
          ? '未知（还没有样本）'
          : `样本 ${stats.count} · 中位 ${stats.p50Ms} 毫秒 · P95 ${stats.p95Ms} 毫秒 · 最近 ${stats.lastMs} 毫秒`}
      </dd>
    </div>
  );
}

export function DiagnosticsPanel() {
  const state = useApiQuery<DiagnosticsReport>('/api/diagnostics');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [surfaces, setSurfaces] = useState<RenderSurface[]>([]);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle');

  const report = state.data;

  /**
   * Measure on an explicit action, plus once when the report arrives.
   *
   * Deliberately *not* a `ResizeObserver` on this panel: the panel renders its
   * own findings, so a collapsed box would produce evidence, which changes the
   * box, which produces different evidence — a feedback loop whose only stable
   * state is a flicker. A measurement triggered by the user (or by the report
   * arriving) is a snapshot of the layout they are asking about.
   */
  const measure = useCallback(() => {
    setSurfaces(measureSurfaces(rootRef.current));
  }, []);

  /**
   * Measure after the data has rendered rather than on every render.
   *
   * Measuring before the report renders would read the loading state's box, so a
   * collapsed panel would be reported as healthy; measuring on every render would
   * set state from an effect body and cascade.
   */
  useEffect(() => {
    if (report === null) return;
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [report, measure]);

  const issue = useMemo(() => assessRenderSurfaces(surfaces), [surfaces]);

  const layers = useMemo(
    () => (report === null ? [] : withRenderIssue(report.layers, issue)),
    [report, issue],
  );

  const onCopy = useCallback(async () => {
    if (report === null) return;
    const ok = await copyText(diagnosticsExportToText(report, issue));
    setCopyState(ok ? 'copied' : 'manual');
  }, [report, issue]);

  if (state.loading && report === null) {
    return <LoadingIndicator label="正在读取本地诊断" />;
  }
  if (state.error && report === null) {
    return (
      <InlineError message={state.error.message}>
        <Button variant="secondary" onClick={state.reload}>
          重新读取
        </Button>
      </InlineError>
    );
  }
  if (report === null) return null;

  const json = diagnosticsExportToJson(report, issue);

  return (
    <div className="flex flex-col gap-4" data-testid="diagnostics-panel">
      {/*
        Two separate boxes on purpose (T074-C03).

        `diagnostics-surface` is the region whose size the panel reports: it is
        the content, and it is what a stray `height:0` would collapse. The outer
        wrapper deliberately is *not* measured, because it also carries the
        "recheck" control — and a control inside a collapsed box could never be
        clicked, so the one thing that explains the blank page would be hidden by
        the very condition it is supposed to report.
      */}
      <div
        ref={rootRef}
        className="flex flex-col gap-4"
        data-testid={PANEL_SURFACE_TESTID}
      >
      {/*
        The render-size problem is stated *first* and as a distinct finding: the
        API succeeded, so nothing else on this page would look wrong
        (T074-C03).
      */}
      {issue !== null ? (
        <div
          role="alert"
          data-testid="diagnostics-render-issue"
          className="flex flex-col gap-1 rounded-md border border-[var(--danger)] p-3 text-sm"
        >
          <p className="font-medium text-[var(--danger)]">
            渲染尺寸问题：接口成功了，但内容没有被画出来
          </p>
          {issue.evidence.map((item) => (
            <p key={item} className="text-[var(--ink-muted)]">
              {item}
            </p>
          ))}
          <p className="text-[var(--ink)]">{issue.nextStep}</p>
          <p className="text-xs text-[var(--ink-muted)]">
            网络成功不代表可视化成功：数据到达浏览器与内容可见是两件事。
          </p>
        </div>
      ) : null}

      <dl className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-[var(--ink-muted)]">应用与运行模式</dt>
          <dd className="text-sm text-[var(--ink)]" data-testid="diagnostics-version">
            {report.application} {report.version} · 协议 {report.protocolVersion} · {report.runMode}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-[var(--ink-muted)]">Node</dt>
          <dd className="text-sm text-[var(--ink)]" data-testid="diagnostics-node">
            {report.node}（{report.platform}/{report.arch}）
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-[var(--ink-muted)]">数据目录</dt>
          <dd className="text-sm text-[var(--ink)]" data-testid="diagnostics-datadir">
            {report.dataDir.kind === 'default' ? '默认 .data' : '自定义目录'} ·{' '}
            {report.dataDir.exists ? '存在' : '不存在'} ·{' '}
            {report.dataDir.writable === null
              ? '可写状态未知'
              : report.dataDir.writable
                ? '可写'
                : '不可写'}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-[var(--ink-muted)]">数据库</dt>
          <dd className="text-sm text-[var(--ink)]" data-testid="diagnostics-database">
            schema {report.database.schemaVersion ?? '未知'}（支持{' '}
            {report.database.supportedSchemaVersion}）· dataset revision{' '}
            {report.database.datasetRevision}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-[var(--ink-muted)]">写锁探测</dt>
          <dd className="text-sm text-[var(--ink)]" data-testid="diagnostics-lock-probe">
            {describeLockProbe(report.database.lockProbe)}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-[var(--ink-muted)]">计数</dt>
          <dd className="text-sm text-[var(--ink)]" data-testid="diagnostics-counts">
            条目 {valueOrUnknown(report.counts.items)} · 关系{' '}
            {valueOrUnknown(report.counts.relations)} · 视图 {valueOrUnknown(report.counts.views)} ·
            标签 {valueOrUnknown(report.counts.tags)} · 运行 {valueOrUnknown(report.counts.runs)}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-[var(--ink-muted)]">模型</dt>
          <dd className="text-sm text-[var(--ink)]" data-testid="diagnostics-model">
            {report.model.model || '（未配置）'} @ {report.model.endpointHost ?? '（未配置）'} · Key{' '}
            {report.model.apiKeyConfigured ? '已配置' : '未配置'}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-[var(--ink-muted)]">第三方遥测</dt>
          <dd className="text-sm text-[var(--ink)]" data-testid="diagnostics-telemetry">
            无：本工具不发起任何外部请求，也不接入任何统计平台
          </dd>
        </div>
      </dl>

      <SectionCard
        title="失败层级与排查入口"
        description="按实际观察到的证据分类。数据库锁归入本地存储，不会写成模型问题。"
      >
        {layers.length === 0 ? (
          <p className="text-sm text-[var(--ink-muted)]" data-testid="diagnostics-no-layers">
            当前没有指向具体层级的证据。这不等于「一切正常」，只说明还没有观测到失败线索。
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {layers.map((layer) => (
              <li
                key={layer.layer}
                data-testid={`diagnostics-layer-${layer.layer}`}
                className="flex flex-col gap-1 rounded-md border border-[var(--line)] p-3"
              >
                <p className="text-sm font-medium text-[var(--ink)]">{layer.label}</p>
                <p className="text-sm text-[var(--ink)]" data-testid={`diagnostics-next-step-${layer.layer}`}>
                  先做这个：{layer.nextStep}
                </p>
                <ul className="flex list-disc flex-col pl-5 text-xs text-[var(--ink-muted)]">
                  {layer.evidence.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="耗时与错误码"
        description="只记录实际观测到的耗时；没有样本时显示未知，不填 0。"
      >
        <dl className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-[var(--ink-muted)]">运行耗时</dt>
            <dd className="text-sm text-[var(--ink)]" data-testid="diagnostics-run-latency">
              {report.observability.runLatency.finished === 0
                ? '未知（还没有已结束的运行）'
                : `已完成 ${report.observability.runLatency.finished} 次 · 中位 ${report.observability.runLatency.stats.p50Ms} 毫秒 · P95 ${report.observability.runLatency.stats.p95Ms} 毫秒`}
            </dd>
          </div>
          {report.observability.runLatency.unfinished > 0 ? (
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs text-[var(--ink-muted)]">仍在进行的运行</dt>
              <dd className="text-sm text-[var(--ink)]" data-testid="diagnostics-unfinished-runs">
                {report.observability.runLatency.unfinished} 次（不计入耗时样本）
              </dd>
            </div>
          ) : null}
          {report.observability.apiLatency.routes.length === 0 ? (
            <LatencyRow
              label="接口耗时"
              stats={{
                count: 0,
                lastMs: null,
                minMs: null,
                maxMs: null,
                p50Ms: null,
                p95Ms: null,
              }}
            />
          ) : (
            report.observability.apiLatency.routes.map((entry) => (
              <LatencyRow key={entry.route} label={entry.route} stats={entry.stats} />
            ))
          )}
        </dl>
        <p className="text-xs text-[var(--ink-muted)]" data-testid="diagnostics-api-latency-note">
          {report.observability.apiLatency.note}
        </p>

        <div className="flex flex-col gap-1">
          <p className="text-xs text-[var(--ink-muted)]">错误码</p>
          {report.observability.errorCodes.length === 0 ? (
            <p className="text-sm text-[var(--ink-muted)]" data-testid="diagnostics-no-error-codes">
              没有记录到错误码。
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {report.observability.errorCodes.map((observed) => (
                <li
                  key={`${observed.source}-${observed.code}`}
                  data-testid="diagnostics-error-code"
                  className="text-sm text-[var(--ink)]"
                >
                  {observed.code} · 层级 {FAILURE_LAYER_LABELS[observed.layer as FailureLayer] ?? observed.layer}{' '}
                  · 来源 {observed.source === 'run' ? '运行账本' : '本进程日志'} · {observed.count} 次
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-xs text-[var(--ink-muted)]">渲染器版本（Renderer 错误按 kind 与版本区分）</p>
          <ul className="flex flex-col gap-1">
            {report.observability.renderers.map((renderer) => (
              <li
                key={renderer.kind}
                data-testid={`diagnostics-renderer-${renderer.kind}`}
                className="text-sm text-[var(--ink)]"
              >
                {renderer.kind} · {renderer.version}
              </li>
            ))}
          </ul>
        </div>
      </SectionCard>

      <SectionCard title="日志保留与限流" description="上限与轮转策略是契约值，不是口头承诺。">
        <p className="text-sm text-[var(--ink)]" data-testid="diagnostics-retention-policy">
          {report.observability.retention.policy}
        </p>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-[var(--ink-muted)]">保留状态</dt>
            <dd className="text-sm text-[var(--ink)]" data-testid="diagnostics-journal">
              上限 {report.observability.journal.capacity} · 当前保留{' '}
              {report.observability.journal.retained} · 累计 {report.observability.journal.recorded}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-[var(--ink-muted)]">被丢弃与被折叠的重复</dt>
            <dd className="text-sm text-[var(--ink)]" data-testid="diagnostics-journal-dropped">
              因超过上限丢弃 {report.observability.journal.droppedByRetention} 条 · 重复折叠{' '}
              {report.observability.journal.suppressedRepeats} 次
            </dd>
          </div>
        </dl>
      </SectionCard>

      <SectionCard title="能力清单" description="由实际存在的 API 路由推导，不是手写声明。">
        <p className="text-sm break-all text-[var(--ink-muted)]" data-testid="diagnostics-capabilities">
          {report.capabilities.length === 0
            ? '（未能列出路由）'
            : `${report.capabilities.length} 个路由，共 ${report.capabilities.length} 项`}
        </p>
      </SectionCard>
      </div>

      {/*
        The actions live outside the measured region: they must remain reachable
        even when the region above is collapsed (T074-C03).
      */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" data-testid="diagnostics-copy" onClick={() => void onCopy()}>
          复制脱敏摘要
        </Button>
        <span className="text-xs text-[var(--ink-muted)]" data-testid="diagnostics-copy-state">
          {copyState === 'copied'
            ? '已复制。摘要不含 Key、原文、完整 endpoint query 或本地会话令牌。'
            : copyState === 'manual'
              ? '浏览器拒绝了剪贴板访问，请手动选中下面的预览内容复制。'
              : '摘要不含 Key、原文、完整 endpoint query 或本地会话令牌。'}
        </span>
        <Button variant="ghost" data-testid="diagnostics-recheck" onClick={measure}>
          重新检查渲染尺寸
        </Button>
      </div>

      <details className="rounded-md border border-[var(--line)] p-3">
        <summary className="cursor-pointer text-sm text-[var(--ink)]">查看将要复制的脱敏摘要</summary>
        <pre
          data-testid="diagnostics-export-preview"
          className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs text-[var(--ink-muted)]"
        >
          {json}
        </pre>
      </details>

      <p className="text-xs text-[var(--ink-muted)]">
        诊断只读取本地状态：它不调用模型，不修改知识、运行或设置，也不接第三方遥测。
      </p>
    </div>
  );
}
