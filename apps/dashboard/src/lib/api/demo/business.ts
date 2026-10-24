/**
 * The demo adapter's business profile (business-profile.md BP-5..BP-7, BP-11). It keeps the rules
 * the API enforces: any member reads it, only an owner saves, a save names the revision it started
 * from, a stale one is `stale_revision`, and field errors name their path. The data is in memory
 * and starts again on every page load, so nothing a visitor types here is ever stored.
 */
import type { z } from "zod";
import { updateBusinessProfileRequestSchema, type BusinessProfile, type BusinessProfileChanges } from "@zs/contracts";
import { demoError } from "../errors";
import type { BusinessApi, WriteOptions } from "../types";
import { DEMO_BUSINESS } from "./seed";
import type { DemoActor } from "./agents";

export interface DemoBusinessControls {
  /** Another owner saves the profile first, so this screen's save is `stale_revision`. */
  editBusinessElsewhere(changes?: BusinessProfileChanges): BusinessProfile;
}

export interface DemoBusinessContext {
  now(): Date;
  wait(): Promise<void>;
  idempotent<T>(operation: string, payload: unknown, options: WriteOptions, run: () => T): Promise<T>;
  parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T>;
  actor(): DemoActor;
}

const clone = <T>(value: T): T => structuredClone(value);

export function createDemoBusiness(ctx: DemoBusinessContext): BusinessApi & DemoBusinessControls {
  let profile: BusinessProfile = {
    displayName: DEMO_BUSINESS, legalName: null, phoneE164: null, timeZone: null, currency: "USD",
    postalAddress: null, revision: 1, updatedAt: ctx.now().toISOString(),
  };

  /** A key set to null clears it; an absent key stays as it was. */
  function apply(changes: BusinessProfileChanges): void {
    const next: BusinessProfile = { ...profile, revision: profile.revision + 1, updatedAt: ctx.now().toISOString() };
    if (changes.displayName !== undefined) next.displayName = changes.displayName;
    if (changes.legalName !== undefined) next.legalName = changes.legalName;
    if (changes.phoneE164 !== undefined) next.phoneE164 = changes.phoneE164;
    if (changes.timeZone !== undefined) next.timeZone = changes.timeZone;
    if (changes.currency !== undefined) next.currency = changes.currency;
    if (changes.postalAddress !== undefined) next.postalAddress = changes.postalAddress;
    profile = next;
  }

  return {
    async getBusiness() {
      await ctx.wait();
      return clone(profile);
    },

    async updateBusiness(input, options) {
      // The `business` permission is the owner's alone, and it is checked before any replay: a key an
      // owner used earlier answers a staff member with 403, as the API does.
      if (ctx.actor().role !== "owner") {
        await ctx.wait();
        throw demoError("Forbidden");
      }
      return ctx.idempotent("business.profile.update", input, options, () => {
        const request = ctx.parse(updateBusinessProfileRequestSchema, input);
        if (request.expectedRevision !== profile.revision) {
          throw demoError("Conflict", { reason: "stale_revision", currentRevision: profile.revision });
        }
        apply(request.changes);
        return clone(profile);
      });
    },

    editBusinessElsewhere(changes = { legalName: `${profile.displayName} Ltd` }) {
      apply(changes);
      return clone(profile);
    },
  };
}
