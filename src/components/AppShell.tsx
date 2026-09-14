'use client';

/**
 * Persistent application shell (T005-R02/R04/R05).
 *
 * The sidebar lives above the route content, so switching pages never remounts
 * the whole app. Loading indicators and errors are rendered inside the content
 * area rather than replacing the shell.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { findDestination, NAV_DESTINATIONS } from '@/features/shared/navigation';

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const current = findDestination(pathname ?? '');

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <nav
        aria-label="主导航"
        className="flex shrink-0 flex-row gap-1 overflow-x-auto border-b border-[var(--line)] bg-[var(--surface)] p-2 md:w-52 md:flex-col md:border-b-0 md:border-r md:p-3"
      >
        <div className="hidden px-2 py-3 md:block">
          <span className="text-sm font-semibold tracking-wide text-[var(--ink)]">
            Feini Brain
          </span>
        </div>
        {NAV_DESTINATIONS.map((destination) => {
          const active = current?.href === destination.href;
          return (
            <Link
              key={destination.href}
              href={destination.href}
              aria-current={active ? 'page' : undefined}
              className={`rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors ${
                active
                  ? 'bg-[var(--surface-raised)] font-semibold text-[var(--ink)]'
                  : 'text-[var(--ink-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]'
              }`}
            >
              {active ? <span aria-hidden="true">▪ </span> : null}
              {destination.label}
            </Link>
          );
        })}
      </nav>

      <main className="flex min-w-0 flex-1 flex-col gap-4 p-4 md:p-6">{children}</main>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-[var(--ink)]">{title}</h1>
        {description ? (
          <p className="max-w-prose text-sm text-[var(--ink-muted)]">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
