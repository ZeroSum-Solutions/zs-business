"use client";

import { EnvelopeSimple, LockKey } from "@phosphor-icons/react";
import { useEffect, useState, type FormEvent } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useApiRuntime } from "@/lib/api/react";
import { cn } from "@/lib/utils";
import { OWNER } from "./account-menu";

type Problem = { kind: "invalid" | "limited" | "unset" | "offline" | "failed" | "link"; waitMinutes?: number };

const MESSAGES: Record<Problem["kind"], (problem: Problem) => string> = {
  invalid: () => "Enter your email address, like name@example.com.",
  limited: (problem) => `Too many sign-in requests. Wait ${problem.waitMinutes ?? 15} minute${problem.waitMinutes === 1 ? "" : "s"}, then try again.`,
  unset: () => "Sign-in is not set up on this server yet. Ask whoever runs it to set the Supabase URL and anon key.",
  offline: () => "You look offline. Check your connection and try again.",
  failed: () => "We could not send a sign-in link. Try again in a moment.",
  link: () => "That sign-in link has expired or was already used. Ask for a new one below.",
};

/**
 * Sign-in by email link (Supabase Auth). The server asks Supabase to email a one-time link;
 * the link lands on /auth/confirm, which sets the httpOnly session cookies. The page never
 * says whether an address has an account: people join by invitation.
 */
export function SignInView() {
  const { mode } = useApiRuntime();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  // /auth/confirm sends a failed link back here with ?error=link.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("error") === "link") setProblem({ kind: "link" });
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (!address || pending) return;
    setPending(true);
    setProblem(null);
    try {
      const response = await fetch("/api/sign-in", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: address, next: new URLSearchParams(window.location.search).get("next") ?? undefined }),
      });
      if (response.status === 204) setSentTo(address);
      else if (response.status === 400) setProblem({ kind: "invalid" });
      else if (response.status === 429) setProblem({ kind: "limited", waitMinutes: Math.max(1, Math.ceil(Number(response.headers.get("retry-after") ?? 900) / 60)) });
      else if (response.status === 503) setProblem({ kind: "unset" });
      else setProblem({ kind: "failed" });
    } catch {
      setProblem({ kind: "offline" });
    }
    setPending(false);
  };

  return (
    <section aria-labelledby="sign-in-title" className="mx-auto w-full max-w-sm py-12">
      <span aria-hidden className="mb-4 flex size-12 items-center justify-center rounded-pill bg-inset text-muted">
        {sentTo ? <EnvelopeSimple size={24} /> : <LockKey size={24} />}
      </span>
      {mode === "demo" ? (
        <>
          <h1 id="sign-in-title" className="text-2xl leading-tight font-extrabold tracking-display">Sign in to {OWNER.business}</h1>
          <p className="mt-2 text-sm text-muted">This is the demo with sample data. It needs no sign-in.</p>
          <a href="/" className={cn(buttonVariants(), "mt-6")}>Open the demo</a>
        </>
      ) : sentTo ? (
        <>
          <h1 id="sign-in-title" className="text-2xl leading-tight font-extrabold tracking-display">Check your email</h1>
          <p role="status" className="mt-2 text-sm text-muted">
            If <span className="font-medium text-fg">{sentTo}</span> belongs to someone on the team, a sign-in link is on its way. Open it on any device to sign in. It works once and expires within the hour.
          </p>
          <Button type="button" variant="secondary" className="mt-6 w-full" onClick={() => setSentTo(null)}>Use a different email</Button>
        </>
      ) : (
        <>
          <h1 id="sign-in-title" className="text-2xl leading-tight font-extrabold tracking-display">Sign in to {OWNER.business}</h1>
          <form onSubmit={submit} noValidate className="mt-6 space-y-4">
            <p className="text-sm text-muted">Enter the email address your invitation went to. We will email you a link that signs you in.</p>
            <div>
              <Label htmlFor="sign-in-email">Email</Label>
              <Input
                id="sign-in-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoFocus
                value={email}
                aria-invalid={problem?.kind === "invalid" || undefined}
                aria-describedby={problem ? "sign-in-error" : undefined}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            {problem ? (
              <p id="sign-in-error" role="alert" className="rounded-md bg-danger-tint p-3 text-sm text-fg-2">{MESSAGES[problem.kind](problem)}</p>
            ) : null}
            <Button type="submit" className="w-full" disabled={pending || !email.trim()} aria-busy={pending}>Email me a sign-in link</Button>
          </form>
        </>
      )}
    </section>
  );
}
