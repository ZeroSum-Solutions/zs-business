"use client";

import { SignOut } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ErrorNote, LoadingRows } from "@/components/ui/states";
import { useSession } from "@/lib/session";

/** Pages render only for a known tenant; otherwise a real signed-out or loading state. */
export function SessionGate({ children }: { children: ReactNode }) {
  const { session, retry } = useSession();
  if (session.status === "signed_in") return <>{children}</>;
  if (session.status === "loading") return <LoadingRows rows={4} label="Checking your session" />;
  if (session.status === "unavailable") {
    return <ErrorNote error={null} message="We could not check who is signed in. Try again in a moment." retry={retry} />;
  }
  return <SignedOut reason={session.reason} />;
}

function SignedOut({ reason }: { reason: "expired" | "signed_out" }) {
  return (
    <section aria-labelledby="signed-out-title" data-testid="signed-out" className="mx-auto max-w-md py-12 text-center">
      <span aria-hidden className="mx-auto mb-4 flex size-12 items-center justify-center rounded-pill bg-surface-warm text-muted">
        <SignOut size={24} />
      </span>
      <h1 id="signed-out-title" className="text-xl tracking-display">{reason === "expired" ? "Your session ended" : "You are signed out"}</h1>
      <p className="mt-2 text-sm text-muted">
        {reason === "expired" ? "For your security, nothing from the last session is kept on this device." : "Nothing from your session is kept on this device."}
      </p>
      {/* No sign-in page ships in M1; reloading starts a fresh session from the server. */}
      <Button className="mt-6" onClick={() => window.location.assign("/")}>Sign in again</Button>
    </section>
  );
}
