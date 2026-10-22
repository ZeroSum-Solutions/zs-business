"use client";

import { X } from "@phosphor-icons/react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useRef, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/**
 * Bottom sheet on phones, centered panel from 640px up. Our sheets open from state, not a
 * Radix Trigger, so Radix has nothing to refocus on close: the sheet remembers the control
 * that had focus when it opened and returns focus there.
 */
export function DialogContent({
  className,
  children,
  title,
  description,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { title: string; description?: ReactNode }) {
  const opener = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-xs data-[state=open]:animate-enter" />
      <DialogPrimitive.Content
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-tray bg-surface shadow-raised ring-1 ring-inset ring-border pb-safe data-[state=open]:animate-enter",
          "sm:inset-x-auto sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:w-[min(560px,calc(100vw-48px))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-tray",
          className,
        )}
        {...(description ? {} : { "aria-describedby": undefined })}
        {...props}
        onOpenAutoFocus={(event) => {
          // Runs before focus moves into the sheet, so this is still the opener.
          const active = document.activeElement;
          opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
          onOpenAutoFocus?.(event);
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          const target = opener.current;
          opener.current = null;
          if (event.defaultPrevented || !target?.isConnected) return;
          event.preventDefault();
          target.focus({ preventScroll: true });
        }}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border-soft px-4 pt-4 pb-3 sm:px-6">
          <div>
            <DialogPrimitive.Title className="text-xl font-extrabold tracking-[-0.02em] text-fg">{title}</DialogPrimitive.Title>
            {description ? <DialogPrimitive.Description className="mt-0.5 text-sm text-muted">{description}</DialogPrimitive.Description> : null}
          </div>
          <DialogPrimitive.Close className="-mr-2 -mt-1 inline-flex size-11 items-center justify-center rounded-pill text-muted transition-quick hover:bg-inset hover:text-fg" aria-label="Close">
            <X size={20} aria-hidden />
          </DialogPrimitive.Close>
        </div>
        {/* Same horizontal inset as the header; e2e checks nothing scrolls it sideways. */}
        <div data-slot="dialog-body" className="min-w-0 overflow-x-hidden overflow-y-auto px-4 py-4 sm:px-6 sm:pb-6">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
