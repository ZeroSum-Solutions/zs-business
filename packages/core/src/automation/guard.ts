// hub-access.md H-3: the one token guard. Every token request that touches the database after
// authentication runs it inside its own tenant transaction: lock the token row, read the clock
// after the lock (a wait on a revoke counts toward expiry), then refuse a missing, revoked or
// expired token with the W-9 401. A revoke takes the exclusive lock, so it waits for requests
// holding a lock and refuses every request that starts after it commits.
import { DatabaseUnavailable, type Transaction } from "@zs/db";
import { readClock } from "../booking/slots.js";
import { Unauthenticated } from "../edge/errors.js";
import { loadToken, tokenActive, type TokenRow } from "./records.js";

export const INVALID_TOKEN = "Invalid or missing automation token";

/**
 * `share` for reads, `whoami` and `get_proposal` (many may run at once); `update` for proposals,
 * which take the exclusive lock directly so two of them never deadlock upgrading a shared lock.
 */
/** Lock timeout, deadlock, serialization failure and cancelled statement: retry later (503), never a 500. */
const TRANSIENT = new Set(["55P03", "40P01", "40001", "57014"]);
const sqlState = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";

export type TokenLock = "share" | "update";

export async function guardToken(
  tx: Transaction,
  clock: { now(): Date },
  tenantId: string,
  tokenId: string,
  lock: TokenLock,
): Promise<{ readonly row: TokenRow; readonly now: Date }> {
  const row = await loadToken(tx, tenantId, tokenId, lock).catch((error: unknown) => {
    throw TRANSIENT.has(sqlState(error)) ? new DatabaseUnavailable("busy", { cause: error }) : error;
  });
  const now = new Date(readClock(clock));
  if (!row || !tokenActive(row, now)) throw new Unauthenticated(INVALID_TOKEN);
  return { row, now };
}
