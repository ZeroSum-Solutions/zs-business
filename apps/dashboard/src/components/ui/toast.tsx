"use client";

import { CheckCircle, Info, WarningCircle, X } from "@phosphor-icons/react";
import { usePathname, useSearchParams } from "next/navigation";
import { createContext, Suspense, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "success" | "info" | "danger";
export interface ToastItem {
  id: number;
  tone: Tone;
  message: string;
  /** The open sheet it was raised in, or null for the page. */
  sheet: string | null;
  /** A later toast on the same topic replaces this one, so two answers about one thing never disagree. */
  topic?: string;
  /** Raised for the page about to open ("Added …", then the record opens): it survives that one page change. */
  keepOnNavigate?: boolean;
}
export interface ToastOptions { topic?: string; keepOnNavigate?: boolean }

/** Long enough to read twice. Errors stay until dismissed. */
export const TOAST_MS = 10_000;
/** Toasts shown at once on the page. A sheet, or the page on a phone, shows the newest only. */
export const MAX_TOASTS = 2;
const capFor = (sheet: string | null, phone: boolean) => (sheet === null && !phone ? MAX_TOASTS : 1);

const sticky = (item: ToastItem) => item.tone === "danger";

/**
 * What `sheet`'s place shows: the newest toast always, then the newest errors, then the rest, up
 * to the cap. `waiting` counts the errors held back until one shown is dismissed.
 */
export function shownToasts(items: readonly ToastItem[], sheet: string | null, phone = false): { toasts: ToastItem[]; waiting: number } {
  const here = items.filter((item) => item.sheet === sheet);
  const older = here.slice(0, -1).reverse();
  const picked = [...here.slice(-1), ...older.filter(sticky), ...older.filter((item) => !sticky(item))].slice(0, capFor(sheet, phone));
  const toasts = here.filter((item) => picked.includes(item));
  return { toasts, waiting: here.length - toasts.length };
}

/** Over the cap, errors wait their turn; a toast that would close by itself goes, so it never shows late. */
function capped(items: ToastItem[], sheet: string | null, phone: boolean): ToastItem[] {
  const { toasts } = shownToasts(items, sheet, phone);
  return items.filter((item) => item.sheet !== sheet || sticky(item) || toasts.includes(item));
}

/** Adds a toast. The same words in the same place, or the same topic, replace the earlier one. */
export function addToast(items: readonly ToastItem[], next: ToastItem, phone = false): ToastItem[] {
  const kept = items.filter((item) => {
    if (next.topic !== undefined && item.topic === next.topic) return false;
    return !(item.sheet === next.sheet && item.message === next.message && item.tone === next.tone);
  });
  return capped([...kept, next], next.sheet, phone);
}

export const clearTopic = (items: readonly ToastItem[], topic: string): ToastItem[] => items.filter((item) => item.topic !== topic);

/** The page an address names. Pipeline and Contacts share a path, so the query counts too. */
export const pageKey = (pathname: string, search: string) => (search ? `${pathname}?${search}` : pathname);

/** A new page: what the last page said no longer applies, unless it was said for this page. */
export const afterRouteChange = (items: readonly ToastItem[]): ToastItem[] =>
  items.filter((item) => item.keepOnNavigate).map(({ keepOnNavigate: _kept, ...item }) => item);

/** A sheet opened over the page: page toasts that would close by themselves go; errors wait. */
export const afterSheetOpened = (items: readonly ToastItem[]): ToastItem[] => items.filter((item) => item.sheet !== null || sticky(item));

/** A sheet closed: its toasts (often the one raised as it closed) move to the sheet below, or the page. */
export function afterSheetClosed(items: readonly ToastItem[], sheet: string, under: string | null, phone = false): ToastItem[] {
  return capped(items.map((item) => (item.sheet === sheet ? { ...item, sheet: under } : item)), under, phone);
}

/** The page became phone-sized: page toasts it has no room for go, errors wait. */
export const afterScreenChange = (items: readonly ToastItem[], phone: boolean): ToastItem[] => capped([...items], null, phone);

// Tailwind's `max-sm`. The server render assumes a wider screen; no toast exists before hydration.
const PHONE = "(width < 40rem)";
const isPhone = () => !!window.matchMedia?.(PHONE).matches;
function watchPhone(change: () => void) {
  const query = window.matchMedia?.(PHONE);
  query?.addEventListener("change", change);
  return () => query?.removeEventListener("change", change);
}

type Push = (message: string, tone?: Tone, options?: ToastOptions) => void;
const ToastContext = createContext<Push | null>(null);
interface ToastState {
  items: ToastItem[];
  dismiss: (id: number) => void;
  clear: (topic: string) => void;
  openSheet: (sheet: string) => void;
  closeSheet: (sheet: string) => void;
}
const ToastStateContext = createContext<ToastState | null>(null);

/** Toasts held back, so the owner knows to dismiss one. */
function Waiting({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <p data-testid="toast-waiting" className={cn("w-full max-w-sm rounded-pill bg-ink px-4 py-1.5 text-xs font-semibold text-ink-on shadow-raised", className)}>
      {`${count} more ${count === 1 ? "message" : "messages"}. Dismiss one to see the next.`}
    </p>
  );
}

function Toast({ item, onDismiss, className }: { item: ToastItem; onDismiss: (id: number) => void; className?: string }) {
  // The countdown stops while the pointer or focus is on the toast, so it never vanishes mid-read.
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (sticky(item) || paused) return;
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
      className={cn("pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg bg-ink py-1 pr-1 pl-4 text-sm font-semibold text-ink-on shadow-raised animate-enter", className)}
    >
      <Icon size={20} weight="regular" aria-hidden className={cn("mt-3 shrink-0", item.tone === "danger" ? "text-[color-mix(in_oklab,var(--danger),var(--ink-on)_55%)]" : "")} />
      <span className="min-w-0 flex-1 py-2.5 break-words">{item.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        aria-label="Dismiss"
        className="flex size-11 shrink-0 items-center justify-center rounded-pill text-ink-on/80 hover:bg-ink-on/10 hover:text-ink-on"
        style={{ outlineColor: "var(--ink-on)" }}
      >
        <X size={18} aria-hidden />
      </button>
    </div>
  );
}

/**
 * Toasts dock at the bottom of the page. While a sheet is open they show inside it, in its
 * flow above the actions (`SheetToasts`), so they never cover a sheet's buttons or field errors.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(0);
  // Phones show one page toast: the cap decides what is kept, so nothing waits hidden with its timer running.
  const phone = useSyncExternalStore(watchPhone, isPhone, () => false);
  const onPhone = useRef(phone);
  // Open sheets, innermost last. A ref so a toast raised in the same tick a sheet opens or
  // closes lands in the right place; the count re-renders the page dock.
  const sheets = useRef<string[]>([]);
  const [sheetCount, setSheetCount] = useState(0);
  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), []);
  const clear = useCallback((topic: string) => setItems((current) => clearTopic(current, topic)), []);
  const push = useCallback<Push>((message, tone = "success", options) => {
    const item: ToastItem = {
      id: ++next.current, tone, message, sheet: sheets.current.at(-1) ?? null,
      ...(options?.topic ? { topic: options.topic } : {}),
      ...(options?.keepOnNavigate ? { keepOnNavigate: true } : {}),
    };
    setItems((current) => addToast(current, item, onPhone.current));
  }, []);
  const openSheet = useCallback((sheet: string) => {
    sheets.current = [...sheets.current, sheet];
    setSheetCount(sheets.current.length);
    setItems(afterSheetOpened);
  }, []);
  const closeSheet = useCallback((sheet: string) => {
    sheets.current = sheets.current.filter((open) => open !== sheet);
    setSheetCount(sheets.current.length);
    const under = sheets.current.at(-1) ?? null;
    setItems((current) => afterSheetClosed(current, sheet, under, onPhone.current));
  }, []);
  const routeChanged = useCallback(() => setItems(afterRouteChange), []);
  useEffect(() => {
    if (onPhone.current === phone) return;
    onPhone.current = phone;
    setItems((current) => afterScreenChange(current, phone));
  }, [phone]);

  const state = useMemo(() => ({ items, dismiss, clear, openSheet, closeSheet }), [items, dismiss, clear, openSheet, closeSheet]);
  const page = shownToasts(items, null, phone);
  return (
    <ToastContext.Provider value={push}>
      <ToastStateContext.Provider value={state}>
        {children}
        {/* Its own boundary: reading the query keeps only this watcher, not the page, out of the static render. */}
        <Suspense fallback={null}>
          <PageWatch onChange={routeChanged} />
        </Suspense>
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tabbar-height)+env(safe-area-inset-bottom)+12px)] z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6 lg:items-end lg:px-8"
        >
          {sheetCount > 0 ? null : (
            <>
              <Waiting count={page.waiting} />
              {page.toasts.map((item) => <Toast key={item.id} item={item} onDismiss={dismiss} />)}
            </>
          )}
        </div>
      </ToastStateContext.Provider>
    </ToastContext.Provider>
  );
}

