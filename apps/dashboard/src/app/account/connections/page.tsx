import type { Metadata } from "next";
import { ConnectionsView } from "@/components/account/connections-view";

export const metadata: Metadata = { title: "Connections" };

export default function ConnectionsPage() {
  return <ConnectionsView />;
}
