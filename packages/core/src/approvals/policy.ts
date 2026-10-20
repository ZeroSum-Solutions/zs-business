// approvals.md A-9: who may ask for an action, and which actions only run once approved.
import type { Permission } from "@zs/contracts";

export interface ApprovalPolicy {
  /** The permission a member needs to request this action. */
  readonly request: Permission;
  /** When true a member session may not run the action directly; it runs only through A-7. */
  readonly required: boolean;
}

/**
 * Action types with their own request rule. An action without an entry may be requested by
 * any member who holds its ACTION_PERMISSIONS entry and still runs directly as well.
 */
export const APPROVAL_POLICIES: Readonly<Record<string, ApprovalPolicy>> = Object.freeze({
  // inbox-home.md I-6: staff and owners propose sending a reply; it runs only once an owner approves.
  "inbox.reply.send": Object.freeze({ request: "inbox.drafts", required: true }),
});

/** Never proposed through an approval: the approval actions themselves. */
export const isApprovalAction = (actionType: string) => actionType.startsWith("approval.");

/**
 * The policy for one action type, or null when it cannot be requested: it has no
 * ACTION_PERMISSIONS entry (so no member may run it) or it is an approval action.
 */
export function approvalPolicy(
  actionType: string,
  actionPermissions: Readonly<Record<string, Permission>>,
  policies: Readonly<Record<string, ApprovalPolicy>> = APPROVAL_POLICIES,
): ApprovalPolicy | null {
  const own = Object.hasOwn(actionPermissions, actionType) ? actionPermissions[actionType] : undefined;
  if (!own || isApprovalAction(actionType)) return null;
  return Object.hasOwn(policies, actionType) ? policies[actionType]! : { request: own, required: false };
}
