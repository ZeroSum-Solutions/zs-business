"use client";

import { Plus } from "@phosphor-icons/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/states";
import { cn } from "@/lib/utils";
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
      <nav aria-label="Customers views" className="mb-5 flex gap-1 border-b border-border">
        {[{ id: "contacts", label: "Contacts", href: "/customers" }, { id: "pipeline", label: "Pipeline", href: "/customers?view=pipeline" }].map((tab) => (
          <Link
            key={tab.id}
            href={tab.href}
            aria-current={view === tab.id ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium transition-quick",
              view === tab.id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      {view === "pipeline" ? <PipelineBoard /> : <><WebsiteRequests /><ContactList /></>}
      <AddContactDialog open={adding} onOpenChange={setAdding} />
    </>
  );
}
