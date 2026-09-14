'use client';

/**
 * Inbox (T013, T015, T024).
 *
 * Capture is available with or without a model configured: only the "save &
 * organize" action depends on settings, and it saves the raw text first so a
 * missing key can never cost the user their note (T013-R06).
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { PageHeader } from '@/components/AppShell';
import { CaptureBox } from '@/features/inbox/CaptureBox';
import { RecentItems } from '@/features/inbox/RecentItems';
import { ConnectionNotice } from '@/features/shared/ConnectionNotice';
import { apiRequest } from '@/features/shared/apiClient';
import { useWorkspace } from '@/features/shared/workspace';

interface LlmSettingsSummary {
  apiKeyConfigured: boolean;
}

export default function InboxPage() {
  const router = useRouter();
  const workspace = useWorkspace();
  const [modelConfigured, setModelConfigured] = useState(false);

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
    workspace.notifyChanged();
  }, [workspace]);

  const openSettings = useCallback(() => router.push('/settings'), [router]);

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
      />
      <RecentItems onOpen={workspace.openItem} refreshToken={workspace.refreshToken} />
    </>
  );
}
