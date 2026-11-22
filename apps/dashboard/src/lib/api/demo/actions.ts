/**
 * The demo adapter's action log (backlog B05). A fixed week of receipts: the owner's own work, an
 * agent's reply that ran under an approval, a public booking request and a worker. Reads match the
 * API: newest first, keyset paged by cursor, an unknown ID is a 404. Like the API, a receipt holds
 * no message text, address or token.
 */
import { actionLogEntrySchema, type ActionLogEntry } from "@zs/contracts";
import { ApiError } from "../errors";
import type { ActionLogApi } from "../types";
import { ACTION_PAGE_SIZE } from "../types";
import type { DemoClock } from "./adapter";

const OWNER_MEMBER = "4c2e8a10-6b3d-4f5a-9e71-0d2c4b6a8e01";
const STAFF_MEMBER = "4c2e8a10-6b3d-4f5a-9e71-0d2c4b6a8e02";
export const DEMO_APPROVED_ACTION_ID = "5d3f9b21-7c4e-4a6b-8f82-1e3d5c7b9f01";
const MINUTE = 60_000;
const id = (n: number) => `5d3f9b21-7c4e-4a6b-8f82-1e3d5c7b9f${String(n).padStart(2, "0")}`;
const record = (n: number) => `6e4a0c32-8d5f-4b7c-9a93-2f4e6d8c0a${String(n).padStart(2, "0")}`;

type Seed = Omit<ActionLogEntry, "createdAt"> & { minutesAgo: number };

const SEED: Seed[] = [
  {
    id: DEMO_APPROVED_ACTION_ID, actionType: "inbox.reply.send", actor: { kind: "agent", agent: "inquiry_followup" },
    target: { type: "inbox_reply", id: record(1) }, approval: { id: record(90), status: "approved" }, outcome: "queued", minutesAgo: 12,
  },
  {
    id: id(2), actionType: "approval.approve", actor: { kind: "person", memberId: OWNER_MEMBER, role: "owner" },
    target: { type: "approval", id: record(90) }, approval: null, outcome: "approved", minutesAgo: 13,
  },
  {
    id: id(3), actionType: "booking.public_request", actor: { kind: "system", name: "public_intake" },
    target: { type: "intake_item", id: record(3) }, approval: null, outcome: "done", minutesAgo: 95,
  },
  {
    id: id(4), actionType: "booking.create", actor: { kind: "person", memberId: STAFF_MEMBER, role: "staff" },
    target: { type: "booking", id: record(4) }, approval: null, outcome: "done", minutesAgo: 180,
  },
  {
    id: id(5), actionType: "crm.contact.upsert", actor: { kind: "person", memberId: OWNER_MEMBER, role: "owner" },
    target: { type: "contact", id: record(5) }, approval: null, outcome: "done", minutesAgo: 24 * 60 + 30,
  },
  {
    id: id(6), actionType: "site.publish", actor: { kind: "person", memberId: OWNER_MEMBER, role: "owner" },
    target: { type: "site", id: record(6) }, approval: { id: record(91), status: "approved" }, outcome: "published", minutesAgo: 2 * 24 * 60,
  },
  {
    id: id(7), actionType: "transcription.complete", actor: { kind: "system", name: "transcription" },
    target: { type: "transcription_job", id: record(7) }, approval: null, outcome: "done", minutesAgo: 3 * 24 * 60,
  },
];

export function createDemoActions(options: { clock?: DemoClock; latencyMs?: number } = {}): ActionLogApi {
  const clock = options.clock ?? { now: () => new Date() };
  const latency = options.latencyMs ?? 0;
  const wait = () => (latency > 0 ? new Promise((resolve) => setTimeout(resolve, latency)) : Promise.resolve());
  const entries = (): ActionLogEntry[] => SEED.map(({ minutesAgo, ...entry }) => actionLogEntrySchema.parse({
    ...entry, createdAt: new Date(clock.now().getTime() - minutesAgo * MINUTE).toISOString(),
  }));

  return {
    async listActions(query = {}) {
      await wait();
      const all = entries();
      const limit = query.limit ?? ACTION_PAGE_SIZE;
      const start = query.cursor ? all.findIndex((entry) => entry.id === query.cursor) + 1 : 0;
      const items = all.slice(start, start + limit);
      const more = start + limit < all.length;
      return { items, nextCursor: more ? items.at(-1)!.id : null };
    },
    async getAction(actionId) {
      await wait();
      const found = entries().find((entry) => entry.id === actionId);
      if (!found) throw new ApiError("not_found", "We could not find that action.", 404, "NotFound");
      return found;
    },
  };
}
