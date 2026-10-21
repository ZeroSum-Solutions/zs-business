import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "min-h-11 w-full rounded-sm bg-well px-3 text-base text-fg shadow-field transition-quick focus:shadow-[inset_0_0_0_1px_var(--accent)] placeholder:text-meta",
        "aria-invalid:shadow-[inset_0_0_0_1px_var(--danger)] disabled:opacity-50 lg:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "min-h-24 w-full rounded-sm bg-well px-3 py-2.5 text-base text-fg shadow-field transition-quick focus:shadow-[inset_0_0_0_1px_var(--accent)] placeholder:text-meta lg:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("mb-1.5 block text-sm font-medium text-fg-2", className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "min-h-11 rounded-sm bg-well px-3 text-base text-fg lg:text-sm shadow-field transition-quick focus:shadow-[inset_0_0_0_1px_var(--accent)]",
        className,
      )}
      {...props}
    />
  );
}
