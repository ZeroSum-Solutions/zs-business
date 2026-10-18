import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Halden & Rowe", template: "%s | Halden & Rowe" },
  description: "Run Halden & Rowe Fine Jewelry from your phone: results, inbox, calendar, customers, site and agents.",
  applicationName: "Zero Sum Business",
  appleWebApp: { capable: true, title: "Halden & Rowe", statusBarStyle: "default" },
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8f8f7" },
    { media: "(prefers-color-scheme: dark)", color: "#111214" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-US">
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
