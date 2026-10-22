import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { PRODUCT_NAME } from "@/lib/product";
import { THEME_SCRIPT } from "@/lib/theme-script";
import { Providers } from "./providers";
import "./globals.css";

// Manrope (SIL OFL 1.1, fonts/Manrope-OFL.txt), Direction A's one typeface: the latin variable
// file from @fontsource-variable/manrope 5.3.0, kept in the repo so a build never fetches from
// Google (a failed fetch broke a CI build on 2026-10-22). The service worker does not cache
// fonts, so a cold offline open falls back to the system font.
const manrope = localFont({
  src: "./fonts/manrope-latin-wght-normal.woff2",
  display: "swap",
  variable: "--font-manrope",
  weight: "200 800",
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"],
});

// Static metadata is the same for every business, so it names the product, not a tenant.
export const metadata: Metadata = {
  title: { default: PRODUCT_NAME, template: `%s | ${PRODUCT_NAME}` },
  description: "Run your business from your phone: results, inbox, calendar, customers, site and agents.",
  applicationName: PRODUCT_NAME,
  appleWebApp: { capable: true, title: PRODUCT_NAME, statusBarStyle: "default" },
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
