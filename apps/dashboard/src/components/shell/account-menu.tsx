"use client";

import { CaretDown, CreditCard, GearSix, PlugsConnected, SignOut } from "@phosphor-icons/react";
import Link from "next/link";
import { DropdownMenu } from "radix-ui";
import { useSession } from "@/lib/session";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

// TODO(api): owner and business profile come from the session once auth is wired.
export const OWNER = { name: "Mara Halden", business: "Halden & Rowe", legalName: "Halden & Rowe Fine Jewelry", initials: "MH" };

const ITEMS = [
  { href: "/account/settings", label: "Settings", icon: GearSix },
  { href: "/account/connections", label: "Connections", icon: PlugsConnected },
  { href: "/account/plan", label: "Plan", icon: CreditCard },
];

/** `header`: the desktop header (name and role from xl up). `topbar`: the phone bar, avatar only. */
export function AccountMenu({ variant }: { variant: "header" | "topbar" }) {
  const { signOut } = useSession();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className={cn(
          "flex min-h-11 min-w-11 items-center justify-center gap-2.5 rounded-pill p-1 text-left transition-quick hover:bg-tray data-[state=open]:bg-tray",
          variant === "header" && "xl:pr-3",
        )}
      >
        <span className="sr-only">Account menu</span>
        <Avatar name={OWNER.name} size="sm" />
        {variant === "header" ? (
          <>
            <span className="hidden min-w-0 leading-tight xl:block">
              <span className="block truncate text-sm font-bold text-fg">{OWNER.name}</span>
              <span className="block truncate text-xs text-meta">Owner</span>
            </span>
            <CaretDown size={16} aria-hidden className="hidden text-meta xl:block" />
          </>
        ) : null}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          side="bottom"
          sideOffset={8}
          className="z-50 min-w-56 rounded-[18px] bg-surface p-1.5 shadow-raised ring-1 ring-border data-[state=open]:animate-enter"
        >
          <DropdownMenu.Label className="px-3 pt-2.5 pb-2 text-xs text-meta">{OWNER.name}, Owner · {OWNER.business}</DropdownMenu.Label>
          {ITEMS.map((item) => (
            <DropdownMenu.Item key={item.href} asChild>
              <Link
                href={item.href}
                className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-semibold text-fg data-[highlighted]:bg-tray"
              >
                <item.icon size={20} aria-hidden className="text-muted" />
                {item.label}
              </Link>
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-border-soft" />
          <DropdownMenu.Item
            onSelect={() => signOut("signed_out")}
            className="flex min-h-11 cursor-default items-center gap-3 rounded-md px-3 text-sm font-semibold text-fg data-[highlighted]:bg-tray"
          >
            <SignOut size={20} aria-hidden className="text-muted" />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