/** Calls `onChange` when the address moves to another page: a new path or a new query. The same address again changes nothing. */
function PageWatch({ onChange }: { onChange: () => void }) {
  const page = pageKey(usePathname(), useSearchParams().toString());
  const shownPage = useRef(page);
  useEffect(() => {
    if (shownPage.current === page) return;
    shownPage.current = page;
    onChange();
  }, [page, onChange]);
  return null;
}

/** The toasts raised while this sheet is open, in its flow. `DialogContent` renders it. */
export function SheetToasts() {
  const state = useContext(ToastStateContext);
  const sheet = useId();
  const openSheet = state?.openSheet;
  const closeSheet = state?.closeSheet;
  // Before paint, so a toast raised as the sheet opens already lands in it.
  useLayoutEffect(() => {
    if (!openSheet || !closeSheet) return;
    openSheet(sheet);
    return () => closeSheet(sheet);
  }, [sheet, openSheet, closeSheet]);
  const mine = shownToasts(state?.items ?? [], sheet);
  return (
    <div role="status" aria-live="polite" data-slot="sheet-toasts" className="flex flex-col gap-2 px-4 sm:px-6 [&:not(:empty)]:py-3">
      <Waiting count={mine.waiting} className="max-w-none" />
      {mine.toasts.map((item) => <Toast key={item.id} item={item} onDismiss={state!.dismiss} className="max-w-none" />)}
    </div>
  );
}

export function useToast() {
  const push = useContext(ToastContext);
  if (!push) throw new Error("useToast must be used inside <ToastProvider>");
  return push;
}

/** Drops every toast on `topic`, for a new attempt whose answer will speak for itself. */
export function useClearToasts(): (topic: string) => void {
  const clear = useContext(ToastStateContext)?.clear;
  return useCallback((topic: string) => clear?.(topic), [clear]);
}
