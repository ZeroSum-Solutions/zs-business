import { readSession, sessionResponse } from "@/lib/server/session";

// Reads ZS_API_TOKEN at request time and returns only the tenant and user it names.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return sessionResponse(readSession(process.env.ZS_API_TOKEN));
}
