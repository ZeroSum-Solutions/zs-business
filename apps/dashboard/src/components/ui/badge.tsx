import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3.5",
  {
    variants: {
      tone: {
        neutral: "bg-surface-warm text-fg-2 ring-1 ring-inset ring-border",
        accent: "bg-accent/14 text-accent ring-1 ring-inset ring-accent/25",
        info: "bg-info/12 text-info ring-1 ring-inset ring-info/25",
        success: "bg-success/14 text-success ring-1 ring-inset ring-success/25",
        warn: "bg-warn/12 text-warn ring-1 ring-inset ring-warn/25",
        danger: "bg-danger/12 text-danger ring-1 ring-inset ring-danger/25",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

// The live dot is adapted from Cult UI "Halo Badge" (MIT; see NOTICE): an opacity-only pulse, still
// under reduced motion. The gradient rim and moving glow were left out.
export function Badge({ className, tone, live = false, children, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { live?: boolean }) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {live ? <span aria-hidden className="animate-live size-1.5 shrink-0 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
