"use client";

import { Plus } from "@phosphor-icons/react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ViewTabs } from "@/components/ui/segmented";
import { PageHeader } from "@/components/ui/states";
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
        description="Everyone you work with, and where each commission stands."
        actions={<Button onClick={() => setAdding(true)}><Plus aria-hidden />Add customer</Button>}
      />
      <ViewTabs
        label="Customers views"
        current={view}
        tabs={[{ id: "contacts", label: "Contacts", href: "/customers" }, { id: "pipeline", label: "Pipeline", href: "/customers?view=pipeline" }]}
        className="mb-5"
      />
      {view === "pipeline" ? <PipelineBoard /> : <><WebsiteRequests /><ContactList /></>}
      <AddContactDialog open={adding} onOpenChange={setAdding} />
    </>
  );
}
