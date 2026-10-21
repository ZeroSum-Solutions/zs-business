"use client";

// Adapted from Cult UI "Minimal Card" (MIT, nolly-studio/cult-ui; see NOTICE): its layered
// hairline edge and large radius, on our tokens and a <section> root. The pointer light and
// spring lift (`card-live`) are adapted from Magic UI "Magic Card" (MIT; see NOTICE).
import type { ComponentProps, PointerEvent } from "react";
import { spotlight } from "@/lib/spotlight";
import { cn } from "@/lib/utils";

export function Card({ className, onPointerMove, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn("card-live rounded-lg bg-lit p-4 shadow-card lg:p-6", className)}
      onPointerMove={(event: PointerEvent<HTMLElement>) => {
        spotlight(event);
        onPointerMove?.(event);
      }}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mb-4 flex items-start justify-between gap-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("text-base font-semibold tracking-tight text-fg", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-sm text-muted", className)} {...props} />;
}
