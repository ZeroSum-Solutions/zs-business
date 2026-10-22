// The Inbox as it first paints with data (UI audit U1 and its visual review): the draft's
// actions, the composer, the list rows and the panes around them.
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import type { ThreadDetail } from "@zs/contracts";
import { composerSubmit, focusAfterStep, InboxView, REPLY_STATUS, stepNotice } from "../src/components/inbox/inbox-view";
import { ApiError, defaultMessage } from "../src/lib/api/errors";
import { demoApp, type DemoApp } from "./helpers/render";

async function seeded(app: DemoApp) {
  const page = await app.api.listThreads({ limit: 100 });
  app.queryClient.setQueryData(app.keys.threads, { pages: [page], pageParams: [null] });
  app.queryClient.setQueryData(app.keys.resources, await app.api.listResources());
  return page.items;
}

async function open(name: string, app?: DemoApp) {
  const workspace = app ?? await demoApp();
  const items = await seeded(workspace);
  const summary = items.find((item) => item.name === name)!;
  const thread = await workspace.api.getThread(summary.id);
  workspace.queryClient.setQueryData(workspace.keys.thread(summary.id), thread);
  return { html: workspace.render(h(InboxView, { selectedId: summary.id })), thread, app: workspace };
}

/** The opening tag of the first element whose text starts with `text`. */
function tagBefore(html: string, text: string): string {
  const at = html.indexOf(`>${text}`);
  expect(at, `"${text}" is on the page`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<", at), at + 1);
}

const conflict = (reason: string) => new ApiError("conflict", "", 409, "Conflict", { reason });
const withMessage = (reason: string, message: string) => Object.assign(conflict(reason), { message });

describe("a draft for a customer with no email address", () => {
  it("cannot be approved, says why next to the button and links to the customer record", async () => {
    const { html, thread } = await open("Dashiell Moreau");
    expect(thread.email).toBeNull();
    const approve = html.slice(html.lastIndexOf("<button", html.indexOf("Approve and queue")), html.indexOf("Approve and queue"));
    expect(approve).toMatch(/\sdisabled=""/);
    expect(html).toContain("Add an email address to the customer record to approve it.");
    expect(html).not.toContain("Approving queues it for delivery by email.");
    expect(html).toMatch(new RegExp(`href="/customers/${thread.contactId}"[^>]*>Open customer record<`));
  });
});

describe("draft actions", () => {
  it("name the step for what it does: approval queues the reply", async () => {
    const { html } = await open("Noor Haddad");
    expect(html).toContain("Approve and queue");
    expect(html).not.toContain("Approve and send");
  });

  it("draw Discard as a button with an edge, not as plain text", async () => {
    const { html } = await open("Noor Haddad");
    expect(tagBefore(html, "Discard")).toContain("shadow-[inset_0_0_0_1px_var(--border-strong)]");
  });
});

describe("the step error after approve or discard", () => {
  const draft = (thread: ThreadDetail) => thread.entries.flatMap((entry) => entry.type === "reply" ? [entry.reply] : []).find((reply) => reply.status === "draft")!;

  it("says the thread was reloaded only for conflicts that reload it", async () => {
    const { thread } = await open("Dashiell Moreau");
    const id = draft(thread).id;
    const noEmail = withMessage("no_email", "This customer has no email address yet. Add one in Customers, then approve the reply.");
    expect(stepNotice(noEmail, thread, id, null).message).not.toContain("reloaded");
    const other = withMessage("approved_by_other", "Another owner already approved this reply.");
    expect(stepNotice(other, thread, id, null).message).toBe("Another owner already approved this reply. The thread was reloaded.");
  });

  it("names who approved the reply when another owner got there first, as information", async () => {
    const app = await demoApp();
    const { thread: before } = await open("Noor Haddad", app);
    const id = draft(before).id;
    app.api.approveReplyElsewhere(id);
    const after = await app.api.getThread(before.id);
    const notice = stepNotice(withMessage("not_draft", "This reply is no longer a draft. Someone approved or discarded it first."), after, id, null);
    expect(notice.tone).toBe("info");
    expect(notice.message).toMatch(/^Already approved by .+@.+\. It is queued for delivery\.$/);
  });

  it("keeps the server's words until the thread has reloaded", async () => {
    const { thread } = await open("Noor Haddad");
    const notice = stepNotice(withMessage("not_draft", "This reply is no longer a draft."), thread, draft(thread).id, null);
    expect(notice).toEqual({ tone: "danger", message: "This reply is no longer a draft. The thread was reloaded." });
  });

  it("says a discarded draft was discarded", async () => {
    const { thread } = await open("Noor Haddad");
    const notice = stepNotice(withMessage("not_draft", "x"), thread, "00000000-0000-4000-8000-00000000dead", null);
    expect(notice).toEqual({ tone: "info", message: "Someone discarded this draft first." });
  });

  it("uses the error's own message for anything else", () => {
    const network = new ApiError("network", defaultMessage("network"));
    expect(stepNotice(network, undefined, "x", null)).toEqual({ tone: "danger", message: defaultMessage("network") });
  });
});

describe("focus after approve or discard", () => {
  const entries = (ids: [string, "draft" | "approved"][]) => ids.map(([id, status]) => ({ type: "reply" as const, reply: { id, status } }));

  it("lands on the approved reply", () => {
    expect(focusAfterStep("approve", "a", entries([["a", "approved"], ["b", "draft"]]))).toEqual({ replyId: "a" });
  });

  it("lands on the next waiting draft after a discard, else on the messages", () => {
    expect(focusAfterStep("discard", "a", entries([["b", "draft"], ["c", "approved"]]))).toEqual({ replyId: "b" });
    expect(focusAfterStep("discard", "a", entries([["c", "approved"]]))).toBe("messages");
  });

  it("waits while the reloaded thread still shows the reply as a draft", () => {
    expect(focusAfterStep("approve", "a", entries([["a", "draft"]]))).toBeNull();
    expect(focusAfterStep("discard", "a", entries([["a", "draft"]]))).toBeNull();
  });
});

describe("the composer", () => {
  it("says an empty subject uses the business name, without naming any business", async () => {
    const { html } = await open("Noor Haddad");
    const form = html.slice(html.indexOf("<form"), html.indexOf("</form>"));
    expect(form).not.toMatch(/Halden|Rowe|Jewel/);
    expect(form).toContain("Leave it empty to use “Message from” and your business name.");
    expect(form).toMatch(/id="reply-subject"[^>]*aria-describedby="reply-subject-help"|aria-describedby="reply-subject-help"[^>]*id="reply-subject"/);
  });

  it("asks for another reply when a draft is already waiting", async () => {
    const { html } = await open("Noor Haddad");
    expect(html).toContain("Write another reply to Noor Haddad");
    const linnea = await open("Linnea Castellanos");
    expect(linnea.html).toContain("Reply to Linnea Castellanos");
    expect(linnea.html).not.toContain("Write another reply");
  });

  it("reddens the reply box when it is invalid", async () => {
    const { html } = await open("Noor Haddad");
    expect(html).toMatch(/<textarea[^>]*aria-invalid:shadow-\[inset_0_0_0_1px_var\(--danger\)\]/);
  });

  it("keeps Save draft on the right when it wraps under the help text", async () => {
    const { html } = await open("Noor Haddad");
    expect(tagBefore(html, "Save draft")).toContain("ml-auto");
  });

  it("ignores a submit while a save is pending, and an empty one right after a save", () => {
    expect(composerSubmit({ body: "Hi", pending: true, justSaved: false })).toBe("ignore");
    expect(composerSubmit({ body: "  ", pending: false, justSaved: true })).toBe("ignore");
    expect(composerSubmit({ body: "  ", pending: false, justSaved: false })).toBe("empty");
    expect(composerSubmit({ body: "Hi", pending: false, justSaved: true })).toBe("save");
  });
});

describe("thread rows", () => {
  it("wrap a long unbroken preview inside a column that cannot grow past the list", async () => {
    const { html } = await open("Noor Haddad");
    expect(html).toMatch(/<ul aria-label="Conversations" class="[^"]*grid-cols-1/);
    expect(tagBefore(html, "Hi Noor")).toContain("[overflow-wrap:anywhere]");
  });

  it("mark the open conversation with a tint, leaving the outline ring to keyboard focus", async () => {
    const { html } = await open("Noor Haddad");
    const row = html.slice(html.lastIndexOf("<a", html.indexOf('aria-current="true"')), html.indexOf('aria-current="true"') + 200);
    expect(row).toContain("bg-accent-tint");
    expect(row).not.toContain("0_0_0_2px_var(--accent)");
  });
});

