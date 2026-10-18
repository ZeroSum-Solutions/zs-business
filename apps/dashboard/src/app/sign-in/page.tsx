import type { Metadata } from "next";
import { SignInView } from "@/components/shell/sign-in-view";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return <SignInView />;
}
