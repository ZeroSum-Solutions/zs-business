/**
 * Read models for areas that have no HTTP route yet (wallet and usage, the connections
 * checklist, site, connections, plan). TODO(api): move each to a route as it is built.
 * Inbox and Home results moved to `InboxApi` and `HomeApi` (inbox-home.md), and Agents to
 * `AgentsApi` (agents.md).
 */

export interface UsageLine {
  id: string;
  label: string;
  used: number;
  cap: number;
  unit: string;
  unitPrice: number;
}

export interface Usage {
  currency: string;
  /** Prepaid balance. It never goes below zero: sending pauses at zero. */
  walletBalance: number;
  walletTopUp: number;
  periodLabel: string;
  lines: UsageLine[];
}

export type ChecklistStatus = "ok" | "action";

export interface ChecklistItem {
  id: string;
  label: string;
  detail: string;
  status: ChecklistStatus;
  actionLabel: string | null;
}

export interface SiteSlot {
  id: string;
  label: string;
  kind: "text" | "longtext" | "image";
  value: string;
}

export interface SitePage {
  id: string;
  title: string;
  path: string;
  status: "live" | "draft";
  updatedAt: string;
  slots: SiteSlot[];
}

export type ConnectionStatus = "connected" | "needs_reconnect" | "needs_permission" | "verifying";

export interface Connection {
  id: string;
  name: string;
  purpose: string;
  status: ConnectionStatus;
  detail: string;
}

export interface Plan {
  name: string;
  currency: string;
  pricePerMonth: number;
  renewsOn: string;
  status: "active" | "cancelled";
  endsOn: string | null;
  includes: string[];
  caps: { label: string; value: string }[];
}

export interface WorkspaceApi {
  getUsage(): Promise<Usage>;
  getChecklist(): Promise<ChecklistItem[]>;
  listSitePages(): Promise<SitePage[]>;
  listConnections(): Promise<Connection[]>;
  getPlan(): Promise<Plan>;
  /** Ends the plan at the end of the paid period. */
  cancelPlan(): Promise<Plan>;
}
