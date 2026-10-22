import { useSyncExternalStore } from "react";
import { THEME_KEY as KEY } from "./theme-script";

/** Light is the default (Direction A); dark and system are per-device choices. */
export const THEMES = ["light", "dark", "system"] as const;
export type Theme = (typeof THEMES)[number];

const isTheme = (value: unknown): value is Theme => THEMES.includes(value as Theme);
const listeners = new Set<() => void>();

/** What the page shows. Starts from the attribute the head script set, so it is right even when storage is blocked. */
let current: Theme | null = null;

function snapshot(): Theme {
  current ??= isTheme(document.documentElement.dataset.theme) ? document.documentElement.dataset.theme : "light";
  return current;
}

/** Points the browser and home-screen bars at the page colour of the theme now showing. */
export function syncThemeColor() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (!bg) return;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = bg;
}

function apply(theme: Theme) {
  current = theme;
  document.documentElement.dataset.theme = theme;
  syncThemeColor();
  for (const listener of listeners) listener();
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Not remembered on this device; it still applies until the page reloads.
  }
  apply(theme);
}

/**
 * Follows a choice made in another tab, and the device's scheme while on "system". Mounted once,
 * at the root, so every page follows (not only one that reads the theme).
 */
export function watchTheme(): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY && event.key !== null) return;
    apply(isTheme(event.newValue) ? event.newValue : "light");
  };
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  window.addEventListener("storage", onStorage);
  scheme.addEventListener("change", syncThemeColor);
  syncThemeColor();
  return () => {
    window.removeEventListener("storage", onStorage);
    scheme.removeEventListener("change", syncThemeColor);
  };
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, snapshot, () => "light");
}
