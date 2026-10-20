import {
  discardReplyCommandSchema,
  draftReplyCommandSchema,
  replyOutputSchema,
  type ActionCommand,
  type ActionResult,
  type DiscardReplyCommand,
  type DraftReplyCommand,
  type ReplyOutput,
} from "@zs/contracts";
import type { ActionHandler } from "../actions/dispatch.js";
import { parseOrFail } from "../crm/rows.js";
import {
  DISCARD_REPLY_ACTION,
  discardReplyHandler,
  DRAFT_REPLY_ACTION,
  draftReplyHandler,
  SEND_REPLY_ACTION,
  sendReplyHandler,
} from "./replies.js";

export {
  DISCARD_REPLY_ACTION,
  DRAFT_REPLY_ACTION,
  openSendApproval,
  requireEmail,
  SEND_REPLY_ACTION,
  settleReplyDelivery,
  type SendApproval,
} from "./replies.js";

/** M3c inbox actions (inbox-home.md I-5..I-7). The send runs only under a stored approval (I-6). */
export const inboxHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [DRAFT_REPLY_ACTION]: draftReplyHandler,
  [SEND_REPLY_ACTION]: sendReplyHandler,
  [DISCARD_REPLY_ACTION]: discardReplyHandler,
});

interface InboxWriteContext {
  readonly dispatch: (command: ActionCommand) => Promise<ActionResult>;
}
// Parse once, dispatch once, validate the envelope: the same shape as the CRM wrappers.
export async function draftReply(command: DraftReplyCommand, ctx: InboxWriteContext): Promise<ReplyOutput> {
  return parseOrFail(replyOutputSchema, await ctx.dispatch(parseOrFail(draftReplyCommandSchema, command)));
}
export async function discardReply(command: DiscardReplyCommand, ctx: InboxWriteContext): Promise<ReplyOutput> {
  return parseOrFail(replyOutputSchema, await ctx.dispatch(parseOrFail(discardReplyCommandSchema, command)));
}
