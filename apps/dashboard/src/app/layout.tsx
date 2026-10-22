import type { Metadata, Viewport } from "next";
import { Manrope } from "next/font/google";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { THEME_SCRIPT } from "@/lib/theme-script";
import { Providers } from "./providers";
import "./globals.css";

// Self-hosted at build time (no runtime request to Google). The service worker does not cache
// fonts, so a cold offline open falls back to the system font.
// Manrope (SIL OFL 1.1), Direction A's one typeface.
const manrope = Manrope({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-manrope",
  weight: ["400", "500", "600", "700", "800"],
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"],
});

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
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#ffffff" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The theme script may set data-theme before React hydrates, hence the suppressed warning.
    <html lang="en-US" className={manrope.variable} data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
