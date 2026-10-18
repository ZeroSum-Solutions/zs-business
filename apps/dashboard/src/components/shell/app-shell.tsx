"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useApiRuntime } from "@/lib/api/react";
import { useThreads } from "@/lib/queries";
import { useTenantId } from "@/lib/session";
import { cn } from "@/lib/utils";
import { AccountMenu, OWNER } from "./account-menu";
import { isActive, NAV_ITEMS } from "./nav";
import { SessionGate } from "./session-gate";

function Brand() {
  return (
    <Link href="/" className="flex min-h-11 items-center gap-3 rounded-sm">
      <span aria-hidden className="flex size-8 items-center justify-center rounded-sm bg-fg text-[13px] font-semibold tracking-tight text-bg">
        H&amp;R
      </span>
      <span className="text-[15px] font-semibold text-fg">{OWNER.business}<span className="sr-only">, home</span></span>
    </Link>
  );
}

function useInboxCount(): number {
  const threads = useThreads();
  // Signed out, the cache is empty and the count must not linger.
  if (useTenantId() === null) return 0;
  return threads.data?.filter((thread) => thread.unread).length ?? 0;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const unread = useInboxCount();
  const { mode } = useApiRuntime();

  // Sign-in stands alone: no navigation into areas the visitor cannot open yet.
  if (pathname === "/sign-in") {
    return (
      <main id="main" className="mx-auto min-h-dvh w-full max-w-content px-4 pt-5 sm:px-6 lg:px-8">
        <div className="pt-2"><Brand /></div>
        {children}
      </main>
    );
  }

  return (
    <div className="relative min-h-dvh lg:pl-[var(--sidebar-width)]">
      <a href="#main" className="sr-only z-[70] rounded-sm bg-surface focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:inline-flex focus:min-h-11 focus:items-center focus:px-4">
        Skip to content
      </a>

      {/* Desktop side nav */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[var(--sidebar-width)] flex-col border-r border-border bg-surface-warm/60 px-3 py-4 lg:flex">
        <div className="px-2"><Brand /></div>
        <nav aria-label="Main" className="mt-6 flex-1">
          <ul className="space-y-0.5">
            {NAV_ITEMS.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex min-h-11 items-center gap-3 rounded-sm px-3 text-sm font-medium transition-quick",
                      active ? "bg-surface text-accent shadow-ring" : "text-fg-2 hover:bg-surface hover:text-fg",
                    )}
                  >
                    <item.icon size={20} weight={active ? "fill" : "regular"} aria-hidden />
                    <span className="flex-1">{item.label}</span>
                    {item.href === "/inbox" && unread > 0 ? (
                      <span className="tabular rounded-pill bg-accent px-1.5 text-xs font-semibold text-accent-on" aria-label={`${unread} unread`}>{unread}</span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <p className="px-3 pb-3 text-xs text-meta" data-testid="sample-note">
          {mode === "demo" ? "Sample data. Changes reset on reload." : "Some areas show sample data until their API ships."}
        </p>
        <div className="border-t border-border pt-3"><AccountMenu variant="sidebar" /></div>
      </aside>

      {/* Phone top bar */}
      <header className="sticky top-0 z-30 flex h-[var(--topbar-height)] items-center justify-between border-b border-border bg-bg/90 px-4 backdrop-blur-sm lg:hidden">
        <Brand />
        <AccountMenu variant="topbar" />
      </header>

      <main id="main" className="mx-auto w-full max-w-content px-4 pt-5 pb-[calc(var(--tabbar-height)+env(safe-area-inset-bottom)+32px)] sm:px-6 lg:px-8 lg:pt-8 lg:pb-12">
        <SessionGate>{children}</SessionGate>
      </main>

      {/* Phone bottom tabs */}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 pb-safe backdrop-blur-sm lg:hidden">
        <ul className="grid h-[var(--tabbar-height)] grid-cols-6">
          {NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex h-full flex-col items-center justify-center gap-1 text-[11px] font-medium transition-quick",
                    active ? "text-accent" : "text-muted hover:text-fg",
                  )}
                >
                  <span className="relative">
                    <item.icon size={24} weight={active ? "fill" : "regular"} aria-hidden />
                    {item.href === "/inbox" && unread > 0 ? (
                      <span className="absolute -top-1 -right-2 min-w-4 rounded-pill bg-accent px-1 text-center text-[10px] leading-4 font-semibold text-accent-on" aria-label={`${unread} unread`}>
                        {unread}
                      </span>
                    ) : null}
                  </span>
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
