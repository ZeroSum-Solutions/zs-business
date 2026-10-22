import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-pill font-bold text-sm transition-quick select-none enabled:motion-safe:active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress [&_svg]:size-5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-on hover:bg-primary-hover active:bg-primary-active",
        ink: "bg-ink text-ink-on hover:bg-ink-hover",
        secondary: "bg-surface text-fg shadow-[inset_0_0_0_1px_var(--border-strong)] hover:bg-inset",
        ghost: "text-fg-2 hover:bg-inset hover:text-fg",
        danger: "bg-danger text-surface hover:opacity-90",
        "danger-outline": "bg-surface text-danger shadow-[inset_0_0_0_1px_var(--danger)] hover:bg-danger-tint",
      },
      size: {
        default: "min-h-11 px-5",
        lg: "min-h-12 px-6 text-base",
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
