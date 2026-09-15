'use client';

/**
 * Settings page (T027).
 *
 * Two sections: the model connection form, and a plain statement of what the
 * local data directory holds, followed by the local diagnostics panel (T074).
 * The data section is intentionally read-only copy — storage, export and
 * diagnostics get their own tasks in G6, and this page must not offer controls
 * whose behaviour is not implemented.
 */
import { useCallback, useState } from 'react';

import type { PublicLlmSettings } from '@/domain/knowledge';
import { PageHeader } from '@/components/AppShell';
import { SectionCard } from '@/components/ui/primitives';
import { useWorkspace } from '@/features/shared/workspace';

import { DiagnosticsPanel } from '@/features/settings/DiagnosticsPanel';
import { LlmSettingsForm } from '@/features/settings/LlmSettingsForm';

export default function SettingsPage() {
  const { refreshToken, notifyChanged } = useWorkspace();
  const [savedRevision, setSavedRevision] = useState<number | null>(null);

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
        <p className="text-xs text-[var(--ink-muted)]">
          导出、导入与备份属于交付阶段的任务，本页暂不提供按钮，以免出现没有实际行为的控件。
        </p>
      </SectionCard>

      <SectionCard
        title="本地诊断"
        description="版本、计数、耗时、失败层级与日志保留策略。只读取本机状态，不接第三方遥测。"
      >
        <DiagnosticsPanel />
      </SectionCard>
    </>
  );
}
