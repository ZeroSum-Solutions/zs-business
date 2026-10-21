import { useSyncExternalStore } from "react";
import { THEME_KEY as KEY } from "./theme-script";

/** Black is the default (the owner's pick); light and system are per-device choices. */
export const THEMES = ["dark", "light", "system"] as const;
export type Theme = (typeof THEMES)[number];

const EVENT = "zs-theme-change";

const isTheme = (value: unknown): value is Theme => THEMES.includes(value as Theme);

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    return isTheme(stored) ? stored : "dark";
  } catch {
    return "dark";
  }
}

/** Points the browser and home-screen bars at the page colour of the theme now showing. */
export function syncThemeColor() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (!bg) return;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = bg;
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Not remembered on this device; it still applies until the page reloads.
  }
  document.documentElement.dataset.theme = theme;
  syncThemeColor();
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, readTheme, () => "dark");
}
