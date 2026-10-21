import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-sm font-medium text-sm transition-quick select-none enabled:motion-safe:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress [&_svg]:size-5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-on shadow-[inset_0_-1px_0_rgba(0,0,0,0.12)] hover:bg-primary-hover active:bg-primary-active",
        secondary: "bg-control-on text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.06),inset_0_0_0_1px_var(--border)] hover:bg-fg/8 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),inset_0_0_0_1px_var(--border-strong)]",
        ghost: "text-fg-2 hover:bg-surface-warm hover:text-fg",
        danger: "bg-danger text-surface hover:opacity-90",
        "danger-outline": "bg-surface-warm text-danger shadow-[inset_0_0_0_1px_var(--danger)] hover:bg-danger/8",
      },
      size: {
        default: "min-h-11 px-4",
        lg: "min-h-12 px-5 text-base",
        icon: "size-11",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type,
  ...props
}: ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot.Root : "button";
  return (
    <Component
      className={cn(buttonVariants({ variant, size }), className)}
      {...(asChild ? {} : { type: type ?? "button" })}
      {...props}
    />
  );
}
