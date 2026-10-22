"use client";

import { motion, MotionConfig } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useApiRuntime } from "@/lib/api/react";
import { useInboxCount } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { AccountMenu, OWNER } from "./account-menu";
import { isActive, NAV_ITEMS } from "./nav";
import { NewMenu } from "./new-menu";
import { SessionGate } from "./session-gate";
import { useLayoutTransition, useReducedMotionLive } from "@/lib/motion";

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="flex min-h-11 shrink-0 items-center gap-2.5 rounded-md">
      <span aria-hidden className="flex size-9 items-center justify-center rounded-[11px] bg-ink text-xs font-extrabold tracking-[-0.02em] text-ink-on">
        H&amp;R
      </span>
      <span className={cn("text-base font-bold tracking-[-0.01em] text-fg", compact && "sr-only xl:not-sr-only")}>
        {OWNER.business}<span className="sr-only">, home</span>
      </span>
    </Link>
  );
}

function InboxBadge({ waiting, className }: { waiting: number; className?: string }) {
  if (waiting <= 0) return null;
  return (
    <span
      className={cn("tabular min-w-[18px] rounded-pill bg-white px-[5px] text-center text-[11px] leading-[18px] font-extrabold text-[#141418]", className)}
      aria-label={`${waiting} need attention`}
    >
      {waiting}
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // MotionConfig's "user" mode reads the setting once; these follow a change made while the app is open.
  const reduceMotion = useReducedMotionLive();
  const layoutTransition = useLayoutTransition();
  const waiting = useInboxCount();
  const { mode } = useApiRuntime();

  // Sign-in stands alone: no navigation into areas the visitor cannot open yet.
  if (pathname === "/sign-in") {
    return (
      <main id="main" className="mx-auto min-h-dvh w-full max-w-content px-4 pt-3 sm:px-6 lg:px-10 lg:pt-6">
        <div className="pb-4"><Brand /></div>
        {children}
      </main>
    );
  }

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "never"}>
    <div className="relative mx-auto flex min-h-dvh w-full max-w-content flex-col px-4 sm:px-6 lg:px-10">
      <a href="#main" className="sr-only z-[70] rounded-pill bg-surface font-bold focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:inline-flex focus:min-h-11 focus:items-center focus:px-4">
        Skip to content
      </a>

      {/* Phone: brand, a round +, the account. Desktop: brand, the pill nav centred, New and the account. */}
      <header className="flex h-[var(--topbar-height)] items-center justify-between gap-3 lg:grid lg:h-[88px] lg:grid-cols-[1fr_auto_1fr]">
        <div className="lg:hidden"><Brand /></div>
        <div className="hidden lg:block"><Brand compact /></div>
        <nav aria-label="Main" className="hidden rounded-pill bg-nav p-[5px] shadow-[0_8px_22px_-12px_rgba(20,20,24,.5)] ring-1 ring-border/40 lg:block">
          <ul className="flex gap-0.5">
            {NAV_ITEMS.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href} className="relative">
                  {active ? <motion.span layoutId="nav-active" transition={layoutTransition} aria-hidden className="absolute inset-0 rounded-pill bg-nav-lit" /> : null}
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    style={{ outlineColor: "var(--nav-focus)" }}
                    className={cn(
                      "press relative flex min-h-11 items-center gap-2 rounded-pill pr-4 pl-3.5 text-sm font-bold whitespace-nowrap transition-quick",
                      active ? "text-accent-on" : "text-nav-fg hover:text-nav-fg-strong",
                    )}
                  >
                    <item.icon size={19} weight={active ? "fill" : "regular"} aria-hidden />
                    {item.label}
                    {item.href === "/inbox" ? <InboxBadge waiting={waiting} className="ml-0.5" /> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="flex items-center gap-2 lg:justify-self-end">
          <NewMenu />
          <div className="lg:hidden"><AccountMenu variant="topbar" /></div>
          <div className="hidden lg:block"><AccountMenu variant="header" /></div>
        </div>
      </header>

      <main id="main" className="w-full flex-1 pt-3 pb-8 lg:pt-6 lg:pb-12">
        <SessionGate>{children}</SessionGate>
      </main>

      <footer className="pb-[calc(var(--tabbar-height)+env(safe-area-inset-bottom)+24px)] text-center lg:pb-10">
        <p className="text-caption text-meta" data-testid="sample-note">
          {mode === "demo" ? "Sample data. Changes reset on reload." : "Some areas show sample data until their API ships."}
        </p>
      </footer>

      {/* Phone: a floating ink dock, 16px off the bottom edge. */}
      <nav aria-label="Main" className="fixed inset-x-4 bottom-[calc(16px+env(safe-area-inset-bottom))] z-30 rounded-pill bg-nav p-1.5 shadow-raised ring-1 ring-border/40 lg:hidden">
        <ul className="grid grid-cols-6 gap-0.5">
          {NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href} className="relative">
                {active ? <motion.span layoutId="tab-active" transition={layoutTransition} aria-hidden className="absolute inset-0 rounded-pill bg-nav-lit" /> : null}
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  style={{ outlineColor: "var(--nav-focus)" }}
                  className={cn(
                    "press relative flex min-h-[52px] flex-col items-center justify-center gap-[3px] rounded-pill text-[10.5px] font-semibold tracking-[-0.01em] whitespace-nowrap transition-quick",
                    active ? "text-accent-on" : "text-nav-fg hover:text-nav-fg-strong",
                  )}
                >
                  <item.icon size={21} weight={active ? "fill" : "regular"} aria-hidden />
                  {item.label}
                  {item.href === "/inbox" ? <InboxBadge waiting={waiting} className="absolute top-1 left-[calc(50%+6px)]" /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
    </MotionConfig>
  );
}
