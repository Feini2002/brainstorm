'use client';

/**
 * Graph empty and error states (T045-R06, T050).
 *
 * Every state names a concrete next action. "没有任何知识" and "读取失败" are
 * different problems with different fixes, so they never share one message — a
 * user who sees "加载失败" when the library is simply empty would go looking for a
 * bug that does not exist.
 */
import type { ApiClientError } from '@/features/shared/apiClient';
import { Button, EmptyState, InlineError } from '@/components/ui/primitives';
import { EMPTY_STATES } from '@/features/shared/StatusLabel';

export interface GraphEmptyStateProps {
  /** True when the library has records but the filter matched none. */
  filtered: boolean;
  onOpenLibrary: () => void;
  onResetFilters: () => void;
}

export function GraphNoData({ filtered, onOpenLibrary, onResetFilters }: GraphEmptyStateProps) {
  if (filtered) {
    return (
      <div data-testid="graph-empty-filtered">
        <EmptyState
          title="当前筛选没有匹配到知识"
          description={EMPTY_STATES.noMatches}
          action={
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={onResetFilters}>
                清除筛选
              </Button>
              <Button variant="ghost" onClick={onOpenLibrary}>
                去资料库
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div data-testid="graph-empty-library">
      <EmptyState
        title="还没有可以连接的知识"
        description="关系图的节点来自知识条目。先在收件箱记录几条内容，再回来查看它们之间的关系。"
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={onOpenLibrary}>
              去资料库
            </Button>
          </div>
        }
      />
    </div>
  );
}

export interface GraphLoadErrorProps {
  error: ApiClientError;
  onRetry: () => void;
}

/**
 * A failed read leaves every other page working: the graph components are inside
 * their own error boundary at the route level, and this message only replaces the
 * canvas (T045-R06).
 */
export function GraphLoadError({ error, onRetry }: GraphLoadErrorProps) {
  return (
    <div data-testid="graph-load-error">
      <InlineError message={error.message}>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={onRetry}>
            重新读取
          </Button>
          <span className="text-xs">
            其它页面（收件箱、资料库）不受影响，可继续使用。
          </span>
        </div>
      </InlineError>
    </div>
  );
}
