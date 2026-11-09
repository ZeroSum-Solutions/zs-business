// Outreach actions (outreach-sequencer.md OS-3, OS-4, OS-7, OS-8, OS-9). They run through the shared dispatcher as the
// runtime role. The worker (worker.ts) moves everything after activation under the service role; none of its steps is
// an action. Every handler checks the tenant allowlist again, so an approved run (A-7) cannot reach a tenant the
// edge would have answered 404 for.
import {
  activateOutreachCampaignCommandSchema,
  Conflict,
  connectOutreachMailboxCommandSchema,
  contactEmailInputSchema,
  createOutreachCampaignCommandSchema,
  disconnectOutreachMailboxCommandSchema,
  importOutreachProspectsCommandSchema,
  OUTREACH_CAMPAIGN_ACTIVATE_ACTION,
  OUTREACH_CAMPAIGN_CREATE_ACTION,
  OUTREACH_CAMPAIGN_PAUSE_ACTION,
  OUTREACH_CAMPAIGN_TARGET,
  OUTREACH_DEFAULT_DAILY_CAP,
  OUTREACH_MAILBOX_CONNECT_ACTION,
  OUTREACH_MAILBOX_DISCONNECT_ACTION,
  OUTREACH_MAILBOX_TARGET,
  OUTREACH_MAX_PROSPECTS_PER_CAMPAIGN,
  OUTREACH_PROSPECT_STOP_ACTION,
  OUTREACH_PROSPECT_TARGET,
  OUTREACH_PROSPECTS_IMPORT_ACTION,
  pauseOutreachCampaignCommandSchema,
  stopOutreachProspectCommandSchema,
  TenantDenied,
  ValidationFailed,
  type ImportOutreachProspectsResult,
  type OutreachRowReason,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { clockInstant, parseOrFail, pgCode, pgConstraint, tenantVisible } from "../crm/rows.js";
import { derivedId } from "../edge/ids.js";
import { outreachAllowed, type OutreachAccessInput } from "./config.js";
import { hardSuppressionHit } from "./hard-suppression.js";
import {
  campaignMailboxIds,
  campaignRecord,
  loadCampaign,
  loadProspect,
  prospectRecord,
} from "./records.js";
import { clockMinutes, localMoment } from "./schedule.js";
import {
  addressProblem,
  contentDigest,
  missingVariables,
  prospectsDigest,
  renderTooLong,
  templateProblem,
  unknownVariableProblem,
  type PostalAddress,
} from "./templates.js";

/** OS-1: the allowlist, from the dispatch config; a dispatcher built without it refuses every outreach action. */
function requireAllowed(config: unknown, tenantId: string): void {
  const access = typeof config === "object" && config !== null ? (config as { outreach?: OutreachAccessInput }).outreach : undefined;
  if (!outreachAllowed(access, tenantId)) throw new TenantDenied();
}

const idInUse = () => new Conflict("The ID is already in use", { reason: "id_in_use" });
const refuse = (reason: string) => new Conflict(`Outreach refused: ${reason}`, { reason });

/** The address local parts that name a function, not a person (OS-7). */
const ROLE_LOCAL_PARTS: ReadonlySet<string> = new Set(["postmaster", "abuse", "mailer-daemon", "noreply", "no-reply"]);

async function resolveCampaign(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== OUTREACH_CAMPAIGN_TARGET) throw new ValidationFailed("This action requires an outreach_campaign target");
  return (await tx.query("SELECT 1 FROM outreach_campaigns WHERE tenant_id=$1 AND id=$2", [target.tenantId, target.id])).rowCount === 1
    ? { tenantId: target.tenantId, type: OUTREACH_CAMPAIGN_TARGET, id: target.id } : null;
}
async function resolveProspect(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== OUTREACH_PROSPECT_TARGET) throw new ValidationFailed("This action requires an outreach_prospect target");
  return (await tx.query("SELECT 1 FROM outreach_prospects WHERE tenant_id=$1 AND id=$2", [target.tenantId, target.id])).rowCount === 1
    ? { tenantId: target.tenantId, type: OUTREACH_PROSPECT_TARGET, id: target.id } : null;
}
async function resolveExistingMailbox(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== OUTREACH_MAILBOX_TARGET) throw new ValidationFailed("This action requires an outreach_mailbox target");
  return (await tx.query("SELECT 1 FROM outreach_mailboxes WHERE tenant_id=$1 AND id=$2", [target.tenantId, target.id])).rowCount === 1
    ? { tenantId: target.tenantId, type: OUTREACH_MAILBOX_TARGET, id: target.id } : null;
}

