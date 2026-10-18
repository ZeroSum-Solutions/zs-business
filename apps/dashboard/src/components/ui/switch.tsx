"use client";

import { Switch as SwitchPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** 44px tall hit area around a 24px track. */
export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "group relative inline-flex h-11 w-14 shrink-0 cursor-pointer items-center justify-center rounded-pill disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none flex h-6 w-11 items-center rounded-pill bg-border-strong p-0.5 transition-quick group-data-[state=checked]:bg-accent">
        <SwitchPrimitive.Thumb className="block size-5 rounded-pill bg-surface shadow-raised transition-quick data-[state=checked]:translate-x-5" />
      </span>
    </SwitchPrimitive.Root>
  );
}
