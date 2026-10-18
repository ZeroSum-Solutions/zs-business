// Renders the PWA icons to public/icons with headless Chromium. Run: node scripts/make-icons.mjs
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const OUT = new URL("../public/icons/", import.meta.url);
const ICONS = [
  { file: "icon-192.png", size: 192, inset: 0, radius: 0.22 },
  { file: "icon-512.png", size: 512, inset: 0, radius: 0.22 },
  { file: "icon-maskable-512.png", size: 512, inset: 0, radius: 0, scale: 0.72 },
  { file: "apple-touch-icon.png", size: 180, inset: 0, radius: 0 },
];

const html = ({ size, radius, scale = 0.82 }) => `<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:${size}px;height:${size}px;border-radius:${radius * size}px;background:#16171a;display:flex;align-items:center;justify-content:center">
  <span style="font:600 ${Math.round(size * 0.3 * scale)}px/1 system-ui,-apple-system,sans-serif;letter-spacing:-0.02em;color:#f8f8f7">H&amp;R</span>
</div></body></html>`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const icon of ICONS) {
  await page.setViewportSize({ width: icon.size, height: icon.size });
  await page.setContent(html(icon));
  await page.screenshot({ path: new URL(icon.file, OUT).pathname, omitBackground: icon.radius > 0 });
}
await browser.close();
console.log(`Wrote ${ICONS.length} icons`);
