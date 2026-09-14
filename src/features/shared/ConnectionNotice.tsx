'use client';

/**
 * Connection notice (T024).
 *
 * Everything that does not need a model works offline: capture, list, detail,
 * edit, delete and manual relations never touch LLMService and never check for a
 * key first (T024-R02). Only generating new AI output needs an external service.
 *
 * The notice therefore describes which concrete actions are affected, and never
 * claims the whole app survives the local Node process being stopped (T024-R06).
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';

import type { HealthInfo } from '@/domain/api';
import { Button } from '@/components/ui/primitives';
import { apiRequest } from '@/features/shared/apiClient';

type LocalState = 'checking' | 'up' | 'down';

export interface ConnectionNoticeProps {
  /** Hide the notice entirely on pages that are purely local. */
  alwaysVisible?: boolean;
}

export function ConnectionNotice({ alwaysVisible = false }: ConnectionNoticeProps) {
  const [localState, setLocalState] = useState<LocalState>('checking');
  const [retryToken, setRetryToken] = useState(0);

  // The probe resolves asynchronously, so state only changes in the continuation
  // rather than synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await apiRequest<HealthInfo>('/api/health', { anonymous: true });
        if (!cancelled) setLocalState('up');
      } catch {
        // The local Node process itself is unreachable — that is different from
        // "no external model". Only then does the whole app stop.
        if (!cancelled) setLocalState('down');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [retryToken]);

  if (localState === 'checking') return null;

  if (localState === 'down') {
    return (
      <div
        role="alert"
        className="rounded-md border border-[var(--danger)] bg-[var(--surface)] p-3 text-sm text-[var(--danger)]"
      >
        <p className="font-medium">本地服务没有响应</p>
        <p className="mt-1 text-[var(--ink-muted)]">
          本地服务进程已停止，读写都无法进行。请重新启动应用（npm run dev）后刷新页面。
        </p>
        <Button
          variant="secondary"
          className="mt-2"
          onClick={() => {
            setLocalState('checking');
            setRetryToken((value) => value + 1);
          }}
        >
          再试一次
        </Button>
      </div>
    );
  }

  if (!alwaysVisible) return null;

  return (
    <div className="rounded-md border border-[var(--line)] bg-[var(--surface-raised)] p-3 text-sm text-[var(--ink-muted)]">
      <p>
        保存、搜索、编辑、删除与人工关系都在本机完成，不联网也能使用。只有
        <span className="text-[var(--ink)]">「保存并整理」</span>、思维导图和流程图需要先在
        <Link href="/settings" className="mx-1 text-[var(--ink)] underline">
          设置
        </Link>
        里配置模型。
      </p>
    </div>
  );
}
