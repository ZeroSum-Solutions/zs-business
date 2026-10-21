"use client";

// Adapted from Cult UI "Halo Tabs" (MIT; see NOTICE). Changes: built on our own buttons and links
// instead of @base-ui/react tabs (these switch views, they are not tab panels), a motion layoutId
// indicator instead of CSS position variables, and our tokens in place of the gradient rim.

import { LayoutGroup, motion } from "motion/react";
import Link from "next/link";
import { useId } from "react";
import { SPRING_LAYOUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** A pressed-button group with a pill that slides to the chosen option. */
export function Segmented<T extends string>({ label, value, options, onChange, className }: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  const id = useId();
  return (
    <LayoutGroup id={id}>
      <div role="group" aria-label={label} className={cn("inline-flex rounded-pill bg-surface-warm p-1", className)}>
        {options.map((option) => {
          const active = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(option.value)}
              className={cn(
                "relative min-h-11 rounded-pill px-4 text-sm font-medium transition-quick",
                active ? "text-fg" : "text-muted hover:text-fg",
              )}
            >
              {active ? (
                <motion.span layoutId="pill" transition={SPRING_LAYOUT} aria-hidden className="absolute inset-0 rounded-pill bg-surface shadow-card" />
              ) : null}
              <span className="relative">{option.label}</span>
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

/** Link tabs for views of one page, with an underline that slides to the current view. */
export function ViewTabs({ label, current, tabs, className }: {
  label: string;
  current: string;
  tabs: readonly { id: string; label: string; href: string }[];
  className?: string;
}) {
  const id = useId();
  return (
    <LayoutGroup id={id}>
      <nav aria-label={label} className={cn("flex gap-1 border-b border-border", className)}>
        {tabs.map((tab) => {
          const active = current === tab.id;
          return (
            <Link
              key={tab.id}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative inline-flex min-h-11 items-center px-3 text-sm font-medium transition-quick",
                active ? "text-fg" : "text-muted hover:text-fg",
              )}
            >
              {tab.label}
              {active ? (
                <motion.span layoutId="underline" transition={SPRING_LAYOUT} aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 rounded-pill bg-accent" />
              ) : null}
            </Link>
          );
        })}
      </nav>
    </LayoutGroup>
  );
}
