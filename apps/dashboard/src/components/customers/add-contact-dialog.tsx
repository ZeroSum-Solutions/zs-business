"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { ErrorNote } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { isApiError, type NewContact } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { useDialogGeneration } from "@/lib/dialog-generation";
import { useIntentKey } from "@/lib/intent-key";
import { useKeys } from "@/lib/queries";

export function AddContactDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const [form, setForm] = useState({ name: "", email: "", phone: "" });
  const intents = useIntentKey();
  // Moves on whenever the dialog opens or closes. A save that answers after the dialog was
  // closed (and maybe reopened with a new draft) still refreshes the list and may confirm
  // itself, but never closes the dialog, clears the newer draft or navigates away.
  const generation = useDialogGeneration(open);

  const save = useMutation({
    mutationFn: ({ input }: { input: NewContact; generation: number }) => api.createOrFindContact(input, { idempotencyKey: intents.keyFor(input) }),
    onSettled: (_result, error, attempt) => intents.settle(attempt.input, error),
    onSuccess: ({ contact, created }, attempt) => {
      void queryClient.invalidateQueries({ queryKey: keys.contactsAll });
      void queryClient.invalidateQueries({ queryKey: keys.resultsAll });
      // The API's answer is the current record: its page opens from it, not an older copy.
      queryClient.setQueryData(keys.contact(contact.id), contact);
      const name = contact.displayName ?? contact.email ?? "customer";
      if (!generation.isCurrent(attempt.generation)) {
        // The dialog is closed: say the save went through. Reopened: stay out of the new draft.
        if (generation.isClosed()) toast(created ? `Added ${name}.` : `${contact.displayName ?? "This person"} is already a customer.`, created ? "success" : "info");
        return;
      }
      onOpenChange(false);
      setForm({ name: "", email: "", phone: "" });
      if (created) {
        toast(`Added ${name}.`);
        router.push(`/customers/${contact.id}`);
      } else {
        toast(`${contact.displayName ?? "This person"} is already a customer. Opened their record.`, "info");
        router.push(`/customers/${contact.id}?existing=1`);
      }
    },
  });
  const { reset } = save;
  // A fresh opening shows no error or busy state left from an earlier one.
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  const field = isApiError(save.error, "validation") ? save.error.field ?? "" : "";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = { displayName: form.name.trim() || null, email: form.email.trim() || null, phone: form.phone.trim() || null };
    save.mutate({ input, generation: generation.current() });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) save.reset(); }}>
      <DialogContent title="Add a customer" description="An email or a phone number is enough. We check for an existing record first.">
        <form onSubmit={submit} noValidate className="space-y-4">
          <div>
            <Label htmlFor="contact-name">Name</Label>
            <Input id="contact-name" autoComplete="name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </div>
          <div>
            <Label htmlFor="contact-email">Email</Label>
            <Input
              id="contact-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={form.email}
              aria-invalid={field === "email" || undefined}
              aria-describedby={field === "email" ? "contact-error" : undefined}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="contact-phone">Phone</Label>
            <Input
              id="contact-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+1 212 555 0142"
              value={form.phone}
              aria-invalid={field === "phone" || undefined}
              aria-describedby={field === "phone" ? "contact-error" : undefined}
              onChange={(event) => setForm({ ...form, phone: event.target.value })}
            />
          </div>
          {save.isError ? <div id="contact-error"><ErrorNote error={save.error} /></div> : null}
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={save.isPending} aria-busy={save.isPending}>Save customer</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
