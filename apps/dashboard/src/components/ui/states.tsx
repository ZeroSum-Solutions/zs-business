import { WarningCircle } from "@phosphor-icons/react/ssr";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { isApiError, readEnvConfig } from "@/lib/api";

// The 404 page is a server component, so the header lives where it pulls in no API code.
export { PageHeader } from "./page-header";

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

export function ErrorNote({ error, retry, message: override }: { error: unknown; retry?: (() => void) | undefined; message?: string | undefined }) {
  const message = override ?? (isApiError(error) ? error.message : "Something went wrong. Try again.");
  // Retrying cannot fix an ended session; offer the way back in instead.
  const signedOut = isApiError(error) && error.kind === "unauthorized";
  return (
    <div role="alert" className="flex items-start gap-3 rounded-md bg-danger-tint p-4 text-sm text-fg-2">
      <WarningCircle size={20} aria-hidden className="mt-px shrink-0 text-danger" />
      <div className="flex-1">
        <p>{message}</p>
        {signedOut ? (
          <button type="button" onClick={() => window.location.assign(readEnvConfig().mode === "live" ? "/sign-in" : "/")} className="mt-2 min-h-11 font-bold text-accent-ink underline-offset-4 hover:underline">
            Sign in again
          </button>
        ) : retry ? (
          <button type="button" onClick={retry} className="mt-2 min-h-11 font-bold text-accent-ink underline-offset-4 hover:underline">
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Shown when a list stopped at the page cap, so a missing row is not mistaken for "none". */
export function IncompleteNote({ list }: { list: { incomplete: boolean; loaded: number } | undefined }) {
  if (!list?.incomplete) return null;
  return (
    <p role="status" data-testid="list-incomplete" className="mb-3 flex items-start gap-2 rounded-md bg-warn-tint p-3 text-sm text-fg-2">
      <WarningCircle size={20} aria-hidden className="mt-px shrink-0 text-warn" />
      <span>List incomplete — showing first {list.loaded.toLocaleString("en-US")}.</span>
    </p>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border-strong bg-surface px-4 py-8 text-center">
      <p className="font-bold text-fg">{title}</p>
      {children ? <p className="mt-1 text-sm text-muted">{children}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** `sample` marks a page whose content is the built-in sample workspace in live mode. */
