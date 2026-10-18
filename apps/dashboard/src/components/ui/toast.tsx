"use client";

import { CheckCircle, Info, WarningCircle, X } from "@phosphor-icons/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "success" | "info" | "danger";
interface ToastItem { id: number; tone: Tone; message: string }

/** Long enough to read twice. Errors stay until dismissed. */
export const TOAST_MS = 10_000;

const ToastContext = createContext<((message: string, tone?: Tone) => void) | null>(null);

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  // The countdown stops while the pointer or focus is on the toast, so it never vanishes mid-read.
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (item.tone === "danger" || paused) return;
    const timer = setTimeout(() => onDismiss(item.id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [item, paused, onDismiss]);
  const Icon = item.tone === "success" ? CheckCircle : item.tone === "danger" ? WarningCircle : Info;
  return (
    <div
      data-testid="toast"
      data-tone={item.tone}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={(event) => event.key === "Escape" && onDismiss(item.id)}
      className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-md bg-fg py-1 pr-1 pl-4 text-sm text-bg shadow-raised animate-enter"
    >
      <Icon size={20} weight="regular" aria-hidden className={cn("mt-3 shrink-0", item.tone === "danger" ? "text-[color-mix(in_oklab,var(--danger),var(--bg)_55%)]" : "")} />
      <span className="min-w-0 flex-1 py-2.5 break-words">{item.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        aria-label="Dismiss"
        className="flex size-11 shrink-0 items-center justify-center rounded-sm text-bg/80 hover:bg-bg/10 hover:text-bg"
        style={{ outlineColor: "var(--bg)" }}
      >
        <X size={18} aria-hidden />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(0);
  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), []);
  const push = useCallback((message: string, tone: Tone = "success") => {
    const id = ++next.current;
    setItems((current) => [...current.slice(-2), { id, tone, message }]);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tabbar-height)+env(safe-area-inset-bottom)+12px)] z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6 lg:items-end lg:px-8"
      >
        {items.map((item) => <Toast key={item.id} item={item} onDismiss={dismiss} />)}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastContext);
  if (!push) throw new Error("useToast must be used inside <ToastProvider>");
  return push;
}
