"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { ErrorNote } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { isApiError } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { newId } from "@/lib/id";
import { keys } from "@/lib/queries";

export function AddContactDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ name: "", email: "", phone: "" });
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const input = { displayName: form.name.trim() || null, email: form.email.trim() || null, phone: form.phone.trim() || null };
      const fingerprint = JSON.stringify(input);
      if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, key: newId() };
      return api.createOrFindContact(input, { idempotencyKey: attempt.current.key });
    },
    onSuccess: ({ contact, created }) => {
      attempt.current = null;
      void queryClient.invalidateQueries({ queryKey: keys.contactsAll });
      onOpenChange(false);
      setForm({ name: "", email: "", phone: "" });
      if (created) {
        toast(`Added ${contact.displayName ?? contact.email ?? "customer"}.`);
        router.push(`/customers/${contact.id}`);
      } else {
        toast(`${contact.displayName ?? "This person"} is already a customer. Opened their record.`, "info");
        router.push(`/customers/${contact.id}?existing=1`);
      }
    },
  });

  const field = isApiError(save.error, "validation") ? save.error.field ?? "" : "";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
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
