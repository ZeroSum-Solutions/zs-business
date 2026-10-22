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

/** The larger of two ratios: a control stands out by its fill or by its edge. */
const standsOut = (values: Record<string, string>, fill: string, edge: string, against: string) =>
  Math.max(contrast(values[fill]!, values[against]!), contrast(values[edge]!, values[against]!));

describe("controls stay visible in every theme", () => {
  for (const [theme, values] of Object.entries(THEMES)) {
    it(`a segmented track shows against the page and a card in ${theme} (U2 V-8)`, () => {
      for (const against of ["--bg", "--surface"]) {
        expect(standsOut(values, "--segment-track", "--segment-edge", against), against).toBeGreaterThanOrEqual(1.2);
      }
    });

    it(`the selected segment is marked 3:1 against its track in ${theme} (U3 A-9)`, () => {
      expect(contrast(values["--segment-ring"]!, values["--segment-track"]!)).toBeGreaterThanOrEqual(3);
      expect(contrast(values["--control-on"]!, values["--segment-track"]!)).toBeGreaterThanOrEqual(1.2);
    });

    it(`an off switch's edge is 3:1 against a card in ${theme} (U3 A-8, WCAG 1.4.11)`, () => {
      expect(contrast(values["--border-strong"]!, values["--surface"]!)).toBeGreaterThanOrEqual(3);
    });

    it(`loading skeletons show on the page, a tray and a card in ${theme} (U2 V-5)`, () => {
      for (const against of ["--bg", "--tray", "--surface"]) {
        expect(contrast(values["--skeleton"]!, values[against]!), against).toBeGreaterThanOrEqual(theme === "light" && against === "--tray" ? 1.05 : 1.2);
      }
    });

    it(`a destructive button is a solid red with a light label in ${theme} (U2 V-19)`, () => {
      expect(contrast(values["--danger-solid"]!, values["--danger-on"]!)).toBeGreaterThanOrEqual(4.5);
      expect(luminance(values["--danger-on"]!)).toBeGreaterThan(luminance(values["--danger-solid"]!));
    });
  }

  it("system dark repeats dark for the control tokens", () => {
    for (const token of ["--segment-track", "--segment-edge", "--segment-ring", "--control-on", "--skeleton", "--danger-solid", "--danger-on"]) {
      expect(THEMES["system dark"][token], token).toBe(THEMES.dark[token]);
    }
  });
});
