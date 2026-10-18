"use client";

import { CaretRight, MagnifyingGlass } from "@phosphor-icons/react";
import Link from "next/link";
import { useDeferredValue, useState } from "react";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorNote, IncompleteNote, LoadingRows } from "@/components/ui/states";
import { useContacts } from "@/lib/queries";
import { formatPhone, initials } from "@/lib/utils";

export function ContactList() {
  const [search, setSearch] = useState("");
  const deferred = useDeferredValue(search);
  const contacts = useContacts(deferred.trim());

  return (
    <section aria-labelledby="contacts-title">
      <h2 id="contacts-title" className="sr-only">Contacts</h2>
      <div className="relative mb-4 max-w-md">
        <MagnifyingGlass size={20} aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-meta" />
        <label htmlFor="contact-search" className="sr-only">Search customers</label>
        <Input
          id="contact-search"
          type="search"
          placeholder="Search by name, email or phone"
          className="pl-10"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {contacts.isPending ? <LoadingRows rows={6} label="Loading customers" /> : contacts.isError ? (
        <ErrorNote error={contacts.error} retry={() => contacts.refetch()} />
      ) : contacts.data.items.length === 0 ? (
        <EmptyState title={search ? "No customers match" : "No customers yet"}>
          {search ? "Check the spelling, or add them as a new customer." : "Add your first customer to start a record."}
        </EmptyState>
      ) : (
        <>
        <IncompleteNote list={contacts.data} />
        <ul className="divide-y divide-border-soft overflow-hidden rounded-md bg-surface shadow-ring" aria-busy={contacts.isFetching}>
          {contacts.data.items.map((contact) => (
            <li key={contact.id}>
              <Link href={`/customers/${contact.id}`} className="focus-inset flex min-h-16 items-center gap-3 px-4 py-3 transition-quick hover:bg-surface-warm">
                <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-pill bg-surface-warm text-sm font-semibold text-fg-2">
                  {initials(contact.displayName ?? contact.email)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg">{contact.displayName ?? "Unnamed customer"}</span>
                  <span className="block truncate text-sm text-muted">{contact.email ?? formatPhone(contact.phone)}</span>
                </span>
                <CaretRight size={16} aria-hidden className="text-meta" />
              </Link>
            </li>
          ))}
        </ul>
        </>
      )}
    </section>
  );
}
