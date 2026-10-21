"use client";

// Adapted from Cult UI "Collab Avatar" (MIT; see NOTICE). Changes: the colour comes from the
// name (a fixed set of pops that read on black), our initials helper, preset sizes, a spring
// entrance from our motion tokens, and decorative by default (the name sits beside it).

import { motion } from "motion/react";
import { INSTANT, SPRING_POP, useReducedMotionLive } from "@/lib/motion";
import { cn, initials } from "@/lib/utils";

/** Pops that keep 4.5:1 on their own tinted fill over the black surface. */
const HUES = ["#6f93ff", "#a58bff", "#ff7ab6", "#ffb547", "#4fd1ff", "#ff8a65", "#e07cff", "#7cc4ff"] as const;

export function avatarHue(name: string): string {
  // FNV-1a: spreads similar names across the set better than a plain multiply.
  let hash = 0x811c9dc5;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return HUES[hash % HUES.length] ?? HUES[0];
}

const SIZES = { sm: 32, md: 40, lg: 56 } as const;

export function Avatar({ name, size = "md", className }: {
  name: string | null | undefined;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const reduce = useReducedMotionLive();
  const px = SIZES[size];
  const color = avatarHue(name ?? "?");
  return (
    <motion.span
      aria-hidden
      data-slot="avatar"
      className={cn("relative isolate inline-flex shrink-0 select-none items-center justify-center rounded-pill font-semibold leading-none tracking-tight", className)}
      initial={reduce ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={reduce ? INSTANT : SPRING_POP}
      style={{
        width: px,
        height: px,
        fontSize: px * 0.38,
        color,
        background: `linear-gradient(180deg, rgb(255 255 255 / 0.14) 0%, transparent 48%), linear-gradient(135deg, ${color}26, ${color}4d)`,
        border: `1px solid ${color}66`,
        boxShadow: `0 0 0 1px ${color}1f, 0 1px 2px rgb(0 0 0 / 0.4), inset 0 1px 0 rgb(255 255 255 / 0.18)`,
      }}
    >
      {initials(name)}
    </motion.span>
  );
}
