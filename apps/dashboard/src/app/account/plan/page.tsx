import type { Metadata } from "next";
import { PlanView } from "@/components/account/plan-view";

export const metadata: Metadata = { title: "Plan" };

export default function PlanPage() {
  return <PlanView />;
}
