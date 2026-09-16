'use client';

/**
 * Source list for one projection node (T058).
 *
 * A leaf's sources, or a group's merged subtree sources, rendered as the app's
 * own React list — never as HTML or a link the model produced (T058-R01). The
 * model supplies ids; every row is resolved against the local API here.
 *
 * The three states a source can be in are kept distinct, because collapsing them
 * would misrepresent the data:
 *
 *  - **live and unchanged** — the item exists at the version the view recorded;
 *  - **live but changed** — the item exists at a different version, so the view is
 *    a snapshot and the record may no longer say what the node summarises
 *    (T058-C03). Shown as an explicit "生成于 v1，当前 v2" note rather than
 *    silently refreshed, since re-reading the item is what a reader would
 *    otherwise assume happened;
 *  - **missing** — the item was deleted. The row still appears, named and
 *    explained, because a source that vanished is itself information and an
 *    infinite spinner (or a row that silently disappears, changing the count the
 *    outline showed) is the failure T058-C04 names.
 *
 * The snapshot is the authority for *what the view was built from*. It is looked
 * up by id here rather than re-derived from the item, so a saved view that
 * predates an edit still reports the version it actually used.
 *
 * Deduplication (T058-R03) happens before rendering: the same item cited under
 * several branches appears once per list. Two branches citing one note is one
 * piece of knowledge organised twice, not two notes — and the outline already
 * shows the per-node counts, which is where the repeated reference is visible.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ItemDTO, SourceSnapshot, UUID } from '@/domain/knowledge';
import { Button, InlineError, LoadingIndicator } from '@/components/ui/primitives';
import { ApiClientError, apiRequest } from '@/features/shared/apiClient';
import { MISSING_SOURCE_LABEL } from '@/features/shared/StatusLabel';

export interface SourceListProps {
  /** Ids this node cites, in the tree's own order. Duplicates are removed here. */
  itemIds: readonly UUID[];
  /** The view's snapshot, which says which version each source was read at. */
  snapshot: SourceSnapshot;
  /** Open the shared detail drawer for a live item. */
  onOpenItem: (itemId: string) => void;
  /** Human label for the node, used in the list heading. */
  nodeLabel: string;
}

interface SourceRow {
  id: UUID;
  /** Raw version the view recorded for this item, or null when not in the snapshot. */
  snapshotRawVersion: number | null;
  item: ItemDTO | null;
  missing: boolean;
  changed: boolean;
}

/**
 * One completed read, tagged with the request it answers.
 *
 * The tag is what makes "still loading" a *derivation* rather than a second piece
 * of state: when the node selection changes, `requestKey` changes too, the stored
 * result no longer matches it, and the list renders as loading again — without an
 * effect that synchronously clears state on every selection. Resetting inside the
 * effect would render the previous node's sources for one frame and then blank
 * them, which is exactly the kind of flicker a reader reads as "this node cited
 * that note".
 */
interface SourceRead {
  key: string;
  rows: SourceRow[];
  error: ApiClientError | null;
}

/** Read one item; `null` when it does not exist (404) and an error otherwise. */
async function readItem(itemId: string): Promise<{ item: ItemDTO | null; error: ApiClientError | null }> {
  try {
    return { item: await apiRequest<ItemDTO>(`/api/items/${itemId}`), error: null };
  } catch (caught) {
    if (caught instanceof ApiClientError && caught.code === 'NOT_FOUND') {
      return { item: null, error: null };
    }
    return {
      item: null,
      error:
        caught instanceof ApiClientError
          ? caught
          : new ApiClientError({ code: 'INTERNAL', message: '无法读取来源', retryable: true }),
    };
  }
}

