/**
 * The demo adapter's company details (enrichment.md E-4, E-6, E-14, E-17). It keeps the rules the API
 * enforces that a screen can show: only an owner asks or decides, a customer needs a company web
 * domain (a free-mail address has none), and a refused request names its reason. A new request is
 * never looked up: it ends as "no match", so a visitor sees the whole flow and nothing is invented.
 *
 * Two seeded customers already have a finished lookup whose fields wait for an owner (E-14): Colm
 * Brennan, who has no company details yet, and Celeste Vandermeer, whose details would change. An
 * owner approves a proposal (the value is written to the customer's company details) or rejects it;
 * either way it leaves the list, and a second decision is a conflict as in the API. The data is in
 * memory and starts again on every page load.
 */
import { uuidSchema, type ContactEnrichment, type ContactProfileRecord, type EnrichmentField, type EnrichmentProposal, type EnrichmentRequestRecord, type EnrichmentResultRecord } from "@zs/contracts";
import { contactNotFound, demoError, proposalNotFound } from "../errors";
import type { EnrichmentApi, WriteOptions } from "../types";
import type { DemoActor } from "./agents";
import { contactId } from "./seed";

export interface DemoEnrichmentContext {
  now(): Date;
  newId(): string;
  wait(): Promise<void>;
  idempotent<T>(operation: string, payload: unknown, options: WriteOptions, run: () => T): Promise<T>;
  actor(): DemoActor;
  hasContact(id: string): boolean;
  /** The customer's display name, or null for an unknown one. */
  contactName(id: string): string | null;
  /** The part of the customer's email after the @, or null without one. */
  contactDomain(id: string): string | null;
}

/** Addresses at these hosts say nothing about a company (E-4). */
const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com", "proton.me", "protonmail.com"]);
/** The EU, EEA and UK top-level domains the demo knows to refuse (E-7); the API holds the full list. */
const REFUSED_TLDS = new Set(["de", "fr", "nl", "es", "it", "ie", "uk", "se", "dk", "fi", "pl", "pt", "at", "be", "no", "eu"]);

/** Each found field's profile column; employees and founded are whole numbers there. */
const COLUMNS: Readonly<Record<EnrichmentField, keyof ContactProfileRecord>> = {
  name: "companyName", domain: "companyDomain", industry: "companyIndustry", description: "companyDescription",
  employees: "companyEmployees", founded: "companyFounded", location: "companyLocation", linkedin_url: "companyLinkedinUrl",
};
const NUMERIC = new Set<EnrichmentField>(["employees", "founded"]);
/** E-14: a found value is kept, and can be approved, for 30 days. */
const RESULT_DAYS = 30;

const requestId = (n: number) => `7a9c1e3f-5b7d-4f9a-8b2c-${String(n).padStart(12, "0")}`;
const resultId = (n: number) => `6c8e0a2b-4d6f-4b8a-9c1e-${String(n).padStart(12, "0")}`;
/** The seeded `contact.profile.apply` approvals, one per proposed field. */
export const proposalId = (n: number) => `8d2f4b6a-1c3e-4a5b-9e7f-${String(n).padStart(12, "0")}`;

/** Seeded customers (seed.ts CONTACTS) with a finished lookup whose fields wait for an owner. */
export const BRENNAN_ID = contactId(4);
export const VANDERMEER_ID = contactId(10);

interface SeededLookup {
  contactId: string;
  domain: string;
  callId: string;
  /** How long before the demo clock the answer arrived. */
  hoursAgo: number;
  fields: [EnrichmentField, string][];
}

const LOOKUPS: SeededLookup[] = [
  {
    contactId: VANDERMEER_ID, domain: "vandermeer.example", callId: "call_demo_vandermeer", hoursAgo: 5,
    fields: [["name", "Vandermeer & Co."], ["industry", "Fine art advisory"], ["founded", "2009"]],
  },
  {
    contactId: BRENNAN_ID, domain: "brennan-studio.example", callId: "call_demo_brennan", hoursAgo: 3,
    fields: [
      ["name", "Brennan Studio"], ["industry", "Architecture and interior design"], ["employees", "12"],
      ["location", "Brooklyn, NY, US"], ["linkedin_url", "https://www.linkedin.com/company/brennan-studio"],
    ],
  },
];

type Decision = "pending" | "approved" | "rejected";
interface DemoProposal {
  approvalId: string;
  result: EnrichmentResultRecord;
  requestedAt: string;
  status: Decision;
}

const clone = <T>(value: T): T => structuredClone(value);
const at = (from: Date, minutes: number) => new Date(from.getTime() + minutes * 60_000).toISOString();

function emptyProfile(contactId: string, updatedAt: string): ContactProfileRecord {
  return {
    contactId, companyName: null, companyDomain: null, companyIndustry: null, companyDescription: null, companyEmployees: null,
    companyFounded: null, companyLocation: null, companyLinkedinUrl: null, country: null, doNotEnrichAt: null, doNotEnrichReason: null,
    outsideEuUkAttestedAt: null, revision: 1, updatedAt,
  };
}

