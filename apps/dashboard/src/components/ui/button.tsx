import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-sm font-medium text-sm transition-quick select-none disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress [&_svg]:size-5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-on hover:bg-accent-hover active:bg-accent-active",
        secondary: "bg-surface text-fg shadow-[inset_0_0_0_1px_var(--border-strong)] hover:bg-surface-warm",
        ghost: "text-fg-2 hover:bg-surface-warm hover:text-fg",
        danger: "bg-danger text-surface hover:opacity-90",
        "danger-outline": "bg-surface text-danger shadow-[inset_0_0_0_1px_var(--danger)] hover:bg-danger/8",
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
