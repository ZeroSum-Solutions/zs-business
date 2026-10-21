import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3.5",
  {
    variants: {
      tone: {
        neutral: "bg-surface-warm text-fg-2",
        accent: "bg-accent/12 text-accent",
        success: "bg-success/12 text-success",
        warn: "bg-warn/14 text-warn",
        danger: "bg-danger/12 text-danger",
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