// OS-4

export const createCampaignHandler: ActionHandler = {
  async resolveTarget(tx, target) {
    if (target.type !== OUTREACH_CAMPAIGN_TARGET) throw new ValidationFailed("Campaigns need an outreach_campaign target");
    if (!(await tenantVisible(tx, target.tenantId))) return null;
    if (await loadCampaign(tx, target.tenantId, target.id)) throw idInUse();
    return { tenantId: target.tenantId, type: OUTREACH_CAMPAIGN_TARGET, id: target.id };
  },
  async handle({ tx, command, binding, now, config }) {
    const { payload } = parseOrFail(createOutreachCampaignCommandSchema, command);
    const tenantId = binding.tenantId;
    requireAllowed(config, tenantId);
    // OS-5: any `{{` that is not one of the three variables is refused, with the field named by the edge.
    if (unknownVariableProblem(payload.steps)) throw new ValidationFailed("unknown_variable");
    const mailboxIds = [...new Set(payload.mailboxIds.map((id) => id.toLowerCase()))];
    const found = (await tx.query<{ id: string }>(
      "SELECT id FROM outreach_mailboxes WHERE tenant_id=$1 AND id = ANY($2::uuid[])", [tenantId, mailboxIds])).rows;
    if (found.length !== mailboxIds.length) throw new ValidationFailed("Unknown mailbox");
    const at = clockInstant(now);
    const dailyCap = payload.dailyCapPerMailbox ?? OUTREACH_DEFAULT_DAILY_CAP;
    const digest = contentDigest({ steps: payload.steps, window: payload.window, dailyCapPerMailbox: dailyCap, mailboxIds });
    await tx.query(
      `INSERT INTO outreach_campaigns (tenant_id,id,name,window_start_min,window_end_min,daily_cap_per_mailbox,content_digest,created_by,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [tenantId, payload.campaignId, payload.name, clockMinutes(payload.window.start), clockMinutes(payload.window.end), dailyCap, digest,
        binding.actorId, at]);
    for (const [index, step] of payload.steps.entries()) {
      await tx.query(
        "INSERT INTO outreach_campaign_steps (tenant_id,campaign_id,step_number,delay_business_days,subject,body) VALUES ($1,$2,$3,$4,$5,$6)",
        [tenantId, payload.campaignId, index + 1, step.delayBusinessDays, step.subject ?? null, step.body]);
    }
    for (const mailboxId of mailboxIds) {
      await tx.query("INSERT INTO outreach_campaign_mailboxes (tenant_id,campaign_id,mailbox_id) VALUES ($1,$2,$3)",
        [tenantId, payload.campaignId, mailboxId]);
    }
    const row = (await loadCampaign(tx, tenantId, payload.campaignId))!;
    return {
      result: { ...campaignRecord(row, await campaignMailboxIds(tx, tenantId, payload.campaignId)) },
      event: { type: "outreach.campaign.created", payload: { campaignId: payload.campaignId, steps: payload.steps.length, mailboxes: mailboxIds.length } },
    };
  },
  mapError(error) {
    if (pgCode(error) === "23505" && pgConstraint(error) === "outreach_campaigns_pkey") return idInUse();
    return undefined;
  },
};

// OS-7

interface StepRow { step_number: number; subject: string | null; body: string }
const loadSteps = async (tx: Transaction, tenantId: string, campaignId: string) => (await tx.query<StepRow>(
  "SELECT step_number, subject, body FROM outreach_campaign_steps WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY step_number",
  [tenantId, campaignId])).rows;

export const importProspectsHandler: ActionHandler = {
  resolveTarget: resolveCampaign,
  async handle({ tx, command, binding, now, config }) {
    const { payload } = parseOrFail(importOutreachProspectsCommandSchema, command);
    const tenantId = binding.tenantId;
    requireAllowed(config, tenantId);
    // One import at a time per tenant: the address list is checked against the whole tenant, and the unique key is the backstop.
    await tx.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [`outreach-import:${tenantId}`]);
    const campaign = (await loadCampaign(tx, tenantId, payload.campaignId, true))!;
    if (campaign.status === "active") throw refuse("campaign_active");
    if (campaign.status !== "draft" && campaign.status !== "paused") throw refuse("campaign_not_activatable");
    const steps = await loadSteps(tx, tenantId, campaign.id);
    const mailboxIds = await campaignMailboxIds(tx, tenantId, campaign.id);
    const held = (await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM outreach_prospects WHERE tenant_id=$1 AND campaign_id=$2", [tenantId, campaign.id])).rows[0]!.n;
    const at = clockInstant(now);

    // Normalise every address once; the lookups below take them as lists.
    const emails = payload.prospects.map((row) => {
      const parsed = contactEmailInputSchema.safeParse(row.email);
      return parsed.success ? parsed.data : null;
    });
    const asked = [...new Set(emails.filter((email): email is string => email !== null))];
    const taken = new Set((await tx.query<{ email: string }>(
      "SELECT email FROM outreach_prospects WHERE tenant_id=$1 AND email = ANY($2::text[])", [tenantId, asked])).rows.map((r) => r.email));
    const suppressed = new Set((await tx.query<{ address: string }>(
      "SELECT address FROM suppressions WHERE tenant_id=$1 AND channel='email' AND address = ANY($2::text[])", [tenantId, asked])).rows.map((r) => r.address));
    const denied = new Set((await tx.query<{ email: string }>(
      `SELECT c.normalized_email AS email FROM crm_contacts c
         JOIN crm_contact_consent k ON k.tenant_id=c.tenant_id AND k.contact_id=c.id
        WHERE c.tenant_id=$1 AND k.channel='email' AND k.status='denied' AND c.normalized_email = ANY($2::text[])`,
      [tenantId, asked])).rows.map((r) => r.email));
    // Prospects per campaign mailbox, for the even split (ties by id).
    const load = new Map<string, number>(mailboxIds.map((id) => [id, 0]));
    for (const row of (await tx.query<{ mailbox_id: string; n: number }>(
      "SELECT mailbox_id, count(*)::int AS n FROM outreach_prospects WHERE tenant_id=$1 AND campaign_id=$2 GROUP BY mailbox_id",
      [tenantId, campaign.id])).rows) load.set(row.mailbox_id, row.n);
    const leastLoaded = (): string => [...load.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))[0]![0];

    const rejected: ImportOutreachProspectsResult["rejected"][number][] = [];
    const kept = new Set<string>();
    const rows: Array<{ id: string; email: string; mailboxId: string; status: "pending" | "excluded"; row: (typeof payload.prospects)[number] }> = [];
    for (const [index, row] of payload.prospects.entries()) {
      const email = emails[index]!;
      const reject = (reason: OutreachRowReason) => { rejected.push({ index, reason }); };
      if (email === null) { reject("invalid_email"); continue; }
      const duplicate = taken.has(email) || kept.has(email);
      if (row.excluded === true) {
        if (duplicate) { reject("duplicate"); continue; }
      } else {
        const local = email.slice(0, email.lastIndexOf("@"));
        const values = { firstName: row.firstName.trim(), company: row.company.trim(), industry: row.industry?.trim() ?? null };
        if (ROLE_LOCAL_PARTS.has(local)) { reject("role_address"); continue; }
        if (missingVariables(steps, values).length > 0) { reject("missing_field"); continue; }
        if (renderTooLong(steps, values)) { reject("render_too_long"); continue; }
        if (hardSuppressionHit({ email, website: row.website ?? null, company: values.company,
          name: [values.firstName, row.lastName ?? ""].join(" ").trim() }) !== null) { reject("hard_suppressed"); continue; }
        if (suppressed.has(email)) { reject("suppressed"); continue; }
        if (denied.has(email)) { reject("consent_denied"); continue; }
        if (duplicate) { reject("duplicate"); continue; }
        if (row.mailboxId !== undefined && !load.has(row.mailboxId.toLowerCase())) { reject("mailbox_not_in_campaign"); continue; }
      }
      // An excluded row only reserves the address; a mailbox it names that is not the campaign's is ignored.
      const named = row.mailboxId?.toLowerCase();
      const mailboxId = named !== undefined && load.has(named) ? named : leastLoaded();
      load.set(mailboxId, load.get(mailboxId)! + 1);
      kept.add(email);
      rows.push({ id: derivedId(tenantId, "outreach-prospect", email), email, mailboxId, status: row.excluded === true ? "excluded" : "pending", row });
    }
    // OS-7: the limit counts the rows this call keeps, not the rows it was sent (a refused row holds no place).
    if (held + rows.length > OUTREACH_MAX_PROSPECTS_PER_CAMPAIGN) throw new ValidationFailed("A campaign holds at most 5,000 prospects");
    if (rows.length > 0) {
      await tx.query(
        `INSERT INTO outreach_prospects (tenant_id,id,campaign_id,mailbox_id,email,first_name,last_name,company,industry,website,status,created_at,updated_at)
         SELECT $1, t.id, $2, t.mailbox_id, t.email, t.first_name, t.last_name, t.company, t.industry, t.website, t.status, $3, $3
           FROM unnest($4::uuid[], $5::uuid[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[])
             AS t(id, mailbox_id, email, first_name, last_name, company, industry, website, status)`,
        [tenantId, campaign.id, at,
          rows.map((r) => r.id), rows.map((r) => r.mailboxId), rows.map((r) => r.email),
          rows.map((r) => r.row.firstName.trim()), rows.map((r) => r.row.lastName ?? null),
          rows.map((r) => r.row.company.trim()), rows.map((r) => r.row.industry?.trim() || null),
          rows.map((r) => r.row.website ?? null), rows.map((r) => r.status)]);
    }
    const result: ImportOutreachProspectsResult = {
      imported: rows.filter((r) => r.status === "pending").length,
      excluded: rows.filter((r) => r.status === "excluded").length,
      rejected,
    };
    return {
      result: { ...result, rejected: result.rejected.map((r) => ({ ...r })) },
      event: { type: "outreach.prospects.imported", payload: { campaignId: campaign.id, imported: result.imported, excluded: result.excluded, rejected: rejected.length } },
    };
  },
};

// OS-8

interface ProfileRow { display_name: string; legal_name: string | null; time_zone: string | null; postal_address: PostalAddress | null }

export const activateCampaignHandler: ActionHandler = {
  resolveTarget: resolveCampaign,
  async handle({ tx, command, binding, now, config }) {
    const { payload } = parseOrFail(activateOutreachCampaignCommandSchema, command);
    const tenantId = binding.tenantId;
    requireAllowed(config, tenantId);
    const campaign = (await loadCampaign(tx, tenantId, payload.campaignId, true))!;
    if (campaign.status !== "draft" && campaign.status !== "paused") throw refuse("campaign_not_activatable");
    const open = (await tx.query<{ id: string; status: string }>(
      "SELECT id, status FROM outreach_prospects WHERE tenant_id=$1 AND campaign_id=$2 AND status IN ('pending','active') ORDER BY id",
      [tenantId, campaign.id])).rows;
    if (campaign.content_digest !== payload.contentDigest || prospectsDigest(open) !== payload.prospectsDigest || open.length !== payload.prospectCount)
      throw refuse("campaign_changed");
    if (open.length === 0) throw refuse("no_prospects");
    const unavailable = (await tx.query(
      `SELECT 1 FROM outreach_campaign_mailboxes cm
         LEFT JOIN outreach_mailboxes m ON m.tenant_id=cm.tenant_id AND m.id=cm.mailbox_id
        WHERE cm.tenant_id=$1 AND cm.campaign_id=$2 AND m.status IS DISTINCT FROM 'active'`, [tenantId, campaign.id])).rowCount! > 0;
    if (unavailable) throw refuse("mailbox_unavailable");
    const profile = (await tx.query<ProfileRow>(
      "SELECT display_name, legal_name, time_zone, postal_address FROM business_profiles WHERE tenant_id=$1", [tenantId])).rows[0];
    if (!profile || profile.time_zone === null) throw refuse("time_zone_missing");
    const problem = addressProblem({ displayName: profile.display_name, legalName: profile.legal_name, postalAddress: profile.postal_address });
    if (problem) throw refuse(problem);
    const steps = await loadSteps(tx, tenantId, campaign.id);
    const template = templateProblem(steps);
    if (template) throw refuse(template);

    const at = clockInstant(now);
    const today = localMoment(profile.time_zone, now.getTime()).date;
    await tx.query(
      `UPDATE outreach_campaigns SET status='active', paused_reason=NULL, activation_approval_id=$3, activated_at=$4, updated_at=$4
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, campaign.id, command.approvalReference.id, at]);
    // A first activation starts every pending prospect at step 1 today; a resume leaves the active ones on their schedule.
    await tx.query(
      `UPDATE outreach_prospects SET status='active', next_step=1, next_due_on=$3::date, updated_at=$4
        WHERE tenant_id=$1 AND campaign_id=$2 AND status='pending'`,
      [tenantId, campaign.id, today, at]);
    const row = (await loadCampaign(tx, tenantId, campaign.id))!;
    return {
      result: { ...campaignRecord(row, await campaignMailboxIds(tx, tenantId, campaign.id)) },
      event: { type: "outreach.campaign.activated", payload: { campaignId: campaign.id, prospects: open.length, approvalId: command.approvalReference.id } },
    };
  },
};

