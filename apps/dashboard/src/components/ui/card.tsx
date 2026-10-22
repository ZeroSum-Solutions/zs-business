"use client";

// Adapted from Cult UI "Minimal Card" (MIT, nolly-studio/cult-ui; see NOTICE): its layered
// hairline edge and large radius, on our tokens and a <section> root, with a hover lift (`card-live`).
// Direction A: a white card sits on a grey tray; the Tray groups related cards under one heading.
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("card card-live p-4 lg:px-6 lg:py-5", className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mb-4 flex items-start justify-between gap-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("text-lg leading-6 font-bold tracking-[-0.015em] text-fg", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-sm text-muted", className)} {...props} />;
}

/** A grey tray that groups cards. The heading row sits on the tray, the cards below it. */
export function Tray({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("tray flex min-w-0 flex-col", className)} {...props} />;
}

export function TrayHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 pt-2 pb-2.5 lg:px-4", className)} {...props} />;
}

export function TrayTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("text-base leading-6 font-bold tracking-[-0.015em] text-fg", className)} {...props} />;
}

export function TrayBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("grid min-w-0 grid-cols-1 gap-1.5 lg:gap-2", className)} {...props} />;
}
