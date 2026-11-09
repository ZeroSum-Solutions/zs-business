// Owner edge for the outreach sequencer (outreach-sequencer.md OS-1, OS-8, OS-22). Writes go through the shared dispatcher
// as the member; the allowlist travels as dispatch config, never in a stored payload. A tenant outside the allowlist
// gets NotFound before anything else is checked, so the feature does not exist for it.
import {
  activationRequestResultSchema,
  createOutreachCampaignRequestSchema,
  idempotencyKeySchema,
  importOutreachProspectsOutputSchema,
  importOutreachProspectsRequestSchema,
  listOutreachProspectsQuerySchema,
  NotFound,
  OUTREACH_CAMPAIGN_ACTIVATE_ACTION,
  OUTREACH_CAMPAIGN_CREATE_ACTION,
  OUTREACH_CAMPAIGN_PAUSE_ACTION,
  OUTREACH_CAMPAIGN_TARGET,
  OUTREACH_MAILBOX_CONNECT_ACTION,
  OUTREACH_MAILBOX_DISCONNECT_ACTION,
  OUTREACH_MAILBOX_TARGET,
  OUTREACH_PROSPECT_STOP_ACTION,
  OUTREACH_PROSPECT_TARGET,
  OUTREACH_PROSPECTS_IMPORT_ACTION,
  outreachCampaignDetailSchema,
  outreachCampaignListSchema,
  outreachCampaignOutputSchema,
  outreachMailboxListSchema,
  outreachProspectOutputSchema,
  outreachProspectPageSchema,
  requestApprovalRequestSchema,
  approvalOutputSchema,
  uuidSchema,
  type ActivationRequestResult,
  type ImportOutreachProspectsOutput,
  type OutreachCampaignDetail,
  type OutreachCampaignList,
  type OutreachCampaignOutput,
  type OutreachMailboxList,
  type OutreachProspectOutput,
  type OutreachProspectPage,
  type Permission,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { readClock } from "../booking/slots.js";
import { requireMember } from "../members/access.js";
import { outreachAllowed } from "../outreach/config.js";
import { getOutreachCampaign, listOutreachCampaigns, listOutreachMailboxes, listOutreachProspects } from "../outreach/reads.js";
import { campaignMailboxIds, loadCampaign } from "../outreach/records.js";
import { prospectsDigest, unknownVariableProblem } from "../outreach/templates.js";
import { only, toJson } from "./dispatch-util.js";
import { validationError } from "./errors.js";
import { derivedId } from "./ids.js";
import { directDispatch, memberAuthorize, parseInput, type EdgeDependencies, type Principal } from "./session.js";

const PERMISSION: Permission = "outreach";

export function createOutreachSession(deps: EdgeDependencies, principal: Principal) {
  const tenantId = uuidSchema.parse(principal.tenantId);
  const actorId = uuidSchema.parse(principal.actorId);
  const allowed = () => {
    if (!outreachAllowed(deps.outreach, tenantId)) throw new NotFound();
  };
  const run = directDispatch(deps, tenantId, actorId, memberAuthorize(tenantId, actorId), deps.outreach ? { outreach: deps.outreach } : {});
  const envelope = (rawKey: unknown, type: string, targetId: string) => {
    const idempotencyKey = parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key");
    return {
      target: { tenantId, type, id: targetId },
      approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
      idempotencyKey,
    };
  };
  const read = <T>(work: (tx: Transaction) => Promise<T>) => {
    allowed();
    return deps.db.tenant(tenantId, async (tx) => {
      await requireMember(tx, tenantId, actorId, PERMISSION);
      return work(tx);
    });
  };
  const campaignExists = async (tx: Transaction, id: string) => {
    if (!(await loadCampaign(tx, tenantId, id))) throw new NotFound();
  };
  const campaignId = (raw: unknown) => parseInput(uuidSchema, raw, "campaign ID");

  return {
    /** OS-4: the campaign ID derives from the key, so a retry replays the stored answer. */
    async createCampaign(body: unknown, rawKey: unknown): Promise<OutreachCampaignOutput> {
      allowed();
      const request = parseInput(createOutreachCampaignRequestSchema, body);
      const idempotencyKey = parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key");
      // OS-5: name the field that holds the unknown variable.
      const problem = unknownVariableProblem(request.steps);
      if (problem) throw validationError("Invalid request", [{ path: problem.path.split("."), message: problem.code }]);
      const id = derivedId(tenantId, idempotencyKey, OUTREACH_CAMPAIGN_TARGET);
      return parseInput(outreachCampaignOutputSchema, await run({
        actionType: OUTREACH_CAMPAIGN_CREATE_ACTION,
        ...envelope(idempotencyKey, OUTREACH_CAMPAIGN_TARGET, id),
        payload: toJson({ campaignId: id, ...request }),
      }), "result");
    },
    /** OS-7 */
    async importProspects(rawId: unknown, body: unknown, key: unknown): Promise<ImportOutreachProspectsOutput> {
      allowed();
      const id = campaignId(rawId);
      const request = parseInput(importOutreachProspectsRequestSchema, body);
      await read((tx) => campaignExists(tx, id));
      return parseInput(importOutreachProspectsOutputSchema, await run({
        actionType: OUTREACH_PROSPECTS_IMPORT_ACTION, ...envelope(key, OUTREACH_CAMPAIGN_TARGET, id),
        payload: toJson({ campaignId: id, prospects: request.prospects }),
      }), "result");
    },
    /**
     * OS-8: propose activating the campaign as it is now, for an owner to approve at /v1/approvals/:id/approve. The
     * approval binds the content digest, the prospect digest and the count the owner is shown.
     */
    async requestActivation(rawId: unknown, rawKey: unknown): Promise<ActivationRequestResult> {
      allowed();
      const id = campaignId(rawId);
      const idempotencyKey = parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key");
      const view = await read(async (tx) => {
        const campaign = await loadCampaign(tx, tenantId, id);
        if (!campaign) throw new NotFound();
        const open = (await tx.query<{ id: string; status: string }>(
          "SELECT id, status FROM outreach_prospects WHERE tenant_id=$1 AND campaign_id=$2 AND status IN ('pending','active') ORDER BY id",
          [tenantId, id])).rows;
        const subject = (await tx.query<{ subject: string | null }>(
          "SELECT subject FROM outreach_campaign_steps WHERE tenant_id=$1 AND campaign_id=$2 AND step_number=1", [tenantId, id])).rows[0]?.subject ?? "";
        const emails = (await tx.query<{ email: string }>(
          "SELECT m.email FROM outreach_campaign_mailboxes cm JOIN outreach_mailboxes m ON m.tenant_id=cm.tenant_id AND m.id=cm.mailbox_id WHERE cm.tenant_id=$1 AND cm.campaign_id=$2 ORDER BY m.email",
          [tenantId, id])).rows.map((row) => row.email);
        return { campaign, open, subject, emails, mailboxCount: (await campaignMailboxIds(tx, tenantId, id)).length };
      });
      const { campaign, open } = view;
      const window = `${String(Math.floor(campaign.window_start_min / 60)).padStart(2, "0")}:${String(campaign.window_start_min % 60).padStart(2, "0")}-${String(Math.floor(campaign.window_end_min / 60)).padStart(2, "0")}:${String(campaign.window_end_min % 60).padStart(2, "0")}`;
      // The owner approves what the summary says: each field is cut on its own, so a long name or list never hides the count or the subject.
      const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`);
      const senders = view.emails.length <= 3 ? view.emails.join(", ") : `${view.emails.slice(0, 3).join(", ")} and ${view.emails.length - 3} more`;
      const summary = `Start the campaign "${clip(campaign.name, 80)}": ${open.length} prospects from ${clip(senders, 150)}, ${window}, up to ${campaign.daily_cap_per_mailbox} a day per mailbox, subject "${clip(view.subject, 150)}"`;
      // Not the "approval" ID the envelope derives: the actions_tenant_approval index allows one action per approval ID.
      const approvalId = derivedId(tenantId, idempotencyKey, "approval-record");
      const request = requestApprovalRequestSchema.parse({
        action: {
          actionType: OUTREACH_CAMPAIGN_ACTIVATE_ACTION,
          target: { type: OUTREACH_CAMPAIGN_TARGET, id },
          payload: { campaignId: id, contentDigest: campaign.content_digest, prospectsDigest: prospectsDigest(open), prospectCount: open.length },
        },
        summary: summary.length <= 500 ? summary : `${summary.slice(0, 497)}...`,
      });
      const { target: _target, ...rest } = envelope(idempotencyKey, "approval", approvalId);
      await run({
        actionType: "approval.request", target: { tenantId, type: "approval", id: approvalId }, ...rest,
        payload: toJson({ approvalId, ...request }),
      }).then((output) => parseInput(approvalOutputSchema, output, "result"));
      return parseInput(activationRequestResultSchema, { approvalId }, "result");
    },
    /** OS-9 */
    async pauseCampaign(rawId: unknown, key: unknown): Promise<OutreachCampaignOutput> {
      allowed();
      const id = campaignId(rawId);
      await read((tx) => campaignExists(tx, id));
      return parseInput(outreachCampaignOutputSchema, await run({
        actionType: OUTREACH_CAMPAIGN_PAUSE_ACTION, ...envelope(key, OUTREACH_CAMPAIGN_TARGET, id), payload: { campaignId: id },
      }), "result");
    },
    async stopProspect(rawId: unknown, key: unknown): Promise<OutreachProspectOutput> {
      allowed();
      const id = parseInput(uuidSchema, rawId, "prospect ID");
      await read(async (tx) => {
        if ((await tx.query("SELECT 1 FROM outreach_prospects WHERE tenant_id=$1 AND id=$2", [tenantId, id])).rowCount !== 1) throw new NotFound();
      });
      return parseInput(outreachProspectOutputSchema, await run({
        actionType: OUTREACH_PROSPECT_STOP_ACTION, ...envelope(key, OUTREACH_PROSPECT_TARGET, id), payload: { prospectId: id },
      }), "result");
    },
    async listCampaigns(): Promise<OutreachCampaignList> {
      return parseInput(outreachCampaignListSchema, { items: await read((tx) => listOutreachCampaigns(tx, tenantId)) }, "result");
    },
    async getCampaign(rawId: unknown): Promise<OutreachCampaignDetail> {
      allowed();
      const id = campaignId(rawId);
      const now = new Date(readClock(deps.clock));
      const found = await read((tx) => getOutreachCampaign(tx, tenantId, id, now));
      if (!found) throw new NotFound();
      return parseInput(outreachCampaignDetailSchema, found, "result");
    },
    async listProspects(rawId: unknown, rawQuery: unknown): Promise<OutreachProspectPage> {
      allowed();
      const id = campaignId(rawId);
      const query = parseInput(listOutreachProspectsQuerySchema, rawQuery ?? {}, "query");
      const found = await read((tx) => listOutreachProspects(tx, tenantId, id, query));
      if (!found) throw new NotFound();
      return parseInput(outreachProspectPageSchema, found, "result");
    },
    async listMailboxes(): Promise<OutreachMailboxList> {
      const now = new Date(readClock(deps.clock));
      return parseInput(outreachMailboxListSchema, { items: await read((tx) => listOutreachMailboxes(tx, tenantId, now)) }, "result");
    },
  };
}
export type OutreachSession = ReturnType<typeof createOutreachSession>;

/** The principal of the operator command (OS-2): one id per tenant, derived, never a member. */
export const outreachOperatorActorId = (tenantId: string): string => derivedId(tenantId, "outreach", "operator");
/** The mailbox's id: derived from the tenant and the address, so a reconnect finds the same row. */
export const outreachMailboxId = (tenantId: string, address: string): string => derivedId(tenantId, "outreach-mailbox", address.toLowerCase());

/**
 * The operator command's write path (OS-2, OS-3). The principal may run only the two mailbox actions; the allowlist
 * travels as dispatch config. Not reachable from any route: only the operator script on the owner's Mac builds one.
 */
export function createOutreachOperator(deps: EdgeDependencies, rawTenantId: string) {
  const tenantId = uuidSchema.parse(rawTenantId);
  const run = directDispatch(deps, tenantId, outreachOperatorActorId(tenantId),
    only(OUTREACH_MAILBOX_CONNECT_ACTION, OUTREACH_MAILBOX_DISCONNECT_ACTION), deps.outreach ? { outreach: deps.outreach } : {});
  const target = (mailboxId: string) => ({ tenantId, type: OUTREACH_MAILBOX_TARGET, id: mailboxId });
  return {
    tenantId,
    allowed: () => outreachAllowed(deps.outreach, tenantId),
    connectMailbox(input: {
      readonly mailboxId: string; readonly email: string; readonly displayName: string; readonly dailyLimit: number;
      readonly sealedRefreshToken: string; readonly grantedScopes: readonly string[]; readonly idempotencyKey: string;
    }) {
      const { idempotencyKey, ...payload } = input;
      return run({
        actionType: OUTREACH_MAILBOX_CONNECT_ACTION,
        target: target(input.mailboxId),
        // Derived, so a retry of the same command (a lost answer) replays the stored result instead of clashing.
        approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
        idempotencyKey,
        payload: toJson(payload),
      });
    },
    disconnectMailbox(mailboxId: string, idempotencyKey: string) {
      return run({
        actionType: OUTREACH_MAILBOX_DISCONNECT_ACTION,
        target: target(mailboxId),
        approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
        idempotencyKey,
        payload: { mailboxId },
      });
    },
  };
}
export type OutreachOperator = ReturnType<typeof createOutreachOperator>;
