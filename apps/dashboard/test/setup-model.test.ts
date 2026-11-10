// The setup screen's pure parts (industry-templates.md IT-7, IT-8, IT-10): opening hours in words,
// the zone the confirm starts with, the stage a new deal goes into, and the connections order.
import { INDUSTRY_TEMPLATES, industryTemplatePreview, type PipelineSummary } from "@zs/contracts";
import { describe, expect, it } from "vitest";
import { orderConnections } from "../src/lib/recommended-connections";
import { calendarConnected, dealTarget, durationLabel, hoursLines, initialZone } from "../src/lib/setup";

const pipeline = (id: string, outcomes: ("open" | "won" | "lost")[]): PipelineSummary => ({
  id, name: id, stages: outcomes.map((outcome, index) => ({ id: `${id}-s${index + 1}`, name: `Stage ${index + 1}`, position: index + 1, outcome })), archivedStages: [],
});

describe("hoursLines", () => {
  it("groups weekdays with the same hours", () => {
    expect(hoursLines(industryTemplatePreview(INDUSTRY_TEMPLATES.jewelry).resource.weekly)).toEqual(["Mon–Fri 9:00 AM–5:00 PM", "Sat 10:00 AM–4:00 PM"]);
    expect(hoursLines(industryTemplatePreview(INDUSTRY_TEMPLATES.agency).resource.weekly)).toEqual(["Mon–Fri 9:00 AM–5:00 PM"]);
    expect(hoursLines(industryTemplatePreview(INDUSTRY_TEMPLATES.fitness).resource.weekly)).toEqual(["Mon–Fri 6:00 AM–8:00 PM", "Sat 8:00 AM–2:00 PM"]);
  });

  it("names a single day and a gap", () => {
    const at = (weekday: number) => ({ weekday, windows: [{ startMinute: 540, endMinute: 1020 }] });
    expect(hoursLines([at(1), at(3), at(4)])).toEqual(["Mon 9:00 AM–5:00 PM", "Wed–Thu 9:00 AM–5:00 PM"]);
  });
});

describe("initialZone", () => {
  it("takes the profile's zone, else the browser's", () => {
    expect(initialZone("Europe/London", "America/Chicago")).toBe("Europe/London");
    expect(initialZone(null, "America/Chicago")).toBe("America/Chicago");
  });
});

describe("dealTarget", () => {
  it("takes the applied template's pipeline and its first stage that is neither won nor lost", () => {
    const pipelines = [pipeline("seed", ["open", "won"]), pipeline("tpl", ["won", "open", "open", "lost"])];
    expect(dealTarget(pipelines, "tpl")).toEqual({ pipelineId: "tpl", stageId: "tpl-s2" });
  });

  it("falls back to the first pipeline only when setup says no template was applied", () => {
    const pipelines = [pipeline("seed", ["open", "won"])];
    expect(dealTarget(pipelines, null)).toEqual({ pipelineId: "seed", stageId: "seed-s1" });
  });

  it("never stands another pipeline in for an applied one that is gone", () => {
    expect(dealTarget([pipeline("seed", ["open", "won"])], "gone")).toEqual({ problem: "no_pipeline" });
  });

  it("tells no pipeline from no open stage", () => {
    expect(dealTarget([], null)).toEqual({ problem: "no_pipeline" });
    expect(dealTarget([pipeline("closed", ["won", "lost"])], "closed")).toEqual({ problem: "no_open_stage" });
  });
});

describe("orderConnections", () => {
  it("puts the recommended ones first, in template order, and leaves out what is not offered", () => {
    expect(orderConnections(["google_calendar"], ["shopify", "google_calendar"])).toEqual([{ id: "google_calendar", recommended: true }]);
    expect(orderConnections(["google_calendar", "shopify", "stripe"], ["shopify", "google_calendar"])).toEqual([
      { id: "shopify", recommended: true }, { id: "google_calendar", recommended: true }, { id: "stripe", recommended: false },
    ]);
  });

  it("keeps the offered order without recommendations", () => {
    expect(orderConnections(["google_calendar", "shopify"], [])).toEqual([{ id: "google_calendar", recommended: false }, { id: "shopify", recommended: false }]);
  });
});

describe("durationLabel and calendarConnected", () => {
  it("says durations in the largest whole unit", () => {
    expect(durationLabel(45)).toBe("45 minutes");
    expect(durationLabel(720)).toBe("12 hours");
    expect(durationLabel(60)).toBe("1 hour");
    expect(durationLabel(86_400)).toBe("60 days");
  });

  it("counts only an active connection of the template's calendar; a reconnect-needed one does not count", () => {
    expect(calendarConnected([{ resourceId: "r", status: "active" }], "r")).toBe(true);
    expect(calendarConnected([{ resourceId: "r", status: "reauthorize" }], "r")).toBe(false);
    expect(calendarConnected([{ resourceId: "r", status: "disconnected" }, { resourceId: "x", status: "active" }], "r")).toBe(false);
  });
});