// OS-9

export const pauseCampaignHandler: ActionHandler = {
  resolveTarget: resolveCampaign,
  async handle({ tx, command, binding, now, config }) {
    const { payload } = parseOrFail(pauseOutreachCampaignCommandSchema, command);
    const tenantId = binding.tenantId;
    requireAllowed(config, tenantId);
    const campaign = (await loadCampaign(tx, tenantId, payload.campaignId, true))!;
    let row = campaign;
    if (campaign.status === "active") {
      await tx.query("UPDATE outreach_campaigns SET status='paused', paused_reason='owner', updated_at=$3 WHERE tenant_id=$1 AND id=$2",
        [tenantId, campaign.id, clockInstant(now)]);
      row = (await loadCampaign(tx, tenantId, campaign.id))!;
    }
    return {
      result: { ...campaignRecord(row, await campaignMailboxIds(tx, tenantId, campaign.id)) },
      event: { type: "outreach.campaign.paused", payload: { campaignId: campaign.id, changed: row !== campaign } },
    };
  },
};

export const stopProspectHandler: ActionHandler = {
  resolveTarget: resolveProspect,
  async handle({ tx, command, binding, now, config }) {
    const { payload } = parseOrFail(stopOutreachProspectCommandSchema, command);
    const tenantId = binding.tenantId;
    requireAllowed(config, tenantId);
    let row = (await loadProspect(tx, tenantId, payload.prospectId, true))!;
    const open = row.status === "pending" || row.status === "active";
    if (open) {
      const at = clockInstant(now);
      await tx.query(
        "UPDATE outreach_prospects SET status='stopped', next_step=NULL, next_due_on=NULL, stopped_at=$3, updated_at=$3 WHERE tenant_id=$1 AND id=$2",
        [tenantId, row.id, at]);
      row = (await loadProspect(tx, tenantId, row.id))!;
    }
    return {
      result: { ...prospectRecord(row) },
      event: { type: "outreach.prospect.stopped", payload: { prospectId: row.id, campaignId: row.campaign_id, changed: open } },
    };
  },
};

