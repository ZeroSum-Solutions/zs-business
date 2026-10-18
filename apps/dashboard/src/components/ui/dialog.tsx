"use client";

import { X } from "@phosphor-icons/react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/** Bottom sheet on phones, centered panel from 640px up. */
export function DialogContent({
  className,
  children,
  title,
  description,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { title: string; description?: ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-fg/30 data-[state=open]:animate-enter" />
      <DialogPrimitive.Content
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-lg bg-surface shadow-raised pb-safe data-[state=open]:animate-enter",
          "sm:inset-x-auto sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:w-[min(560px,calc(100vw-48px))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg",
          className,
        )}
        {...(description ? {} : { "aria-describedby": undefined })}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border-soft px-4 pt-4 pb-3 sm:px-6">
          <div>
            <DialogPrimitive.Title className="text-lg font-semibold text-fg">{title}</DialogPrimitive.Title>
            {description ? <DialogPrimitive.Description className="mt-0.5 text-sm text-muted">{description}</DialogPrimitive.Description> : null}
          </div>
          <DialogPrimitive.Close className="-mr-2 -mt-1 inline-flex size-11 items-center justify-center rounded-sm text-muted transition-quick hover:bg-surface-warm hover:text-fg" aria-label="Close">
            <X size={20} aria-hidden />
          </DialogPrimitive.Close>
        </div>
        <div className="overflow-x-hidden overflow-y-auto px-4 py-4 sm:px-6 sm:pb-6">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