describe("the conversation pane", () => {
  it("keeps times, dates and phone numbers whole", async () => {
    const { html } = await open("Marguerite Okafor");
    expect(html).toMatch(/<span class="whitespace-nowrap">\+1 212 555 0142<\/span>/);
    expect(html).toMatch(/<span class="whitespace-nowrap">\d{1,2}:\d{2} [AP]M<\/span>/);
  });

  it("gives the Website visitor chip an edge on the grey header", async () => {
    const { html } = await open("M. Okafor");
    expect(tagBefore(html, "Website visitor").length).toBeGreaterThan(0);
    const chip = html.slice(html.lastIndexOf('<span class="', html.indexOf("Website visitor")), html.indexOf("Website visitor"));
    expect(chip).toContain("shadow-[inset_0_0_0_1px_var(--border)]");
  });

  it("marks a booking that has passed as past", async () => {
    // Marguerite's request booked a time that is already over in the seed.
    const { html, thread } = await open("Marguerite Okafor");
    const booking = thread.entries.find((entry) => entry.type === "request" && entry.booking)!;
    expect(booking.type === "request" && Date.parse(booking.booking!.startsAt) < Date.now()).toBe(true);
    expect(html).toContain(">Past<");
    expect(html).not.toContain("Booked Showroom for");
  });

  it("hides the page description on a phone while a conversation is open", async () => {
    const { html } = await open("Noor Haddad");
    expect(tagBefore(html, "Website requests and your replies")).toContain("hidden lg:inline");
  });

  it("shows a missing conversation on the grey panel without a second way back", async () => {
    const app = await demoApp();
    await seeded(app);
    const id = "c_00000000-0000-4000-8000-000000000000";
    const query = app.queryClient.getQueryCache().build(app.queryClient, { queryKey: app.keys.thread(id) });
    query.setState({ status: "error", error: await app.api.getThread(id).then(() => null, (error: unknown) => error as Error), fetchStatus: "idle" });
    const html = app.render(h(InboxView, { selectedId: id }));
    expect(html).toContain("We could not find that conversation.");
    expect(html).not.toContain("Back to all conversations");
    expect(html).toMatch(/<div class="tray[^"]*"[^>]*><div role="alert"/);
  });

  it("says the list could not load instead of asking to pick a conversation", async () => {
    const app = await demoApp();
    const query = app.queryClient.getQueryCache().build(app.queryClient, { queryKey: app.keys.threads });
    query.setState({ status: "error", error: new ApiError("network", defaultMessage("network")), fetchStatus: "idle" });
    const html = app.render(h(InboxView, { selectedId: null }));
    expect(html).not.toContain("Pick a conversation");
    expect(html).toContain("Conversations show here once they load.");
  });
});

describe("reply states", () => {
  it("draw a sent reply apart from a queued one", () => {
    expect(REPLY_STATUS.sent.tone).not.toBe(REPLY_STATUS.approved.tone);
  });
});
