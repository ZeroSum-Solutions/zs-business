import { signOut } from "@/lib/server/sign-in";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return signOut(request);
}
