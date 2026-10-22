import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/states";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <div className="py-16">
      <PageHeader title="We could not find that page" description="It may have moved." />
      <Link href="/" className="inline-flex min-h-11 items-center font-medium text-accent underline-offset-4 hover:underline">Go to Home</Link>
    </div>
  );
}
