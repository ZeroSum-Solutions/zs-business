import { describe, expect, it } from "vitest";
import { addressesIn, classifyInbound, type ClassifyContext, type InboundMessage } from "../../src/outreach/classify.js";

const context: ClassifyContext = {
  mailboxAddress: "sam@sender.example",
  ownMessageIds: new Set(["own-1"]),
  prospectByThread: new Map([["thread-1", "p1"], ["thread-2", "p2"]]),
  prospectByAddress: new Map([["pat@acme.example", "p1"], ["lee@beta.example", "p2"], ["kim@gamma.example", "p3"]]),
};
const message = (id: string, threadId: string, headers: Record<string, string>, labelIds: string[] = ["INBOX"]): InboundMessage =>
  ({ id, threadId, labelIds, headers });

describe("classifyInbound (OS-19)", () => {
  it("skips a message this system sent", () => {
    expect(classifyInbound(message("own-1", "thread-1", { from: "Sam <sam@sender.example>" }, ["SENT"]), context)).toEqual({ kind: "own" });
  });

  it("calls any other message in a prospect's thread a reply, whoever wrote it", () => {
    expect(classifyInbound(message("m1", "thread-1", { from: "Pat <pat@acme.example>" }), context)).toEqual({ kind: "reply", prospectId: "p1" });
    expect(classifyInbound(message("m2", "thread-1", { from: "Pat's Assistant <ea@acme.example>" }), context)).toEqual({ kind: "reply", prospectId: "p1" });
  });

  it("finds a reply in a new thread by the prospect's address", () => {
    expect(classifyInbound(message("m3", "thread-new", { from: "kim@gamma.example" }), context)).toEqual({ kind: "reply", prospectId: "p3" });
    expect(classifyInbound(message("m4", "thread-new", { from: '"Lee, B" <LEE@beta.example>' }), context)).toEqual({ kind: "reply", prospectId: "p2" });
  });

  it("calls a mail system's message in the thread a bounce", () => {
    expect(classifyInbound(message("b1", "thread-1", { from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>" }), context))
      .toEqual({ kind: "bounce", prospectId: "p1" });
    expect(classifyInbound(message("b2", "thread-2", { from: "postmaster@acme.example", "auto-submitted": "auto-replied" }), context))
      .toEqual({ kind: "bounce", prospectId: "p2" });
  });

  it("finds a bounce outside the thread through X-Failed-Recipients", () => {
    expect(classifyInbound(message("b3", "thread-x", { from: "no-reply@relay.example", "x-failed-recipients": "other@x.example, Kim@Gamma.example" }), context))
      .toEqual({ kind: "bounce", prospectId: "p3" });
    expect(classifyInbound(message("b4", "thread-x", { from: "x@relay.example", "x-failed-recipients": "nobody@x.example" }), context)).toEqual({ kind: "unmatched" });
  });

  it("recognises a delivery-status report", () => {
    expect(classifyInbound(message("b5", "thread-1", {
      from: "someone@relay.example", "content-type": 'multipart/report; boundary="x"; report-type=delivery-status',
    }), context)).toEqual({ kind: "bounce", prospectId: "p1" });
    expect(classifyInbound(message("m5", "thread-1", { from: "pat@acme.example", "content-type": "multipart/alternative" }), context).kind).toBe("reply");
  });

  it("records an out-of-office without stopping anything, but treats Auto-Submitted: no as a person", () => {
    expect(classifyInbound(message("a1", "thread-1", { from: "pat@acme.example", "auto-submitted": "auto-replied" }), context))
      .toEqual({ kind: "auto_reply", prospectId: "p1" });
    expect(classifyInbound(message("a2", "thread-1", { from: "pat@acme.example", "auto-submitted": " No " }), context)).toEqual({ kind: "reply", prospectId: "p1" });
  });

  it("calls a SENT message the owner wrote in the thread an owner reply", () => {
    expect(classifyInbound(message("o1", "thread-1", { from: "sam@sender.example" }, ["SENT"]), context)).toEqual({ kind: "owner_reply", prospectId: "p1" });
    // The owner mailing a prospect in a new thread is no reply.
    expect(classifyInbound(message("o2", "thread-new", { from: "sam@sender.example" }, ["SENT"]), context)).toEqual({ kind: "unmatched" });
  });

  it("leaves a message that matches no prospect unmatched", () => {
    expect(classifyInbound(message("u1", "thread-9", { from: "newsletter@news.example" }), context)).toEqual({ kind: "unmatched" });
    expect(classifyInbound(message("u2", "thread-9", {}), context)).toEqual({ kind: "unmatched" });
  });

  it("reads addresses out of a header value", () => {
    expect(addressesIn('"A, B" <A@x.example>, c@y.example (note)')).toEqual(["a@x.example", "c@y.example"]);
    expect(addressesIn(undefined)).toEqual([]);
  });
});
