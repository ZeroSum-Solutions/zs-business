"use client";

import { CaretUpDown, CreditCard, GearSix, PlugsConnected } from "@phosphor-icons/react";
import Link from "next/link";
import { DropdownMenu } from "radix-ui";
import { cn } from "@/lib/utils";

// TODO(api): owner and business profile come from the session once auth is wired.
export const OWNER = { name: "Mara Halden", business: "Halden & Rowe", legalName: "Halden & Rowe Fine Jewelry", initials: "MH" };

const ITEMS = [
  { href: "/account/settings", label: "Settings", icon: GearSix },
  { href: "/account/connections", label: "Connections", icon: PlugsConnected },
  { href: "/account/plan", label: "Plan", icon: CreditCard },
];

export function AccountMenu({ variant }: { variant: "sidebar" | "topbar" }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label="Account menu"
        className={cn(
          "flex items-center gap-3 rounded-sm text-left transition-quick hover:bg-surface-warm data-[state=open]:bg-surface-warm",
          variant === "sidebar" ? "min-h-12 w-full px-2" : "size-11 justify-center",
        )}
      >
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-pill bg-accent/12 text-xs font-semibold text-accent">
          {OWNER.initials}
        </span>
        {variant === "sidebar" ? (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-fg">{OWNER.name}</span>
              <span className="block truncate text-xs text-meta">Owner</span>
            </span>
            <CaretUpDown size={16} aria-hidden className="text-meta" />
          </>
        ) : null}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={variant === "sidebar" ? "start" : "end"}
          side={variant === "sidebar" ? "top" : "bottom"}
          sideOffset={8}
          className="z-50 min-w-56 rounded-md bg-surface p-1 shadow-raised ring-1 ring-border data-[state=open]:animate-enter"
        >
          <DropdownMenu.Label className="px-3 py-2 text-xs text-meta">{OWNER.business}</DropdownMenu.Label>
          {ITEMS.map((item) => (
            <DropdownMenu.Item key={item.href} asChild>
              <Link
                href={item.href}
                className="flex min-h-11 items-center gap-3 rounded-sm px-3 text-sm text-fg outline-none data-[highlighted]:bg-surface-warm"
              >
                <item.icon size={20} aria-hidden className="text-muted" />
                {item.label}
              </Link>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