export function SourceList({ itemIds, snapshot, onOpenItem, nodeLabel }: SourceListProps) {
  const [read, setRead] = useState<SourceRead | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  /**
   * Distinct ids, in first-seen order.
   *
   * Order is preserved rather than sorted because the tree's order is the model's
   * own prioritisation of the material; re-sorting would present a different
   * ranking than the node it explains.
   */
  const uniqueIds = useMemo(() => [...new Set(itemIds)], [itemIds]);

  const snapshotVersions = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of snapshot.items) map.set(entry.id, entry.rawVersion);
    return map;
  }, [snapshot]);

  // Identity of the read this render needs. `uniqueIds` is already a stable new
  // array per change, but it is joined here so the key is a value rather than an
  // object reference — the token can then be compared, stored and reasoned about.
  const requestKey = `${reloadToken}\u0000${uniqueIds.join(',')}\u0000${[
    ...snapshotVersions.entries(),
  ]
    .map(([id, version]) => `${id}@${version}`)
    .join(',')}`;

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // Every id is fetched individually so a deleted source is detected
      // per-record. A batch endpoint that silently omitted the missing ones would
      // make "3 of 4 sources still exist" unobservable.
      const results = await Promise.all(uniqueIds.map((id) => readItem(id)));
      if (cancelled) return;

      const firstError = results.find((entry) => entry.error !== null)?.error ?? null;
      if (firstError) {
        setRead({ key: requestKey, rows: [], error: firstError });
        return;
      }

      setRead({
        key: requestKey,
        error: null,
        rows: uniqueIds.map((id, index) => {
          const item = results[index]!.item;
          const snapshotRawVersion = snapshotVersions.get(id) ?? null;
          return {
            id,
            snapshotRawVersion,
            item,
            missing: item === null,
            changed:
              item !== null &&
              snapshotRawVersion !== null &&
              item.rawVersion !== snapshotRawVersion,
          };
        }),
      });
    })();

    return () => {
      cancelled = true;
    };
    // `requestKey` is the whole input of this read: any change to the node, the
    // snapshot or the retry counter starts a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  const current = read !== null && read.key === requestKey ? read : null;
  const rows = current?.rows ?? null;
  const error = current?.error ?? null;

  const refresh = useCallback(() => setReloadToken((value) => value + 1), []);

  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3"
      aria-label={`「${nodeLabel}」的来源`}
      data-testid="source-list"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--ink)]">来源材料</h3>
        <span className="text-xs text-[var(--ink-muted)]" data-testid="source-list-count">
          {rows === null ? null : `${rows.length} 条（已去重）`}
        </span>
      </header>

      {error ? (
        <InlineError message={error.message}>
          <div>
            <Button variant="secondary" onClick={refresh}>
              重新读取
            </Button>
          </div>
        </InlineError>
      ) : null}

      {rows === null && !error ? <LoadingIndicator label="正在读取这张视图的来源" /> : null}

      {rows !== null && rows.length === 0 && !error ? (
        <p className="text-sm text-[var(--ink-muted)]">
          这个节点没有记录来源。它可能是旧版本生成的，无法核对依据，也不会因此改动任何知识条目。
        </p>
      ) : null}

      {rows !== null && rows.length > 0 ? (
        <ul className="flex flex-col gap-2" data-testid="source-list-items">
          {rows.map((row) => (
            <li
              key={row.id}
              data-testid="source-list-item"
              data-item-id={row.id}
              data-state={row.missing ? 'missing' : row.changed ? 'changed' : 'current'}
              className="flex flex-col gap-1 rounded-md border border-[var(--line)] p-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-words text-sm text-[var(--ink)]">
                  {row.item
                    ? row.item.title.trim() || row.item.capturedText.split('\n')[0] || '未命名记录'
                    : `${MISSING_SOURCE_LABEL}（${row.id.slice(0, 8)}…）`}
                </span>
                {row.item ? (
                  <Button
                    variant="secondary"
                    data-testid="source-open"
                    onClick={() => onOpenItem(row.id)}
                  >
                    打开原文
                  </Button>
                ) : null}
              </div>

              {row.missing ? (
                <p className="text-xs text-[var(--warn-ink)]" data-testid="source-missing">
                  {MISSING_SOURCE_LABEL}。这张视图保留生成时的样子，不会因此重建或去掉这个节点，
                  也不会自动删除或改写任何知识条目。
                </p>
              ) : null}

              {row.changed ? (
                <p className="text-xs text-[var(--warn-ink)]" data-testid="source-changed">
                  生成时是 v{row.snapshotRawVersion}，当前已是 v{row.item!.rawVersion}；
                  下面的内容仍是生成当时的快照。
                </p>
              ) : null}

              {!row.missing && !row.changed && row.snapshotRawVersion !== null ? (
                <p className="text-xs text-[var(--ink-muted)]" data-testid="source-current">
                  与生成时一致（v{row.snapshotRawVersion}）。
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