// OS-3: the operator's mailbox actions. The sealed token is in the stored payload, as the calendar's is; it is ciphertext.

export const connectMailboxHandler: ActionHandler = {
  async resolveTarget(tx, target) {
    if (target.type !== OUTREACH_MAILBOX_TARGET) throw new ValidationFailed("Mailboxes need an outreach_mailbox target");
    if (!(await tenantVisible(tx, target.tenantId))) return null;
    return { tenantId: target.tenantId, type: OUTREACH_MAILBOX_TARGET, id: target.id };
  },
  async handle({ tx, command, binding, now, config }) {
    const { payload } = parseOrFail(connectOutreachMailboxCommandSchema, command);
    const tenantId = binding.tenantId;
    requireAllowed(config, tenantId);
    const at = clockInstant(now);
    // A new row starts active; a reconnect replaces the token, sets active and clears any pause (the worker pauses a mailbox
    // "until reconnected" after a history gap, OS-19). `reauthorize` is the worker's word alone. The token is sealed to the
    // mailbox id, so a reconnect that names another id than the stored row would store a token the worker cannot open: refused.
    // The update names the parameters, not EXCLUDED: reading EXCLUDED.sealed_refresh_token would need a SELECT grant the runtime role does not hold.
    const row = (await tx.query<{ id: string; email: string; status: string }>(
      `INSERT INTO outreach_mailboxes (tenant_id,id,email,display_name,status,sealed_refresh_token,granted_scopes,daily_limit,connected_by,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9,$9)
       ON CONFLICT (tenant_id, email) DO UPDATE SET status='active', sealed_refresh_token=$5, display_name=$4, daily_limit=$7,
         paused_until=NULL, pause_reason=NULL, updated_at=$9
         WHERE outreach_mailboxes.id = $2
       RETURNING id, email, status`,
      [tenantId, payload.mailboxId, payload.email, payload.displayName, payload.sealedRefreshToken, payload.grantedScopes,
        payload.dailyLimit, binding.actorId, at])).rows[0];
    if (!row) throw refuse("mailbox_id_mismatch");
    return {
      result: { id: row.id, email: row.email, status: row.status },
      event: { type: "outreach.mailbox.connected", payload: { mailboxId: row.id } },
    };
  },
};

