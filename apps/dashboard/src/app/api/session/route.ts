import { sessionForRequest } from "@/lib/server/session";

// Reads the env at request time; answers only with the tenant and user the token names,
// and only to a caller with a valid pilot session cookie.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return sessionForRequest(request);
}
