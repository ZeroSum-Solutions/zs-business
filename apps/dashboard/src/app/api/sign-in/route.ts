import { proxyConfigFromEnv } from "@/lib/server/api-proxy";
import { AttemptLimiter } from "@/lib/server/pilot-gate";
import { signIn } from "@/lib/server/sign-in";

// Reads DASHBOARD_ACCESS_CODE and DASHBOARD_SESSION_SECRET at request time; never inlined.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// One limiter per server process: enough for the pilot's single server.
const limiter = new AttemptLimiter();

export function POST(request: Request) {
  // Demo mode (no API configured) has no gate.
  return signIn(request, proxyConfigFromEnv()?.gate ?? null, limiter);
}
