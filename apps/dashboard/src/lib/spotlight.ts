// Adapted from Magic UI "Magic Card" (MIT; see NOTICE). Changes: CSS variables on the card
// instead of motion values, so the pointer light never re-renders React.
import type { PointerEvent } from "react";

/** Moves the `card-live` spotlight to the pointer through CSS variables, so React never re-renders. */
export function spotlight(event: PointerEvent<HTMLElement>) {
  const card = event.currentTarget;
  const box = card.getBoundingClientRect();
  card.style.setProperty("--spot-x", `${event.clientX - box.left}px`);
  card.style.setProperty("--spot-y", `${event.clientY - box.top}px`);
}
