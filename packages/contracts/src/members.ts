import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema } from "./index.js";
import { contactEmailInputSchema } from "./crm.js";

// Root re-exports this module; defer access to the shared schema until parsing.
const idSchema = z.lazy(() => uuidSchema);
const instantSchema = z.iso.datetime({ precision: 3 });

/** M2a auth model: a person's role in one tenant. */
export const memberRoleSchema = z.enum(["owner", "staff"]);
export type MemberRole = z.infer<typeof memberRoleSchema>;

/**
 * What a role may do. Owners may do everything, including members, billing, plan,
 * publishing, website-request review, deciding approvals (approvals.md A-13) and the Home
 * results (inbox-home.md H-5), integrations (activepieces.md W-1) and the follow-up agent's
 * settings (agents.md G-2) and the business profile (business-profile.md BP-6); staff work the calendar, customers and inbox drafts.
 * Only owners invite, remove or change roles. Routes and actions name the permission they need.
 */
export const permissionSchema = z.enum([
  "calendar", "customers", "inbox.drafts", "members", "billing", "plan", "publish", "intake", "approve", "reports", "integrations",
  "agents", "business",
]);
export type Permission = z.infer<typeof permissionSchema>;
export const ROLE_PERMISSIONS: Readonly<Record<MemberRole, readonly Permission[]>> = Object.freeze({
  owner: Object.freeze([...permissionSchema.options]),
  staff: Object.freeze(["calendar", "customers", "inbox.drafts"] as const),
});
export function roleCan(role: MemberRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Lowercased, trimmed ASCII address, as contacts use. */
export const memberEmailSchema = z.lazy(() => contactEmailInputSchema);

export const inviteMemberInputSchema = z.strictObject({
  memberId: idSchema,
  email: memberEmailSchema,
  role: memberRoleSchema,
});
export const inviteMemberCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("member.invite"),
  target: targetSchema.extend({ type: z.literal("member") }),
  payload: inviteMemberInputSchema,
}).refine((command) => command.target.id === command.payload.memberId, "Target must equal the pre-minted member ID"));
export type InviteMemberCommand = z.infer<typeof inviteMemberCommandSchema>;

export const changeMemberRoleInputSchema = z.strictObject({ memberId: idSchema, role: memberRoleSchema });
export const changeMemberRoleCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("member.change-role"),
  target: targetSchema.extend({ type: z.literal("member") }),
  payload: changeMemberRoleInputSchema,
}).refine((command) => command.target.id === command.payload.memberId, "Target must equal the member ID"));
export type ChangeMemberRoleCommand = z.infer<typeof changeMemberRoleCommandSchema>;

export const removeMemberInputSchema = z.strictObject({ memberId: idSchema });
export const removeMemberCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("member.remove"),
  target: targetSchema.extend({ type: z.literal("member") }),
  payload: removeMemberInputSchema,
}).refine((command) => command.target.id === command.payload.memberId, "Target must equal the member ID"));
export type RemoveMemberCommand = z.infer<typeof removeMemberCommandSchema>;

/** `invited` until the invite worker binds the person's account (`userId`). */
export const memberRecordSchema = z.strictObject({
  id: idSchema,
  tenantId: idSchema,
  email: z.string(),
  userId: idSchema.nullable(),
  role: memberRoleSchema,
  status: z.enum(["invited", "active"]),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type MemberRecord = z.infer<typeof memberRecordSchema>;
export const memberOutputSchema = z.lazy(() => actionResultSchema.extend({ result: memberRecordSchema }));
export type MemberOutput = z.infer<typeof memberOutputSchema>;
export const removeMemberOutputSchema = z.lazy(() => actionResultSchema.extend({
  result: z.strictObject({ id: idSchema, removed: z.literal(true) }),
}));
export type RemoveMemberOutput = z.infer<typeof removeMemberOutputSchema>;

/** HTTP and MCP bodies; the edge mints memberId from the idempotency key. */
export const inviteMemberRequestSchema = z.strictObject({ email: memberEmailSchema, role: memberRoleSchema });
export type InviteMemberRequest = z.input<typeof inviteMemberRequestSchema>;
export const changeMemberRoleRequestSchema = z.strictObject({ role: memberRoleSchema });
export type ChangeMemberRoleRequest = z.infer<typeof changeMemberRoleRequestSchema>;
export const memberListSchema = z.strictObject({ items: z.array(memberRecordSchema) });
export type MemberList = z.infer<typeof memberListSchema>;

/**
 * GET /v1/me: who the token belongs to in its tenant, and what they may do. With
 * `?include=profile` it adds `businessName` (the tenant's name) and `email` (the membership's
 * own address), so screens name the right business and person; members have no display name
 * yet. Without it the answer keeps its original five keys, which a dashboard built before the
 * profile fields reads strictly, so the API can deploy first.
 */
export const meResponseSchema = z.strictObject({
  tenantId: idSchema,
  userId: idSchema,
  memberId: idSchema,
  role: memberRoleSchema,
  permissions: z.array(permissionSchema),
  businessName: z.string().optional(),
  email: z.string().optional(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;
/**
 * How a client reads /v1/me: the membership must be there, but an older API may leave out the
 * profile fields, a newer one may add keys (dropped here) or permissions, so neither order of
 * a rolling deploy locks anyone out. The API answers with `meResponseSchema`.
 */
export const meReadSchema = z.object({
  tenantId: idSchema,
  userId: idSchema,
  memberId: idSchema,
  role: memberRoleSchema,
  permissions: z.array(z.string()),
  businessName: z.string().optional(),
  email: z.string().optional(),
});
export type MeRead = z.infer<typeof meReadSchema>;
