import { liveSetupFromEnv } from "@/lib/server/live-config";
import { sessionForRequest } from "@/lib/server/session";

// Reads the env at request time; answers only with the business and person the API names
// for this browser's own session.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return sessionForRequest(request, liveSetupFromEnv());
}
