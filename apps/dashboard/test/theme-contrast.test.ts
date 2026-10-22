import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles/theme.css", import.meta.url), "utf8");

/** The custom properties declared directly inside the first rule that opens with `selector {`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No rule for ${selector}`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const c = parseInt(hex.slice(index, index + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = {
  light: tokens(":root"),
  dark: tokens(':root[data-theme="dark"]'),
  "system dark": tokens(':root[data-theme="system"]'),
};

describe("primary button fills keep their label legible (WCAG 1.4.3)", () => {
  for (const [theme, values] of Object.entries(THEMES)) {
    for (const fill of ["--primary", "--primary-hover", "--primary-active"]) {
      it(`${fill} against --primary-on is at least 4.5:1 in ${theme}`, () => {
        expect(values[fill], fill).toMatch(/^#[0-9a-f]{6}$/i);
        expect(contrast(values[fill]!, values["--primary-on"]!)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("hover and press differ from rest in every theme, and system dark repeats dark", () => {
    for (const values of Object.values(THEMES)) {
      expect(values["--primary-hover"]).not.toBe(values["--primary"]);
      expect(values["--primary-active"]).not.toBe(values["--primary"]);
    }
    for (const fill of ["--primary", "--primary-on", "--primary-hover", "--primary-active"]) {
      expect(THEMES["system dark"][fill], fill).toBe(THEMES.dark[fill]);
    }
  });
});
