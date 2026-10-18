"use client";

import { CheckCircle, Info, WarningCircle } from "@phosphor-icons/react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "success" | "info" | "danger";
interface ToastItem { id: number; tone: Tone; message: string }

const ToastContext = createContext<((message: string, tone?: Tone) => void) | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(0);
  const push = useCallback((message: string, tone: Tone = "success") => {
    const id = ++next.current;
    setItems((current) => [...current.slice(-2), { id, tone, message }]);
    setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), 5000);
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
        {items.map((item) => {
          const Icon = item.tone === "success" ? CheckCircle : item.tone === "danger" ? WarningCircle : Info;
          return (
            <div
              key={item.id}
              className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-md bg-fg px-4 py-3 text-sm text-bg shadow-raised animate-enter"
            >
              <Icon size={20} weight="regular" aria-hidden className={cn("mt-px shrink-0", item.tone === "danger" ? "text-[color-mix(in_oklab,var(--danger),var(--bg)_55%)]" : "")} />
              <span>{item.message}</span>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastContext);
  if (!push) throw new Error("useToast must be used inside <ToastProvider>");
  return push;
}
