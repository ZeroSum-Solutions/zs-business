"use client";

import { CalendarPlus, Plus, UserPlus } from "@phosphor-icons/react";
import Link from "next/link";
import { DropdownMenu } from "radix-ui";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/calendar", label: "Appointment", hint: "Pick a time in Calendar", icon: CalendarPlus },
  { href: "/customers", label: "Customer", hint: "Add someone in Customers", icon: UserPlus },
];

/**
 * The header's "New" control: a round + on phones, a "+ New" pill from xl up. It opens a short
 * menu that goes to where each thing is created, so the create flows stay in one place.
 */
export function NewMenu({ className }: { className?: string }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label="New"
        className={cn(
          "press inline-flex size-11 shrink-0 items-center justify-center gap-1.5 rounded-pill bg-primary text-sm font-bold text-primary-on transition-quick hover:bg-primary-hover data-[state=open]:bg-primary-active",
          "xl:w-auto xl:pr-[18px] xl:pl-3.5",
          className,
        )}
      >
        <Plus size={22} weight="bold" aria-hidden className="xl:size-5" />
        <span aria-hidden className="hidden xl:inline">New</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="z-50 min-w-60 rounded-[18px] bg-surface p-1.5 shadow-raised ring-1 ring-border data-[state=open]:animate-enter"
        >
          <DropdownMenu.Label className="px-3 pt-2.5 pb-2 text-xs text-meta">Create new</DropdownMenu.Label>
          {ITEMS.map((item) => (
            <DropdownMenu.Item key={item.href} asChild>
              <Link href={item.href} className="flex min-h-11 items-center gap-3 rounded-md px-3 py-1.5 text-sm font-semibold text-fg data-[highlighted]:bg-tray">
                <span aria-hidden className="flex size-8 items-center justify-center rounded-[10px] bg-accent-tint text-accent-ink">
                  <item.icon size={18} />
                </span>
                <span className="min-w-0">
                  <span className="block">{item.label}</span>
                  <span className="block text-xs font-medium text-meta">{item.hint}</span>
                </span>
              </Link>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
