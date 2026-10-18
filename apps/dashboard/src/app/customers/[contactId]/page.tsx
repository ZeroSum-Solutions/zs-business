import type { Metadata } from "next";
import { Suspense } from "react";
import { ContactDetail } from "@/components/customers/contact-detail";

export const metadata: Metadata = { title: "Customer" };

export default async function ContactPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params;
  return (
    <Suspense>
      <ContactDetail id={contactId} />
    </Suspense>
  );
}
