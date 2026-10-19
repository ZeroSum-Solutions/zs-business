"use client";

import { SignOut, WarningCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { ErrorNote, LoadingRows } from "@/components/ui/states";
import { useApiRuntime } from "@/lib/api/react";
import { useSession, type SignedOutReason } from "@/lib/session";
import { cn } from "@/lib/utils";

/** Pages render only for a known tenant; otherwise a real signed-out or loading state. */
export function SessionGate({ children }: { children: ReactNode }) {
  const { session, retry } = useSession();
  if (session.status === "signed_in") return <>{children}</>;
  if (session.status === "loading") return <LoadingRows rows={4} label="Checking your session" />;
  if (session.status === "unavailable") {
    if (session.misconfigured) {
      return <ErrorNote error={null} message="Sign-in is not set up on this server yet. Ask whoever runs it to set the Supabase URL and anon key." />;
    }
    return <ErrorNote error={null} message="We could not check who is signed in. Try again in a moment." retry={retry} />;
  }
  if (session.status === "signing_out") return <SigningOut failed={session.failed} />;
  return <SignedOut reason={session.reason} />;
}

const COPY: Record<SignedOutReason, { title: string; body: string; action: string }> = {
  signed_out: { title: "You are signed out", body: "Nothing from your session is kept on this device.", action: "Sign in" },
  expired: { title: "Your session ended", body: "For your security, nothing from the last session is kept on this device.", action: "Sign in again" },
  no_access: {
    title: "This account has no access",
    body: "You are signed in, but not as a member of this business. Ask an owner to invite this email, or sign in with another one.",
    action: "Sign in with another email",
  },
};

function SignedOut({ reason }: { reason: SignedOutReason }) {
  const { mode } = useApiRuntime();
  const pathname = usePathname();
  // Live mode signs in with an email link; the demo has no sign-in, so a fresh load is a
  // fresh session. A full page load either way, so no state from this session survives.
  const href = mode === "live" ? `/sign-in${pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : ""}` : "/";
  return (
    <section aria-labelledby="signed-out-title" data-testid="signed-out" className="mx-auto max-w-md py-12 text-center">
      <span aria-hidden className="mx-auto mb-4 flex size-12 items-center justify-center rounded-pill bg-surface-warm text-muted">
        <SignOut size={24} />
      </span>
      <h1 id="signed-out-title" className="text-xl tracking-display">{COPY[reason].title}</h1>
      <p className="mt-2 text-sm text-muted">{COPY[reason].body}</p>
      <a href={href} className={cn(buttonVariants(), "mt-6")}>{COPY[reason].action}</a>
    </section>
  );
}

/**
 * Live mode, between choosing Sign out and the server confirming it. It never says the session
 * ended: if the server could not end it, the person must know so they can try again.
 */
function SigningOut({ failed }: { failed: boolean }) {
  const { signOut } = useSession();
  const pending = !failed;
  return (
    <section aria-labelledby="signing-out-title" data-testid="signing-out" className="mx-auto max-w-md py-12 text-center">
      <span aria-hidden className="mx-auto mb-4 flex size-12 items-center justify-center rounded-pill bg-surface-warm text-muted">
        <SignOut size={24} />
      </span>
      <h1 id="signing-out-title" className="text-xl tracking-display">Signing out</h1>
      {failed ? (
        <p role="alert" className="mt-4 flex items-start gap-3 rounded-md bg-danger/8 p-4 text-left text-sm text-fg-2">
          <WarningCircle size={20} aria-hidden className="mt-px shrink-0 text-danger" />
          <span>Sign-out did not finish. Try again.</span>
        </p>
      ) : (
        <p role="status" className="mt-2 text-sm text-muted">Ending your session…</p>
      )}
      {/* One button in both states, and aria-disabled rather than disabled, so a keyboard
          user who pressed Try again keeps focus on it while the retry runs. */}
      <Button
        type="button"
        className="mt-6 aria-disabled:cursor-progress aria-disabled:opacity-50"
        aria-disabled={pending}
        aria-busy={pending}
        onClick={() => {
          if (!pending) signOut("signed_out");
        }}
      >
        {pending ? "Signing out…" : "Try again"}
      </Button>
    </section>
  );
}
