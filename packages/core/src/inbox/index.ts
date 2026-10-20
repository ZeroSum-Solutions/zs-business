import {
  approveReplyCommandSchema,
  discardReplyCommandSchema,
  draftReplyCommandSchema,
  replyOutputSchema,
  type ActionCommand,
  type ActionResult,
  type ApproveReplyCommand,
  type DiscardReplyCommand,
  type DraftReplyCommand,
  type ReplyOutput,
} from "@zs/contracts";
import type { ActionHandler } from "../actions/dispatch.js";
import { parseOrFail } from "../crm/rows.js";
import {
  APPROVE_REPLY_ACTION,
  createApproveReplyHandler,
  directReplyApprovals,
  DISCARD_REPLY_ACTION,
  discardReplyHandler,
  DRAFT_REPLY_ACTION,
  draftReplyHandler,
  type ReplyApprovals,
} from "./replies.js";

export {
  APPROVE_REPLY_ACTION,
  directReplyApprovals,
  DISCARD_REPLY_ACTION,
  DRAFT_REPLY_ACTION,
  settleReplyDelivery,
  type ReplyApprovals,
} from "./replies.js";

/** M3c inbox actions (inbox-home.md I-5..I-7), with the approval interface the approve step records through. */
export function createInboxHandlers(approvals: ReplyApprovals): Readonly<Record<string, ActionHandler>> {
  return Object.freeze({
    [DRAFT_REPLY_ACTION]: draftReplyHandler,
    [APPROVE_REPLY_ACTION]: createApproveReplyHandler(approvals),
    [DISCARD_REPLY_ACTION]: discardReplyHandler,
  });
}
export const inboxHandlers = createInboxHandlers(directReplyApprovals);

interface InboxWriteContext {
  readonly dispatch: (command: ActionCommand) => Promise<ActionResult>;
}
// Parse once, dispatch once, validate the envelope: the same shape as the CRM wrappers.
export async function draftReply(command: DraftReplyCommand, ctx: InboxWriteContext): Promise<ReplyOutput> {
  return parseOrFail(replyOutputSchema, await ctx.dispatch(parseOrFail(draftReplyCommandSchema, command)));
}
export async function approveReply(command: ApproveReplyCommand, ctx: InboxWriteContext): Promise<ReplyOutput> {
  return parseOrFail(replyOutputSchema, await ctx.dispatch(parseOrFail(approveReplyCommandSchema, command)));
}
export async function discardReply(command: DiscardReplyCommand, ctx: InboxWriteContext): Promise<ReplyOutput> {
  return parseOrFail(replyOutputSchema, await ctx.dispatch(parseOrFail(discardReplyCommandSchema, command)));
}
