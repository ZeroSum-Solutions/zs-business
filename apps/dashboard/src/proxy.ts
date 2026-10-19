import { NextResponse } from "next/server";
import { hostingModeGuard } from "@/lib/server/hosting-mode";

// Runs on the server before every page and /api route. NEXT_PUBLIC_API_MODE is the value
// baked into this build; ZS_API_URL is read at request time.
export function proxy(): Response {
  return hostingModeGuard(process.env.NEXT_PUBLIC_API_MODE, process.env) ?? NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
