// Motion tokens from 21st.dev "Animated Sidebar" by @starc007 (MIT; see NOTICE). Springs for
// shared-layout glides (nav pills and indicators); CSS durations live in theme.css.

import { useSyncExternalStore } from "react";

/** Small things arriving: avatars, badges. A quick spring with a little overshoot. */
export const SPRING_POP = {
  type: "spring",
  stiffness: 520,
  damping: 26,
  mass: 0.6,
} as const;

/** Shared-layout glides — pills, indicators and panels morphing between positions. */
export const SPRING_LAYOUT = {
  type: "spring",
  stiffness: 360,
  damping: 32,
  mass: 0.6,
} as const;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const reducesMotion = () => !!window.matchMedia?.(REDUCED_MOTION).matches;
/** Follows the setting while mounted (Motion's own hook and MotionConfig read it once). */
function watchMotion(change: () => void) {
  const query = window.matchMedia?.(REDUCED_MOTION);
  query?.addEventListener("change", change);
  return () => query?.removeEventListener("change", change);
}

/** Whether the owner asked for reduced motion, updated live. The server render assumes motion. */
export function useReducedMotionLive(): boolean {
  return useSyncExternalStore(watchMotion, reducesMotion, () => false);
}

export const INSTANT = { duration: 0 } as const;

/** SPRING_LAYOUT, or an instant move under reduced motion. */
export function useLayoutTransition() {
  return useReducedMotionLive() ? INSTANT : SPRING_LAYOUT;
}
