import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex min-h-[26px] items-center gap-1 rounded-pill px-2.5 text-xs font-bold whitespace-nowrap [&_svg]:size-3.5",
  {
    variants: {
      tone: {
        neutral: "bg-tray text-fg-2",
        accent: "bg-accent-tint text-accent-ink",
        info: "bg-info-tint text-info",
        success: "bg-success-tint text-success",
        warn: "bg-warn-tint text-warn",
        danger: "bg-danger-tint text-danger",
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
