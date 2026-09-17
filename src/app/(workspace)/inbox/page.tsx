'use client';

/**
 * Inbox (T013, T015, T024, T036, T041).
 *
 * Capture is available with or without a model configured: only the "save &
 * organize" action depends on settings, and it saves the raw text first so a
 * missing key can never cost the user their note (T013-R06).
 *
 * The organize run is owned *here* rather than inside the capture box, for one
 * concrete reason: the page has to keep the returned `runId` so the diagnostics
 * panel below can describe the run the user just paid for (T041-R01/R03). The
 * "回到来源条目" control is wired to the shared drawer, so the entry point and the
 * knowledge record stay one object.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { RunResult } from '@/domain/api';
import { PageHeader } from '@/components/AppShell';
import { CaptureBox } from '@/features/inbox/CaptureBox';
import { RecentItems } from '@/features/inbox/RecentItems';
import type { OrganizeUiOutcome } from '@/features/inbox/captureSession';
import { organizeConflictMessage } from '@/features/inbox/captureSession';
import { ConnectionNotice } from '@/features/shared/ConnectionNotice';
import { RunDiagnosticsPanel } from '@/features/settings/RunDiagnostics';
import { ApiClientError, apiRequest } from '@/features/shared/apiClient';
import { useWorkspace } from '@/features/shared/workspace';

interface LlmSettingsSummary {
  apiKeyConfigured: boolean;
}

export default function InboxPage() {
  const router = useRouter();
  const workspace = useWorkspace();
  const { notifyChanged } = workspace;
  const [modelConfigured, setModelConfigured] = useState(false);
  const [organizeRunId, setOrganizeRunId] = useState<string | null>(null);
  const [showRunDetails, setShowRunDetails] = useState(false);

  // The capture box only needs to know whether a key exists, never its value.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await apiRequest<LlmSettingsSummary>('/api/settings/llm');
        if (!cancelled) setModelConfigured(settings.apiKeyConfigured);
      } catch {
        // No settings row yet (or the endpoint is not up): capture still works
        // without a model, so this is not an inbox-level error.
        if (!cancelled) setModelConfigured(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onCreated = useCallback(() => {
    notifyChanged();
  }, [notifyChanged]);

  const openSettings = useCallback(() => router.push('/settings'), [router]);

  /**
   * One organize attempt for one freshly captured item.
   *
   * The request key is generated per attempt, so a user-initiated retry is a new
   * paid action while a duplicate delivery of the *same* action replays (T035).
   * Errors are rethrown with a readable message: the capture box reports "原文已
   * 保存，但整理未完成" and the run id stays set so the diagnostics still explain
   * why. A failed organize must never be silent (T036-R01).
   */
  const organize = useCallback(
    async (
      item: { id: string; revision: number },
      context: { requestKey: string },
    ): Promise<OrganizeUiOutcome> => {
      try {
        const result = await apiRequest<RunResult>(`/api/items/${item.id}/organize`, {
          method: 'POST',
          body: { requestKey: context.requestKey, expectedRevision: item.revision },
        });
        setOrganizeRunId(result.runId);
        notifyChanged();
        if (result.state === 'conflict') {
          return {
            state: 'conflict',
            itemId: item.id,
            message: organizeConflictMessage(),
            warnings: result.warnings,
          };
        }
        if (result.state === 'failed') {
          return {
            state: 'failed',
            itemId: item.id,
            code: 'ORGANIZE_FAILED',
            message: result.warnings[0] ?? '整理没有完成',
            warnings: result.warnings,
          };
        }
        return {
          state: 'succeeded',
          itemId: item.id,
          message: '整理完成',
          warnings: result.warnings,
        };
      } catch (caught) {
        if (caught instanceof ApiClientError) {
          if (caught.code !== 'MODEL_NOT_CONFIGURED') setOrganizeRunId(null);
          throw caught;
        }
        throw caught;
      }
    },
    [notifyChanged],
  );

  return (
    <>
      <PageHeader
        title="收件箱"
        description="记录一个词、一句话或一段资料。原文先保存，整理可以稍后再做。"
      />
      <ConnectionNotice />
      <CaptureBox
        onCreated={onCreated}
        onConfigureModel={openSettings}
        modelConfigured={modelConfigured}
        organize={organize}
      />
      {organizeRunId ? (
        <details
          className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4"
          data-testid="organize-run-details"
          onToggle={(event) => setShowRunDetails((event.target as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer text-sm font-semibold text-[var(--ink)]">
            这次整理的详情
          </summary>
          {showRunDetails ? (
            <div className="mt-3">
              <RunDiagnosticsPanel runId={organizeRunId} onOpenItem={workspace.openItem} />
            </div>
          ) : null}
        </details>
      ) : null}
      <RecentItems onOpen={workspace.openItem} refreshToken={workspace.refreshToken} />
    </>
  );
}
