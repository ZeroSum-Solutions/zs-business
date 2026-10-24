// enrichment.md E-14: the owner reviews found company details before any of them reach a customer.
// Server-rendered with the query cache filled, as the page first paints; the decide path is tested
// on its own, since the screen only calls it.
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import type { EnrichmentProposal } from "@zs/contracts";
import { EnrichmentProposals, FIELD_LABEL, decideProposals } from "../src/components/customers/enrichment-proposals";
import { ApiError } from "../src/lib/api";
import { createIntentKeys } from "../src/lib/intent-key";
import { keys, renderScreen } from "./helpers/render";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => "/customers/enrichment",
}));

const uuid = (n: number) => `3b5d7f91-2c4e-4a6b-8d0f-${String(n).padStart(12, "0")}`;
const COLM = uuid(1);
const CELESTE = uuid(2);
const fetchedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
const proposal = (n: number, patch: Partial<EnrichmentProposal>): EnrichmentProposal => ({
  approvalId: uuid(100 + n), contactId: COLM, contactName: "Colm Brennan", resultId: uuid(200 + n), field: "name",
  currentValue: null, proposedValue: "Brennan Studio", provider: "treg", callId: `call_${n}`, fetchedAt,
  requestedAt: fetchedAt, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), ...patch,
});
const PROPOSALS = [
  proposal(1, {}),
  proposal(2, { field: "linkedin_url", proposedValue: "https://www.linkedin.com/company/brennan-studio" }),
  proposal(3, { contactId: CELESTE, contactName: "Celeste Vandermeer", field: "industry", currentValue: "Art dealer", proposedValue: "Fine art advisory" }),
  proposal(4, { contactId: CELESTE, contactName: "Celeste Vandermeer", field: "founded", currentValue: null, proposedValue: "2009", provider: "acme-data" }),
];

const render = (items: EnrichmentProposal[], staff = false) =>
  renderScreen(h(EnrichmentProposals), { staff, fill: (client) => client.setQueryData(keys.enrichmentProposals, items) }).replaceAll("<!-- -->", "");
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replace(/\s+/g, " ");

describe("company details to review", () => {
  it("groups proposals by customer, linking each customer, with old and new values and the source", () => {
    const html = render(PROPOSALS);
    const text = textOf(html);
    expect(html).toMatch(/<h1[^>]*>Company details to review<\/h1>/);
    expect(html).toContain(`href="/customers/${COLM}"`);
    expect(html).toContain(`href="/customers/${CELESTE}"`);
    // Colm's rows come before Celeste's, each under its customer.
    expect(text.indexOf("Colm Brennan")).toBeLessThan(text.indexOf("Brennan Studio"));
    expect(text.indexOf("Brennan Studio")).toBeLessThan(text.indexOf("Celeste Vandermeer"));
    expect(text).toMatch(/Company Empty .*Brennan Studio/);
    expect(text).toMatch(/Industry Art dealer .*Fine art advisory/);
    expect(text).toContain("Found by Treg, 2 h ago");
    // Another provider is named.
    expect(text).toContain("Found by acme-data");
  });

  it("matches the Company details card's labels", () => {
    expect(FIELD_LABEL).toEqual({
      name: "Company", domain: "Website", industry: "Industry", description: "About", employees: "Employees",
      founded: "Founded", location: "Location", linkedin_url: "LinkedIn",
    });
  });

  it("shows found values as text, never as markup or a live link", () => {
    const html = render([proposal(9, { field: "description", proposedValue: '<img src=x onerror="alert(1)">' }), PROPOSALS[1]!]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x");
    expect(html).not.toContain('href="https://www.linkedin.com');
    expect(html).toContain("https://www.linkedin.com/company/brennan-studio");
  });

  it("offers an owner Approve and Reject per row, named for the field and the customer, and batch actions", () => {
    const html = render(PROPOSALS);
    expect(html).toContain('aria-label="Approve Company for Colm Brennan"');
    expect(html).toContain('aria-label="Reject Industry for Celeste Vandermeer"');
    expect(html).toContain('aria-label="Select Founded for Celeste Vandermeer"');
    expect(html).toContain("Select all");
    expect(html).toMatch(/<button[^>]*min-h-11/);
  });

  it("shows staff the list read-only, with a note that an owner decides", () => {
    const text = textOf(render(PROPOSALS, true));
    expect(text).toContain("Brennan Studio");
    expect(text).toContain("An owner approves or rejects each detail");
    const html = render(PROPOSALS, true);
    expect(html).not.toMatch(/aria-label="(Approve|Reject|Select) /);
    expect(html).not.toContain("Select all");
    expect(html).not.toContain('type="checkbox"');
  });

  it("says when there is nothing to review", () => {
    expect(textOf(render([]))).toContain("Nothing to review. New company details appear here after a lookup.");
  });
});

describe("deciding proposals", () => {
  const keyed = () => {
    let n = 0;
    return createIntentKeys(() => `key-${++n}`);
  };

  it("approves one with its own idempotency key", async () => {
    const decide = vi.fn(async () => undefined);
    const outcome = await decideProposals({ decideEnrichmentProposal: decide }, [uuid(101)], "approve", keyed());
    expect(decide).toHaveBeenCalledExactlyOnceWith(uuid(101), "approve", { idempotencyKey: "key-1" });
    expect(outcome).toEqual({ done: [uuid(101)], failed: new Map() });
  });

  it("rejects one", async () => {
    const decide = vi.fn(async () => undefined);
    await decideProposals({ decideEnrichmentProposal: decide }, [uuid(103)], "reject", keyed());
    expect(decide).toHaveBeenCalledExactlyOnceWith(uuid(103), "reject", { idempotencyKey: "key-1" });
  });

  it("decides a batch one at a time, one key per proposal, and keeps going past a failure", async () => {
    const order: string[] = [];
    let running = 0;
    const conflict = new ApiError("conflict", "Already decided.", 409);
    const decide = vi.fn(async (id: string) => {
      running += 1;
      expect(running).toBe(1);
      order.push(id);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      if (id === uuid(102)) throw conflict;
    });
    const outcome = await decideProposals({ decideEnrichmentProposal: decide }, [uuid(101), uuid(102), uuid(103)], "approve", keyed());
    expect(order).toEqual([uuid(101), uuid(102), uuid(103)]);
    expect(decide.mock.calls.map((call) => (call as unknown as [string, string, { idempotencyKey: string }])[2].idempotencyKey)).toEqual(["key-1", "key-2", "key-3"]);
    expect(outcome.done).toEqual([uuid(101), uuid(103)]);
    expect([...outcome.failed.entries()]).toEqual([[uuid(102), conflict]]);
  });

  it("reuses the key on retry after a lost answer, so the server replays instead of deciding twice", async () => {
    const intents = keyed();
    const lost = new ApiError("network", "You look offline.");
    const decide = vi.fn().mockRejectedValueOnce(lost).mockResolvedValueOnce(undefined);
    await decideProposals({ decideEnrichmentProposal: decide }, [uuid(101)], "approve", intents);
    await decideProposals({ decideEnrichmentProposal: decide }, [uuid(101)], "approve", intents);
    expect(decide.mock.calls.map((call) => call[2])).toEqual([{ idempotencyKey: "key-1" }, { idempotencyKey: "key-1" }]);
  });
});
