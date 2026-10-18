"use client";

import { LockKey } from "@phosphor-icons/react";
import { useState, type FormEvent } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useApiRuntime } from "@/lib/api/react";
import { cn } from "@/lib/utils";
import { OWNER } from "./account-menu";

type Problem = { kind: "wrong" | "limited" | "unset" | "offline" | "failed"; waitMinutes?: number };

const MESSAGES: Record<Problem["kind"], (problem: Problem) => string> = {
  wrong: () => "That code is not right. Check it and try again.",
  limited: (problem) => `Too many wrong codes. Wait ${problem.waitMinutes ?? 15} minute${problem.waitMinutes === 1 ? "" : "s"}, then try again.`,
  unset: () => "Sign-in is not set up on this server yet. Ask whoever runs it to set the dashboard access code and session secret.",
  offline: () => "You look offline. Check your connection and try again.",
  failed: () => "We could not sign you in. Try again in a moment.",
};

/**
 * Only a page on this site. The value is resolved as the browser would resolve it, so
 * "//other.example", "/\\other.example" and "/\t/other.example" all fall back to home.
 */
function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  if (!next?.startsWith("/")) return "/";
  try {
    const url = new URL(next, window.location.origin);
    return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}

/**
 * Pilot sign-in: the shared access code buys an httpOnly session cookie (pilot-gate.ts).
 * TODO(auth): real sign-in replaces this page.
 */
export function SignInView() {
  const { mode } = useApiRuntime();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim() || pending) return;
    setPending(true);
    setProblem(null);
    try {
      const response = await fetch("/api/sign-in", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (response.ok) {
        // A full load, so the session and every query start fresh.
        window.location.assign(nextPath());
        return;
      }
      if (response.status === 401) setProblem({ kind: "wrong" });
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
      <span aria-hidden className="mb-4 flex size-12 items-center justify-center rounded-pill bg-surface-warm text-muted">
        <LockKey size={24} />
      </span>
      <h1 id="sign-in-title" className="text-xl tracking-display">Sign in to {OWNER.business}</h1>
      {mode === "demo" ? (
        <>
          <p className="mt-2 text-sm text-muted">This is the demo with sample data. It needs no sign-in.</p>
          <a href="/" className={cn(buttonVariants(), "mt-6")}>Open the demo</a>
        </>
      ) : (
        <form onSubmit={submit} noValidate className="mt-6 space-y-4">
          <p className="text-sm text-muted">Enter the access code you were given. You stay signed in on this device until you sign out or the session times out.</p>
          <div>
            <Label htmlFor="access-code">Access code</Label>
            <Input
              id="access-code"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={code}
              aria-invalid={problem?.kind === "wrong" || undefined}
              aria-describedby={problem ? "sign-in-error" : undefined}
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
          {problem ? (
            <p id="sign-in-error" role="alert" className="rounded-md bg-danger/8 p-3 text-sm text-fg-2">{MESSAGES[problem.kind](problem)}</p>
          ) : null}
          <Button type="submit" className="w-full" disabled={pending || !code.trim()} aria-busy={pending}>Sign in</Button>
        </form>
      )}
    </section>
  );
}
