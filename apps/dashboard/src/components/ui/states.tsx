import { WarningCircle } from "@phosphor-icons/react/ssr";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { isApiError } from "@/lib/api";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton h-4", className)} />;
}

export function LoadingRows({ rows = 3, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="space-y-3">
      {Array.from({ length: rows }, (_, index) => <Skeleton key={index} className="h-12" />)}
    </div>
  );
}

export function ErrorNote({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = isApiError(error) ? error.message : "Something went wrong. Try again.";
  return (
    <div role="alert" className="flex items-start gap-3 rounded-md bg-danger/8 p-4 text-sm text-fg-2">
      <WarningCircle size={20} aria-hidden className="mt-px shrink-0 text-danger" />
      <div className="flex-1">
        <p>{message}</p>
        {retry ? (
          <button type="button" onClick={retry} className="mt-2 min-h-11 font-medium text-accent underline-offset-4 hover:underline">
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
      <p className="font-medium text-fg">{title}</p>
      {children ? <p className="mt-1 text-sm text-muted">{children}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl tracking-display lg:text-2xl">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}
