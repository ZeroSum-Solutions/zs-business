import type { Metadata } from "next";
import { Suspense } from "react";
import { CustomersView } from "@/components/customers/customers-view";

export const metadata: Metadata = { title: "Customers" };

export default function CustomersPage() {
  return (
    <Suspense>
      <CustomersView />
    </Suspense>
  );
}
