import type { Metadata } from "next";
import { ReceiptView } from "@/components/account/activity-view";

export const metadata: Metadata = { title: "Receipt" };

export default async function ReceiptPage({ params }: { params: Promise<{ actionId: string }> }) {
  const { actionId } = await params;
  return <ReceiptView id={actionId} />;
}
