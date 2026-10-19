// Keyset page positions. A cursor holds the sort key of the last row a page returned, so the
// next page starts right after that row however many rows were added or moved ahead of it;
// an offset shifts by that many and repeats or skips rows.
import { validationError } from "../edge/errors.js";

/** Which list and order a cursor belongs to; a cursor from another one is refused. */
export type CursorKind = "contacts.recent" | "contacts.name" | "deals.recent" | "bookings.start";

/** The last row's sort value (microseconds since the epoch, or a name key) and its ID. */
export type CursorKey = readonly [value: string, id: string];

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MICROS = /^-?[0-9]{1,18}$/;

export function encodeCursor(kind: CursorKind, key: CursorKey): string {
  return Buffer.from(JSON.stringify([kind, ...key]), "utf8").toString("base64url");
}

const invalid = (path: string, message: string) => validationError("Invalid query", [{ path: [path], message }]);

/** The position a query's cursor names, or null when it has none. */
export function decodeCursor(kind: CursorKind, query: { cursor?: string | undefined; offset: number }): CursorKey | null {
  if (query.cursor === undefined) return null;
  if (query.offset !== 0) throw invalid("offset", "Use cursor or offset, not both");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid("cursor", "Not a cursor for this list");
  }
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== kind) throw invalid("cursor", "Not a cursor for this list");
  const [, sortValue, id] = value as unknown[];
  const valid = typeof sortValue === "string" && typeof id === "string" && ID.test(id) &&
    (kind === "contacts.name" ? sortValue.length <= 1000 && !sortValue.includes("\0") : MICROS.test(sortValue));
  if (!valid) throw invalid("cursor", "Not a cursor for this list");
  return [sortValue as string, id as string];
}

/** SQL for a cursor's microsecond value as a timestamptz, exact to the microsecond. */
export const microsToTimestamp = (param: string) => `('epoch'::timestamptz + ${param}::bigint * interval '1 microsecond')`;

/** SQL for a timestamptz column as microseconds since the epoch, as text. */
export const timestampToMicros = (column: string) => `((extract(epoch FROM ${column}) * 1000000)::numeric(30,0))::text`;
