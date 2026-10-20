/**
 * Read models for areas that have no HTTP route yet (results, wallet, inbox, agents,
 * connections, plan). TODO(api): move each to a route as it is built.
 */

export interface WeekCompare {
  thisWeek: number;
  lastWeek: number;
}

export interface RevenueSource {
  source: string;
  thisWeek: number;
  lastWeek: number;
}

export interface Results {
  currency: string;
  leads: WeekCompare;
  bookings: WeekCompare;
  revenue: WeekCompare;
  revenueBySource: RevenueSource[];
}

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

export type Channel = "sms" | "email" | "instagram" | "webchat";

export interface ThreadSummary {
  id: string;
  contactName: string;
  channel: Channel;
  preview: string;
  updatedAt: string;
  unread: boolean;
  needsReply: boolean;
}

export interface Message {
  id: string;
  from: "customer" | "business" | "agent";
  author: string;
  body: string;
  sentAt: string;
}

export interface Thread extends ThreadSummary {
  messages: Message[];
}

export type AgentStatus = "running" | "paused" | "needs_approval";

export interface Agent {
  id: string;
  name: string;
  description: string;
  status: AgentStatus;
  lastRun: string;
  actionsThisWeek: number;
}

export interface ApprovalItem {
  id: string;
  agentId: string;
  summary: string;
  draft: string;
  createdAt: string;
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
  getResults(): Promise<Results>;
  getUsage(): Promise<Usage>;
  getChecklist(): Promise<ChecklistItem[]>;
  listThreads(): Promise<ThreadSummary[]>;
  getThread(id: string): Promise<Thread>;
  listAgents(): Promise<Agent[]>;
  listApprovals(): Promise<ApprovalItem[]>;
  listConnections(): Promise<Connection[]>;
  getPlan(): Promise<Plan>;
  /** Ends the plan at the end of the paid period. */
  cancelPlan(): Promise<Plan>;
}
