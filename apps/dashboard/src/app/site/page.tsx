import type { Metadata } from "next";
import { SiteView } from "@/components/site/site-view";

export const metadata: Metadata = { title: "Site" };

export default function SitePage() {
  return <SiteView />;
}
