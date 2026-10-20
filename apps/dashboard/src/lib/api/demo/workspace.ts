/** Made-up read-only content for areas without an HTTP route yet (wallet, site, agents, connections, plan). TODO(api). */
import type {
  Agent,
  ApprovalItem,
  ChecklistItem,
  Connection,
  Plan,
  Usage,
  WorkspaceApi,
} from "../workspace-types";
import type { DemoClock } from "./adapter";

export function createDemoWorkspace(options: { clock?: DemoClock; latencyMs?: number } = {}): WorkspaceApi {
  const clock = options.clock ?? { now: () => new Date() };
  const latency = options.latencyMs ?? 0;
  const wait = () => (latency > 0 ? new Promise((resolve) => setTimeout(resolve, latency)) : Promise.resolve());
  const ago = (minutes: number) => new Date(clock.now().getTime() - minutes * 60000).toISOString();
  const ahead = (days: number) => new Date(clock.now().getTime() + days * 86400000).toISOString();

  const usage: Usage = {
    currency: "USD",
    walletBalance: 41.18,
    walletTopUp: 60,
    periodLabel: "October",
    lines: [
      { id: "sms", label: "Text messages", used: 312, cap: 500, unit: "texts", unitPrice: 0.012 },
      { id: "ai", label: "Agent replies", used: 1184, cap: 2000, unit: "replies", unitPrice: 0.004 },
      { id: "email", label: "Emails", used: 2950, cap: 5000, unit: "emails", unitPrice: 0.001 },
    ],
  };

  const checklist: ChecklistItem[] = [
    { id: "instagram", label: "Reconnect Instagram", detail: "Access expired 2 days ago. New DMs are not reaching your inbox.", status: "action", actionLabel: "Reconnect" },
    { id: "gbp", label: "Allow Google Business Profile", detail: "Grant review access so review requests can link to your profile.", status: "action", actionLabel: "Allow access" },
    { id: "calendar", label: "Google Calendar", detail: "Syncing both calendars.", status: "ok", actionLabel: null },
    { id: "stripe", label: "Stripe deposits", detail: "Deposits land in your account in 2 days.", status: "ok", actionLabel: null },
  ];

  const agents: Agent[] = [
    { id: "front-desk", name: "Front desk", description: "Answers new messages on text, email, Instagram and web chat.", status: "running", lastRun: ago(6), actionsThisWeek: 87 },
    { id: "reminders", name: "Appointment reminders", description: "Texts a reminder the day before and asks customers to confirm.", status: "running", lastRun: ago(55), actionsThisWeek: 31 },
    { id: "follow-up", name: "Lead follow-up", description: "Drafts a follow-up when an inquiry goes quiet for three days.", status: "needs_approval", lastRun: ago(140), actionsThisWeek: 9 },
    { id: "reviews", name: "Review requests", description: "Asks for a review a week after pickup.", status: "paused", lastRun: ago(60 * 24 * 6), actionsThisWeek: 0 },
  ];

  const approvals: ApprovalItem[] = [
    { id: "a-1", agentId: "follow-up", createdAt: ago(140), summary: "Follow up with Yuki Tanabe-Ross about matching bands",
      draft: "Hi Yuki, it was lovely meeting you both. Would you like to come in to try a few band widths? We have Saturday morning open." },
    { id: "a-2", agentId: "follow-up", createdAt: ago(200), summary: "Follow up with Celeste Vandermeer about the emerald commission",
      draft: "Hi Celeste, I've set aside two emeralds that would suit a 3.5 mm band. Happy to show you whenever suits." },
  ];

  const connections: Connection[] = [
    { id: "gcal", name: "Google Calendar", purpose: "Keeps showroom and repair calendars in sync", status: "connected", detail: "Synced 4 minutes ago" },
    { id: "gmail", name: "Gmail", purpose: "Sends and receives customer email", status: "connected", detail: "hello@haldenrowe.example" },
    { id: "instagram", name: "Instagram", purpose: "Brings DMs into your inbox", status: "needs_reconnect", detail: "Access expired 2 days ago" },
    { id: "stripe", name: "Stripe", purpose: "Takes design deposits", status: "connected", detail: "Payouts every 2 days" },
    { id: "sms", name: "Text number", purpose: "Your business number for texts", status: "connected", detail: "+1 212 555 0100" },
    { id: "gbp", name: "Google Business Profile", purpose: "Links review requests to your profile", status: "needs_permission", detail: "Review access not granted" },
    { id: "domain", name: "haldenrowe.example", purpose: "Your website address", status: "verifying", detail: "DNS change seen, finishing checks" },
  ];

  let plan: Plan = {
    name: "Studio",
    currency: "USD",
    pricePerMonth: 149,
    renewsOn: ahead(30),
    status: "active",
    endsOn: null,
    includes: ["Six areas, all features", "Two team seats", "Website and booking pages", "Agents with approval"],
    caps: [
      { label: "Text messages", value: "500 a month, then from your wallet" },
      { label: "Agent replies", value: "2,000 a month, then from your wallet" },
      { label: "Wallet", value: "Prepaid. Sending pauses at $0. No surprise bills." },
    ],
  };

  return {
    async getUsage() { await wait(); return structuredClone(usage); },
    async getChecklist() { await wait(); return structuredClone(checklist); },
    async listAgents() { await wait(); return structuredClone(agents); },
    async listApprovals() { await wait(); return structuredClone(approvals); },
    async listConnections() { await wait(); return structuredClone(connections); },
    async getPlan() { await wait(); return structuredClone(plan); },
    async cancelPlan() {
      await wait();
      plan = { ...plan, status: "cancelled", endsOn: plan.renewsOn };
      return structuredClone(plan);
    },
  };
}
