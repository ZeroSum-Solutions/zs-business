import type { Metadata } from "next";
import { Suspense } from "react";
import { EnrichmentProposals } from "@/components/customers/enrichment-proposals";

export const metadata: Metadata = { title: "Company details to review" };

export default function EnrichmentProposalsPage() {
  return (
    <Suspense>
      <EnrichmentProposals />
    </Suspense>
  );
}
