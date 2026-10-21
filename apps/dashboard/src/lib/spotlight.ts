import type { PointerEvent } from "react";

/** Moves the `card-live` spotlight to the pointer through CSS variables, so React never re-renders. */
export function spotlight(event: PointerEvent<HTMLElement>) {
  const card = event.currentTarget;
  const box = card.getBoundingClientRect();
  card.style.setProperty("--spot-x", `${event.clientX - box.left}px`);
  card.style.setProperty("--spot-y", `${event.clientY - box.top}px`);
}
