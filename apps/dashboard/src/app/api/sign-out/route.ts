import { withHostingModeGuard } from "@/lib/server/hosting-mode";
import { liveSetupFromEnv } from "@/lib/server/live-config";
import { signOut } from "@/lib/server/sign-in";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withHostingModeGuard((request: Request) => signOut(request, liveSetupFromEnv()));
