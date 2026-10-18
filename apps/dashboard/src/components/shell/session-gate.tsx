"use client";

import { SignOut } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { ErrorNote, LoadingRows } from "@/components/ui/states";
import { useApiRuntime } from "@/lib/api/react";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

/** Pages render only for a known tenant; otherwise a real signed-out or loading state. */
export function SessionGate({ children }: { children: ReactNode }) {
  const { session, retry } = useSession();
  if (session.status === "signed_in") return <>{children}</>;
  if (session.status === "loading") return <LoadingRows rows={4} label="Checking your session" />;
  if (session.status === "unavailable") {
    if (session.misconfigured) {
      return <ErrorNote error={null} message="Sign-in is not set up on this server yet. Ask whoever runs it to set the dashboard access code and session secret." />;
    }
    return <ErrorNote error={null} message="We could not check who is signed in. Try again in a moment." retry={retry} />;
  }
  return <SignedOut reason={session.reason} />;
}

function SignedOut({ reason }: { reason: "expired" | "signed_out" }) {
  const { mode } = useApiRuntime();
  const pathname = usePathname();
  // Live mode signs in with the pilot access code; the demo has no gate, so a fresh load is
  // a fresh session. A full page load either way, so no state from this session survives.
  const href = mode === "live" ? `/sign-in${pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : ""}` : "/";
  return (
    <section aria-labelledby="signed-out-title" data-testid="signed-out" className="mx-auto max-w-md py-12 text-center">
      <span aria-hidden className="mx-auto mb-4 flex size-12 items-center justify-center rounded-pill bg-surface-warm text-muted">
        <SignOut size={24} />
      </span>
      <h1 id="signed-out-title" className="text-xl tracking-display">{reason === "expired" ? "Your session ended" : "You are signed out"}</h1>
      <p className="mt-2 text-sm text-muted">
        {reason === "expired" ? "For your security, nothing from the last session is kept on this device." : "Nothing from your session is kept on this device."}
      </p>
      <a href={href} className={cn(buttonVariants(), "mt-6")}>{reason === "expired" ? "Sign in again" : "Sign in"}</a>
    </section>
  );
}