export function createDemoEnrichment(ctx: DemoEnrichmentContext): EnrichmentApi {
  const start = ctx.now();
  const requests = new Map<string, EnrichmentRequestRecord[]>();
  const profiles = new Map<string, ContactProfileRecord>([[VANDERMEER_ID, {
    ...emptyProfile(VANDERMEER_ID, at(start, -60 * 24 * 21)),
    companyName: "Vandermeer Gallery", companyIndustry: "Art dealer",
  }]]);
  const proposals: DemoProposal[] = [];

  let serial = 0;
  LOOKUPS.forEach((lookup, index) => {
    const fetchedAt = at(start, -60 * lookup.hoursAgo);
    const created = at(start, -60 * lookup.hoursAgo - 1);
    const request: EnrichmentRequestRecord = {
      id: requestId(index + 1), contactId: lookup.contactId, op: "company.enrich", status: "succeeded", reason: null,
      domain: lookup.domain, priceCents: 5, createdAt: created, updatedAt: fetchedAt,
    };
    requests.set(lookup.contactId, [request]);
    for (const [field, value] of lookup.fields) {
      serial += 1;
      proposals.push({
        approvalId: proposalId(serial),
        requestedAt: at(start, -60 * lookup.hoursAgo + 1),
        status: "pending",
        result: {
          id: resultId(serial), requestId: request.id, contactId: lookup.contactId, field, value, provider: "treg",
          callId: lookup.callId, fetchedAt, expiresAt: at(new Date(fetchedAt), 60 * 24 * RESULT_DAYS),
          approvalId: proposalId(serial),
        },
      });
    }
  });

  const live = (proposal: DemoProposal) => proposal.result.expiresAt > ctx.now().toISOString();
  const currentValue = (proposal: DemoProposal): string | null => {
    const value = profiles.get(proposal.result.contactId)?.[COLUMNS[proposal.result.field]];
    return value === null || value === undefined ? null : String(value);
  };

  function apply(proposal: DemoProposal) {
    const { contactId: id, field, value } = proposal.result;
    const updatedAt = ctx.now().toISOString();
    const before = profiles.get(id);
    const profile = before ? { ...before, revision: before.revision + 1, updatedAt } : emptyProfile(id, updatedAt);
    profiles.set(id, { ...profile, [COLUMNS[field]]: NUMERIC.has(field) ? Number(value) : value });
  }

  return {
    async getContactEnrichment(contactId) {
      await ctx.wait();
      if (!ctx.hasContact(contactId)) throw contactNotFound();
      const results = proposals
        .filter((proposal) => proposal.result.contactId === contactId && live(proposal))
        .map((proposal) => ({ ...proposal.result, approvalId: proposal.status === "pending" ? proposal.approvalId : null }));
      const answer: ContactEnrichment = { profile: clone(profiles.get(contactId) ?? null), requests: clone(requests.get(contactId) ?? []), results: clone(results) };
      return answer;
    },

    async requestEnrichment(contactId, options) {
      if (ctx.actor().role !== "owner") {
        await ctx.wait();
        throw demoError("Forbidden");
      }
      return ctx.idempotent("enrichment.request", { contactId }, options, () => {
        if (!ctx.hasContact(contactId)) throw demoError("Forbidden");
        const domain = ctx.contactDomain(contactId);
        if (domain === null || FREE_MAIL.has(domain)) throw demoError("Conflict", { reason: "enrichment_no_company_domain" });
        if (REFUSED_TLDS.has(domain.split(".").at(-1) ?? "")) throw demoError("Conflict", { reason: "enrichment_region_blocked" });
        const stamp = ctx.now().toISOString();
        const record: EnrichmentRequestRecord = {
          id: ctx.newId(), contactId, op: "company.enrich", status: "no_match", reason: null, domain, priceCents: 5,
          createdAt: stamp, updatedAt: stamp,
        };
        requests.set(contactId, [record, ...(requests.get(contactId) ?? [])]);
        return record;
      });
    },

    async listEnrichmentProposals() {
      await ctx.wait();
      const items: EnrichmentProposal[] = proposals
        .filter((proposal) => proposal.status === "pending" && live(proposal) && ctx.hasContact(proposal.result.contactId))
        .map((proposal) => ({
          approvalId: proposal.approvalId,
          contactId: proposal.result.contactId,
          contactName: ctx.contactName(proposal.result.contactId) ?? "",
          resultId: proposal.result.id,
          field: proposal.result.field,
          currentValue: currentValue(proposal),
          proposedValue: proposal.result.value,
          provider: proposal.result.provider,
          callId: proposal.result.callId,
          fetchedAt: proposal.result.fetchedAt,
          requestedAt: proposal.requestedAt,
          expiresAt: proposal.result.expiresAt,
        }))
        // Oldest first, as the API orders them.
        .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.contactName.localeCompare(b.contactName) || a.field.localeCompare(b.field));
      return clone(items);
    },

    async decideEnrichmentProposal(approvalId, decision, options) {
      if (ctx.actor().role !== "owner") {
        await ctx.wait();
        throw demoError("Forbidden");
      }
      if (!uuidSchema.safeParse(approvalId).success) {
        await ctx.wait();
        throw proposalNotFound();
      }
      await ctx.idempotent(`enrichment.proposal.${decision}`, { approvalId }, options, () => {
        const proposal = proposals.find((candidate) => candidate.approvalId === approvalId);
        if (!proposal) throw proposalNotFound();
        // The API's approval conflicts (packages/core/src/approvals/handlers.ts).
        if (proposal.status !== "pending") throw demoError("Conflict", { reason: "approval_not_pending" });
        if (!live(proposal)) throw demoError("Conflict", { reason: "approval_expired" });
        if (decision === "approve") apply(proposal);
        proposal.status = decision === "approve" ? "approved" : "rejected";
      });
    },
  };
}
