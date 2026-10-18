"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Counts a write dialog's lifetimes. The count moves on whenever the dialog opens or closes,
 * or `scope` changes (the booking sheet's calendar). A write started in one lifetime tags
 * itself with `current()`; when its answer lands, `isCurrent(tag)` says whether that same
 * lifetime is still on screen. A late answer may still refresh lists, but must never close,
 * clear, toast into or navigate away from a newer one.
 */
export function useDialogGeneration(open: boolean, scope?: string) {
  const generation = useRef(0);
  const isOpen = useRef(open);
  useEffect(() => {
    generation.current += 1;
    isOpen.current = open;
  }, [open, scope]);
  const current = useCallback(() => generation.current, []);
  const isCurrent = useCallback((tag: number) => tag === generation.current, []);
  /** The dialog is closed now: a late success may still confirm itself with a toast. */
  const isClosed = useCallback(() => !isOpen.current, []);
  return { current, isCurrent, isClosed };
}
