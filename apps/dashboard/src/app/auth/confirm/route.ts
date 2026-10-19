import { liveSetupFromEnv } from "@/lib/server/live-config";
import { confirmSignIn } from "@/lib/server/sign-in";

// Where the emailed sign-in link lands: trades its one-time token for session cookies.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return confirmSignIn(request, liveSetupFromEnv());
}
