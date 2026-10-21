"use client";

// From Magic UI "Border Beam" (MIT; see NOTICE): a light that travels the card edge. Changes:
// our pop colours by default, and it is not drawn at all when the viewer reduces motion.

import { motion, type MotionStyle } from "motion/react";
import type { CSSProperties } from "react";
import { useReducedMotionLive } from "@/lib/motion";
import { cn } from "@/lib/utils";

export function BorderBeam({ size = 80, duration = 8, colorFrom = "var(--success)", colorTo = "var(--accent)", borderWidth = 1, className }: {
  size?: number;
  duration?: number;
  colorFrom?: string;
  colorTo?: string;
  borderWidth?: number;
  className?: string;
}) {
  if (useReducedMotionLive()) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 rounded-[inherit] border-(length:--border-beam-width) border-transparent mask-[linear-gradient(transparent,transparent),linear-gradient(#000,#000)] mask-intersect [mask-clip:padding-box,border-box]"
      style={{ "--border-beam-width": `${borderWidth}px` } as CSSProperties}
    >
      <motion.div
        className={cn("absolute aspect-square bg-linear-to-l from-(--color-from) via-(--color-to) to-transparent", className)}
        style={{ width: size, offsetPath: "rect(0 auto auto 0 round var(--radius-lg))", "--color-from": colorFrom, "--color-to": colorTo } as MotionStyle}
        initial={{ offsetDistance: "0%" }}
        animate={{ offsetDistance: ["0%", "100%"] }}
        transition={{ repeat: Infinity, ease: "linear", duration }}
      />
    </div>
  );
}