export const disconnectMailboxHandler: ActionHandler = {
  resolveTarget: resolveExistingMailbox,
  async handle({ tx, command, binding, now, config }) {
    const { payload } = parseOrFail(disconnectOutreachMailboxCommandSchema, command);
    const tenantId = binding.tenantId;
    requireAllowed(config, tenantId);
    const row = (await tx.query<{ id: string; email: string; status: string }>(
      `UPDATE outreach_mailboxes SET status='disconnected', sealed_refresh_token=NULL, updated_at=$3
        WHERE tenant_id=$1 AND id=$2 RETURNING id, email, status`, [tenantId, payload.mailboxId, clockInstant(now)])).rows[0]!;
    return {
      result: { id: row.id, email: row.email, status: row.status },
      event: { type: "outreach.mailbox.disconnected", payload: { mailboxId: row.id } },
    };
  },
};

export const outreachHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [OUTREACH_CAMPAIGN_CREATE_ACTION]: createCampaignHandler,
  [OUTREACH_PROSPECTS_IMPORT_ACTION]: importProspectsHandler,
  [OUTREACH_CAMPAIGN_ACTIVATE_ACTION]: activateCampaignHandler,
  [OUTREACH_CAMPAIGN_PAUSE_ACTION]: pauseCampaignHandler,
  [OUTREACH_PROSPECT_STOP_ACTION]: stopProspectHandler,
  [OUTREACH_MAILBOX_CONNECT_ACTION]: connectMailboxHandler,
  [OUTREACH_MAILBOX_DISCONNECT_ACTION]: disconnectMailboxHandler,
});
