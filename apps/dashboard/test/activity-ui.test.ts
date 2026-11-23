// Backlog B05: the owner's Activity screen. Demo receipts match the contract, rows read in plain
// words, approval cards link to their receipt, and staff see an owner-only note.
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import { actionLogEntrySchema } from "@zs/contracts";
import { ActivityView, ACTIVITY_OWNER_ONLY, ReceiptView, receiptHref } from "../src/components/account/activity-view";
import { createDemoActions, DEMO_APPROVED_ACTION_ID } from "../src/lib/api/demo/actions";
import { actionLabel, actorLabel, approvalBadge, recordHref } from "../src/lib/action-log";
import { isApiError } from "../src/lib/api";
import { keys, renderScreen } from "./helpers/render";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => "/account/activity",
}));

const NOW = new Date("2026-11-20T15:00:00.000Z");
const api = createDemoActions({ clock: { now: () => NOW } });

describe("demo action log", () => {
  it("pages newest first by cursor in the contract's shape", async () => {
    const first = await api.listActions({ limit: 3 });
    expect(first.items).toHaveLength(3);
    for (const item of first.items) expect(actionLogEntrySchema.parse(item)).toEqual(item);
    const rest = await api.listActions({ cursor: first.nextCursor!, limit: 10 });
    const all = [...first.items, ...rest.items];
    expect(rest.nextCursor).toBeNull();
    expect(new Set(all.map((item) => item.id)).size).toBe(all.length);
    expect(all.map((item) => item.createdAt)).toEqual([...all.map((item) => item.createdAt)].sort().reverse());
    await expect(api.getAction("00000000-0000-4000-8000-000000000000")).rejects.toSatisfy((error) => isApiError(error, "not_found"));
    await expect(api.listActions({ cursor: "" })).rejects.toSatisfy((error) => isApiError(error, "validation"));
    await expect(api.listActions({ cursor: "00000000-0000-4000-8000-000000000000" })).rejects.toSatisfy((error) => isApiError(error, "validation"));
  });
});

describe("labels", () => {
  it("names actors without addresses", () => {
    expect(actorLabel({ kind: "agent", agent: "inquiry_followup" })).toBe("Follow-up agent");
    expect(actorLabel({ kind: "system", name: "public_intake" })).toBe("Your booking page");
    expect(actorLabel({ kind: "person", memberId: null, role: null })).toBe("A former member");
    expect(actorLabel({ kind: "person", memberId: DEMO_APPROVED_ACTION_ID, role: "staff" })).toBe("Staff");
    expect(actionLabel("inbox.reply.send")).toBe("Inbox reply send");
  });

  it("names where each approval stands today", () => {
    const id = DEMO_APPROVED_ACTION_ID;
    expect(approvalBadge({ id, status: "approved" })).toEqual({ label: "Approved", tone: "success" });
    expect(approvalBadge({ id, status: "expired" }).label).toBe("Approval expired");
    expect(approvalBadge({ id, status: "revoked" }).label).toBe("Approval revoked");
  });

  it("links a contact record to its page and nothing else", () => {
    const id = DEMO_APPROVED_ACTION_ID;
    expect(recordHref({ type: "contact", id })).toBe(`/customers/${id}`);
    expect(recordHref({ type: "booking", id })).toBeNull();
  });
});

describe("activity screen", () => {
  it("lists actions and links each approval card to its receipt", async () => {
    const page = await api.listActions();
    const html = renderScreen(h(ActivityView), {
      fill: (client) => { client.setQueryData(keys.actions, { pages: [page], pageParams: [null] }); },
    }).replaceAll("<!-- -->", "");
    expect(html).toContain("Activity");
    expect(html).toContain("Follow-up agent");
    const cards = [...html.matchAll(/<a [^>]*data-approval-card=""[^>]*>/g)].map((match) => match[0]);
    expect(cards.length).toBe(page.items.filter((item) => item.approval).length);
    for (const card of cards) expect(card).toMatch(/href="\/account\/activity\/[0-9a-f-]{36}"/);
    expect(html).toContain(`href="${receiptHref(DEMO_APPROVED_ACTION_ID)}"`);
  });

  it("shows a receipt with its record and approval", async () => {
    const entry = await api.getAction(DEMO_APPROVED_ACTION_ID);
    const html = renderScreen(h(ReceiptView, { id: entry.id }), {
      fill: (client) => { client.setQueryData(keys.action(entry.id), entry); },
    }).replaceAll("<!-- -->", "");
    expect(html).toContain(`data-receipt="${entry.id}"`);
    expect(html).toContain(entry.target.id);
    expect(html).toContain(entry.approval!.id);
    expect(html).toContain("Approved");
  });

  it("shows the full receipt ID and a contact's page", async () => {
    const entry = (await api.listActions({ limit: 20 })).items.find((item) => item.target.type === "contact")!;
    const html = renderScreen(h(ReceiptView, { id: entry.id }), {
      fill: (client) => { client.setQueryData(keys.action(entry.id), entry); },
    }).replaceAll("<!-- -->", "");
    expect(html).toContain(`>${entry.id}<`);
    expect(html).toContain(`href="/customers/${entry.target.id}"`);
    expect(html).toMatch(/<time dateTime="/i);
  });

  it("keeps the log from staff", () => {
    const html = renderScreen(h(ActivityView), { staff: true });
    expect(html).toContain(ACTIVITY_OWNER_ONLY);
    expect(html).not.toContain("data-action=");
  });
});
