import { NextResponse } from "next/server";
import { hostingModeGuard } from "@/lib/server/hosting-mode";

// Runs on the server before every page. NEXT_PUBLIC_API_MODE is the value baked into this
// build; ZS_API_URL is read at request time. Not before /api routes: with a proxy in front,
// Next reads the whole request body (up to 10 MB) before the route starts, so /api/sign-in and
// the /api/v1 proxy could not refuse an oversize body while it is still arriving. Those
// routes run the same guard themselves (withHostingModeGuard).
export function proxy(): Response {
  return hostingModeGuard(process.env.NEXT_PUBLIC_API_MODE, process.env) ?? NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|api/).*)"] };
