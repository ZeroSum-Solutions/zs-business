// Who may do what with a waiting draft (inbox-home.md I-6, I-7, H-6): owners approve, anyone
// with inbox.drafts discards, and staff see that an owner approves it.
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS, roleCan, type ReplyRecord } from "@zs/contracts";
import { DraftActions, QUEUED_MESSAGE, RedraftAction, REPLY_STATUS } from "../src/components/inbox/inbox-view";
import { APPROVE_REPLIES } from "../src/lib/session";

const reply: ReplyRecord = {
  id: "e7f9a1b3-5c7d-4e9f-8a1b-000000000001", tenantId: "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a70",
  contactId: "5e0c1a2b-7d3f-4c8a-9b1e-000000000001", channel: "email", subject: "Hello", body: "Hi", status: "draft",
  draftedBy: { userId: "9a1b3c5d-7e9f-4a1b-8c2d-000000000002", email: "staff@example.com" }, createdAt: "2026-10-20T12:00:00.000Z",
  approvedBy: null, approvedAt: null, discardedAt: null, settledAt: null, deliveryReason: null,
};
const render = (role: "owner" | "staff") => renderToString(h(DraftActions, {
  reply, canApprove: roleCan(role, APPROVE_REPLIES), canDiscard: roleCan(role, "inbox.drafts"), busy: false, onStep: () => undefined,
})).replaceAll("<!-- -->", "");

describe("draft actions", () => {
  it("offers an owner Approve and queue and Discard, and says approval queues it", () => {
    const html = render("owner");
    expect(html).toContain("Approve and queue");
    expect(html).toContain(">Discard<");
    expect(html).toContain("Approving queues it for delivery by email.");
    expect(html).toMatch(/aria-describedby="draft-note-e7f9a1b3-5c7d-4e9f-8a1b-000000000001"/);
  });

  it("offers staff Discard only and says an owner approves it", () => {
    expect(ROLE_PERMISSIONS.staff).not.toContain(APPROVE_REPLIES);
    expect(ROLE_PERMISSIONS.owner).toContain(APPROVE_REPLIES);
    const html = render("staff");
    expect(html).not.toContain("Approve and queue");
    expect(html).toContain(">Discard<");
    expect(html).toContain("Waiting for an owner to approve it before it is queued to send.");
  });

  it("offers a reply stopped for a changed address a way to draft it again (approvals.md A-16)", () => {
    const html = renderToString(h(RedraftAction, { busy: false, onRedraft: () => undefined })).replaceAll("<!-- -->", "");
    expect(html).toContain("Draft again for the new address");
    expect(html).not.toContain('disabled=""');
    expect(renderToString(h(RedraftAction, { busy: true, onRedraft: () => undefined }))).toContain('disabled=""');
    const noEmail = renderToString(h(RedraftAction, { busy: false, onRedraft: () => undefined, noEmailRecord: "/customers/x" }));
    expect(noEmail).toContain('disabled=""');
    expect(noEmail).toContain('href="/customers/x"');
  });

  it("never says an approved reply was sent", () => {
    expect(REPLY_STATUS.approved.label).toBe("Approved and queued");
    expect(QUEUED_MESSAGE).toMatch(/queued for delivery/);
    expect(QUEUED_MESSAGE).not.toMatch(/\bsent\b/i);
  });
});
