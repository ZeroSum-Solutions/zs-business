import type { ReactNode } from "react";

/** Visible reason a control is off. Point the control at it with aria-describedby. */
export function DisabledReason({ id, children }: { id: string; children: ReactNode }) {
  return <p id={id} className="text-xs text-muted" data-testid="disabled-reason">{children}</p>;
}
