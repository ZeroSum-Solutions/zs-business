/**
 * The demo adapter's company details (enrichment.md E-4, E-6, E-14, E-17). It keeps the rules the API
 * enforces that a screen can show: only an owner asks, a customer needs a company web domain (a
 * free-mail address has none), and a refused request names its reason. No company is ever looked up:
 * a request ends as "no match", so a visitor sees the whole flow and nothing is invented. The data is
 * in memory and starts again on every page load.
 */
import type { ContactEnrichment, EnrichmentRequestRecord } from "@zs/contracts";
import { contactNotFound, demoError } from "../errors";
import type { EnrichmentApi, WriteOptions } from "../types";
import type { DemoActor } from "./agents";

export interface DemoEnrichmentContext {
  now(): Date;
  newId(): string;
  wait(): Promise<void>;
  idempotent<T>(operation: string, payload: unknown, options: WriteOptions, run: () => T): Promise<T>;
  actor(): DemoActor;
  hasContact(id: string): boolean;
  /** The part of the customer's email after the @, or null without one. */
  contactDomain(id: string): string | null;
}

/** Addresses at these hosts say nothing about a company (E-4). */
const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com", "proton.me", "protonmail.com"]);
/** The EU, EEA and UK top-level domains the demo knows to refuse (E-7); the API holds the full list. */
const REFUSED_TLDS = new Set(["de", "fr", "nl", "es", "it", "ie", "uk", "se", "dk", "fi", "pl", "pt", "at", "be", "no", "eu"]);

const clone = <T>(value: T): T => structuredClone(value);

export function createDemoEnrichment(ctx: DemoEnrichmentContext): EnrichmentApi {
  const requests = new Map<string, EnrichmentRequestRecord[]>();

  return {
    async getContactEnrichment(contactId) {
      await ctx.wait();
      if (!ctx.hasContact(contactId)) throw contactNotFound();
      const answer: ContactEnrichment = { profile: null, requests: clone(requests.get(contactId) ?? []), results: [] };
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
        const at = ctx.now().toISOString();
        const record: EnrichmentRequestRecord = {
          id: ctx.newId(), contactId, op: "company.enrich", status: "no_match", reason: null, domain, priceCents: 5,
          createdAt: at, updatedAt: at,
        };
        requests.set(contactId, [record, ...(requests.get(contactId) ?? [])]);
        return record;
      });
    },
  };
}
