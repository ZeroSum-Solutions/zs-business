"use client";

import { CaretRight, Plus } from "@phosphor-icons/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ViewTabs } from "@/components/ui/segmented";
import { PageHeader } from "@/components/ui/states";
import { useEnrichmentProposals } from "@/lib/queries";
import { AddContactDialog } from "./add-contact-dialog";
import { ContactList } from "./contact-list";
import { PipelineBoard } from "./pipeline-board";
import { WebsiteRequests } from "./website-requests";

export function CustomersView() {
  const params = useSearchParams();
  const view = params.get("view") === "pipeline" ? "pipeline" : "contacts";
  const [adding, setAdding] = useState(false);

  return (
    <>
      <PageHeader
        title="Customers"
        description="Everyone you work with, and where each deal stands."
        actions={<Button onClick={() => setAdding(true)}><Plus aria-hidden />Add customer</Button>}
      />
      <ViewTabs
        label="Customers views"
        current={view}
        tabs={[{ id: "contacts", label: "Contacts", href: "/customers" }, { id: "pipeline", label: "Pipeline", href: "/customers?view=pipeline" }]}
        className="mb-5"
      />
      <EnrichmentLink />
      {view === "pipeline" ? <PipelineBoard /> : <ContactList queue={<WebsiteRequests />} />}
      <AddContactDialog open={adding} onOpenChange={setAdding} />
    </>
  );
}

/** The way into the company details waiting for review (enrichment.md E-14), counted when any wait. */
function EnrichmentLink() {
  const proposals = useEnrichmentProposals();
  const count = proposals.data?.length ?? 0;
  return (
    <Link href="/customers/enrichment" className="-ml-2 mb-3 inline-flex min-h-11 items-center gap-2 rounded-sm px-2 text-sm font-medium text-fg-2 hover:text-fg">
      Company details to review
      {count > 0 ? <Badge tone="warn">{count}<span className="sr-only"> waiting</span></Badge> : null}
      <CaretRight size={14} aria-hidden />
    </Link>
  );
}
