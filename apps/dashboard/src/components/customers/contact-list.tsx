"use client";

import { CaretRight, MagnifyingGlass } from "@phosphor-icons/react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorNote, LoadingRows } from "@/components/ui/states";
import { useContacts, useDebouncedValue } from "@/lib/queries";
import { formatPhone } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";

export function ContactList() {
  const [search, setSearch] = useState("");
  // The API searches every customer; wait for a pause in typing before asking it.
  const settled = useDebouncedValue(search.trim(), 250);
  const contacts = useContacts(settled);
  const items = contacts.data?.pages.flatMap((page) => page.items) ?? [];

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
      {contacts.isPending ? <LoadingRows rows={6} label="Loading customers" /> : contacts.isError && !contacts.isFetchNextPageError ? (
        <ErrorNote error={contacts.error} retry={() => contacts.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={settled ? "No customers match" : "No customers yet"}>
          {settled ? "Check the spelling, or add them as a new customer." : "Add your first customer to start a record."}
        </EmptyState>
      ) : (
        <>
        <ul className="divide-y divide-border-soft overflow-hidden rounded-lg bg-lit shadow-card" aria-busy={contacts.isFetching}>
          {items.map((contact) => (
            <li key={contact.id}>
              <Link href={`/customers/${contact.id}`} className="focus-inset flex min-h-16 items-center gap-3 px-4 py-3 transition-quick hover:bg-surface-warm">
                <Avatar name={contact.displayName ?? contact.email} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg">{contact.displayName ?? "Unnamed customer"}</span>
                  <span className="block truncate text-sm text-muted">{contact.email ?? formatPhone(contact.phone)}</span>
                </span>
                <CaretRight size={16} aria-hidden className="text-meta" />
              </Link>
            </li>
          ))}
        </ul>
        {contacts.isFetchNextPageError ? <div className="mt-3"><ErrorNote error={contacts.error} retry={() => contacts.fetchNextPage()} /></div> : null}
        {contacts.hasNextPage ? (
          <div className="mt-3 flex justify-center">
            <Button variant="secondary" onClick={() => contacts.fetchNextPage()} disabled={contacts.isFetchingNextPage}>
              {contacts.isFetchingNextPage ? "Loading…" : "Show more customers"}
            </Button>
          </div>
        ) : null}
        </>
      )}
    </section>
  );
}
