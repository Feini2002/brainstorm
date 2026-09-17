'use client';

/**
 * Settings page (T027).
 *
 * Three sections: the model connection form, what the local data directory holds
 * plus the backup/restore controls (D1), and the local diagnostics panel (T074).
 * The two content sections are ordinary UI over already-existing routes; this
 * page must not offer controls whose behaviour is not implemented.
 */
import { useCallback, useState } from 'react';

import type { PublicLlmSettings } from '@/domain/knowledge';
import { PageHeader } from '@/components/AppShell';
import { SectionCard } from '@/components/ui/primitives';
import { MODEL_REQUIRED_FOR, NO_MODEL_HINT } from '@/features/shared/StatusLabel';
import { useWorkspace } from '@/features/shared/workspace';

import { BackupPanel } from '@/features/settings/BackupPanel';
import { DiagnosticsPanel } from '@/features/settings/DiagnosticsPanel';
import { LlmSettingsForm } from '@/features/settings/LlmSettingsForm';

export default function SettingsPage() {
  const { refreshToken, notifyChanged } = useWorkspace();
  const [savedRevision, setSavedRevision] = useState<number | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const onSaved = useCallback(
    (settings: PublicLlmSettings) => {
      setSavedRevision(settings.revision);
      // Other pages read settings state; a settings write is a domain change.
      notifyChanged();
    },
    [notifyChanged],
  );

  return (
    <>
      <PageHeader
        title="设置"
        description="在这里配置模型连接。连接配置只保存在本机数据库，Key 进入服务端秘密表，不会返回浏览器。"
      />

      <LlmSettingsForm onSaved={onSaved} refreshToken={refreshToken} />

      {/*
        The no-key state, stated as a prerequisite rather than a failure
        (T082-R03, T082-C03). Two sentences: what needs a model, and what does
        not. Without the second one a missing key reads as "the app is not
        working", which is the misconception this case exists to prevent.
      */}
      <section
        className="rounded-lg border border-dashed border-[var(--line)] bg-[var(--surface-raised)] p-3"
        aria-label="模型配置说明"
        data-testid="settings-model-scope"
      >
        <p className="text-sm text-[var(--ink)]" data-testid="settings-model-required-for">
          {MODEL_REQUIRED_FOR}
        </p>
        <p className="mt-1 text-xs text-[var(--ink-muted)]" data-testid="settings-model-optional">
          {NO_MODEL_HINT}
        </p>
      </section>

      {savedRevision !== null ? (
        <p className="text-xs text-[var(--ink-muted)]" data-testid="settings-last-saved-revision">
          最近一次保存后的配置版本：revision {savedRevision}
        </p>
      ) : null}

      <SectionCard
        title="本地数据"
        description="知识原文、标签、关系与视图都存在本机 SQLite 文件里。"
      >
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-[var(--ink-muted)]">
          <li>默认位置是工程目录下的 .data（可用环境变量改写），只有本机进程会打开它。</li>
          <li>Key 与知识库是两件事：删掉 Key 之后，离线记录、检索和导出都照常可用。</li>
          <li>逻辑导出不含 Key；完整数据库文件可能包含它，删除记录不等于擦除磁盘。</li>
        </ul>
      </SectionCard>

      <BackupPanel />

      <details
        className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4"
        data-testid="settings-diagnostics"
        onToggle={(event) => setShowDiagnostics((event.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer text-sm font-semibold text-[var(--ink)]">
          技术诊断（按需加载）
        </summary>
        <p className="mt-2 text-xs text-[var(--ink-muted)]">
          版本、计数、耗时与失败层级。只读取本机状态，不接第三方遥测。
        </p>
        {showDiagnostics ? (
          <div className="mt-3">
            <DiagnosticsPanel />
          </div>
        ) : null}
      </details>
    </>
  );
}
