"use client";

import { MagnifyingGlass, X } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { ErrorNote, LoadingRows } from "@/components/ui/states";
import { useContacts, useDebouncedValue } from "@/lib/queries";
import { formatPhone } from "@/lib/utils";

export interface PickedCustomer {
  id: string;
  name: string | null;
}

const SHOWN = 6;

/**
 * Search the business's customers and pick one (booking-customer.md BC-8). Typing waits for a
 * pause before the API is asked, as the Customers page does. A picked customer shows as a
 * chip with a way to clear it, so the choice is always visible and always undoable.
 */
export function CustomerPicker({
  label,
  selected,
  onSelect,
  onClear,
  disabled = false,
  hint,
  browse = false,
}: {
  label: string;
  selected: PickedCustomer | null;
  onSelect: (customer: PickedCustomer) => void;
  /** Without it, a picked customer has no clear control (a change replaces it instead). */
  onClear?: (() => void) | undefined;
  disabled?: boolean;
  hint?: string;
  /** Show the first customers before anything is typed; off, the list waits for a search. */
  browse?: boolean;
}) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const [search, setSearch] = useState("");
  const settled = useDebouncedValue(search.trim(), 250);
  const contacts = useContacts(settled);
  const items = (contacts.data?.pages.flatMap((page) => page.items) ?? []).slice(0, SHOWN);

  if (selected) {
    const name = selected.name ?? "Unnamed customer";
    return (
      <div>
        <p className="mb-1.5 text-sm font-semibold text-fg-2">{label}</p>
        <div className="flex min-h-11 items-center gap-3 rounded-md bg-accent-tint px-3 py-1.5" data-testid="picked-customer">
          <Avatar name={selected.name} size="sm" />
          <span className="min-w-0 flex-1 truncate text-body font-semibold text-fg">{name}</span>
          {onClear ? (
            <button
              type="button"
              disabled={disabled}
              onClick={onClear}
              aria-label={`Clear ${name}`}
              className="focus-inset -mr-2 inline-flex size-11 items-center justify-center rounded-pill text-muted transition-quick hover:bg-inset hover:text-fg disabled:opacity-50"
            >
              <X size={18} aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div>
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-semibold text-fg-2">{label}</label>
      <div className="relative">
        <MagnifyingGlass size={20} aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-meta" />
        <Input
          id={inputId}
          type="search"
          autoComplete="off"
          aria-describedby={hint ? hintId : undefined}
          placeholder="Search by name, email or phone"
          className="pl-10"
          disabled={disabled}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {hint ? <p id={hintId} className="mt-1.5 text-xs text-meta">{hint}</p> : null}
      {browse || settled !== "" ? <div className="mt-2" aria-busy={contacts.isFetching}>
        {contacts.isPending ? <LoadingRows rows={2} label="Loading customers" /> : contacts.isError ? (
          <ErrorNote error={contacts.error} retry={() => contacts.refetch()} />
        ) : items.length === 0 ? (
          <p className="rounded-md bg-inset p-3 text-sm text-muted">{settled ? "No customers match. Check the spelling." : "No customers yet."}</p>
        ) : (
          <ul aria-label="Matching customers" className="divide-y divide-border-soft overflow-hidden rounded-md shadow-[inset_0_0_0_1px_var(--border)]">
            {items.map((contact) => (
              <li key={contact.id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onSelect({ id: contact.id, name: contact.displayName })}
                  className="focus-inset flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left transition-quick hover:bg-inset disabled:opacity-50"
                >
                  <Avatar name={contact.displayName ?? contact.email} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-semibold text-fg">{contact.displayName ?? "Unnamed customer"}</span>
                    <span className="block truncate text-caption text-muted">{contact.email ?? formatPhone(contact.phone)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div> : null}
    </div>
  );
}
