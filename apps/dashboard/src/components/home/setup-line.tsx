"use client";

import Link from "next/link";
import { useSetup } from "@/lib/queries";
import { MANAGE_BUSINESS, useCan } from "@/lib/session";

/**
 * industry-templates.md IT-7: while the business has no setup, Home has one line about it. Owners
 * get a link to `/setup`; staff learn that their owner has not finished. Nothing shows while the
 * read is pending or failed, or once a template is applied.
 */
export function SetupLine() {
  const setup = useSetup();
  const owner = useCan(MANAGE_BUSINESS);
  if (!setup.data || setup.data.applied !== null) return null;
  return (
    <p className="mb-4 text-body text-muted lg:mb-6" data-testid="setup-line">
      {owner ? (
        <>
          Your business isn&apos;t set up yet.{" "}
          <Link href="/setup" className="inline-flex min-h-11 items-center font-bold text-accent-ink underline-offset-4 hover:underline">Choose a template</Link>
        </>
      ) : (
        "Your owner hasn't finished setup yet."
      )}
    </p>
  );
}
