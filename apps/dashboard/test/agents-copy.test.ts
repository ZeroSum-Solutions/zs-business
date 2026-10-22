// The Agents page's plain words and settings form (agents.md G-3..G-11), and how the Inbox
// names the follow-up agent as a draft's author.
import { describe, expect, it } from "vitest";
import { DEFAULT_FOLLOW_UP_SETTINGS, followUpSkipReasonSchema, followUpStopReasonSchema, type FollowUpStatus } from "@zs/contracts";
import {
  agentState,
  blockedSentence,
  minuteLabel,
  quietHoursLabel,
  readSettingsForm,
  SKIP_REASONS,
  STOP_REASONS,
  timeToMinute,
  timeZoneChoices,
  toSettingsForm,
} from "../src/lib/agents";
import { runCounts } from "../src/components/agents/agents-view";
import { actorName, AGENT_AUTHOR } from "../src/components/inbox/inbox-view";

const AGENT = "703cddeb-3f35-8dec-8397-426f06fb05ee";
const status = (patch: Partial<FollowUpStatus> = {}): FollowUpStatus => ({
  settings: { ...DEFAULT_FOLLOW_UP_SETTINGS, enabled: true, timeZone: "America/New_York" },
  revision: 1, updatedAt: null, killed: null, globalKilled: false, canDraft: true, blockedBy: null, ...patch,
});

describe("agent copy", () => {
  it("has words for every stop and skip reason the contract names", () => {
    for (const reason of followUpStopReasonSchema.options) expect(STOP_REASONS[reason]).toMatch(/\w/);
    for (const reason of followUpSkipReasonSchema.options) expect(SKIP_REASONS[reason]).toMatch(/\w/);
  });

  it("states on, off, stopped and paused by support, in that precedence", () => {
    expect(agentState(status())).toEqual({ label: "On", tone: "success" });
    expect(agentState(status({ canDraft: false, blockedBy: "quiet_hours" })).label).toBe("On, waiting");
    expect(agentState(status({ settings: { ...status().settings, enabled: false }, canDraft: false, blockedBy: "disabled" })).label).toBe("Off");
    const killed = { at: "2026-10-20T12:00:00.000Z", by: AGENT, note: null };
    expect(agentState(status({ killed, canDraft: false, blockedBy: "tenant_killed" })).label).toBe("Stopped");
    expect(agentState(status({ killed, globalKilled: true, canDraft: false, blockedBy: "global_killed" })).label).toBe("Paused by support");
  });

  it("says why it cannot draft now, with quiet hours in the agent's zone", () => {
    expect(blockedSentence(status())).toBeNull();
    expect(blockedSentence(status({ canDraft: false, blockedBy: "quiet_hours" }))).toBe("It is quiet hours (9:00 PM to 8:00 AM, Eastern Time (New York)). It drafts again when they end.");
    expect(blockedSentence(status({ canDraft: false, blockedBy: "daily_cap" }))).toMatch(/^It drafted 10 follow-ups in the last 24 hours/);
    expect(quietHoursLabel({ quietStartMinute: 600, quietEndMinute: 600, timeZone: "UTC" })).toBe("No quiet hours");
    expect([0, 59, 720, 1439].map(minuteLabel)).toEqual(["12:00 AM", "12:59 AM", "12:00 PM", "11:59 PM"]);
  });

  it("counts a run in words", () => {
    expect(runCounts({ considered: 0, drafted: 0, skipped: 0 })).toBe("Nothing to follow up.");
    expect(runCounts({ considered: 3, drafted: 1, skipped: 2 })).toBe("Drafted 1 follow-up, skipped 2.");
    expect(runCounts({ considered: 2, drafted: 2, skipped: 0 })).toBe("Drafted 2 follow-ups, skipped 0.");
  });
});

describe("agent settings form", () => {
  it("round-trips the settings through the form", () => {
    const settings = { ...DEFAULT_FOLLOW_UP_SETTINGS, quietStartMinute: 1290, timeZone: "Europe/Berlin" };
    const form = toSettingsForm(settings);
    expect(form).toMatchObject({ quietStart: "21:30", quietEnd: "08:00", maxDraftsPerDay: "10" });
    expect(readSettingsForm(form)).toEqual({ ok: true, settings });
  });

  it("names every field out of the contract's bounds, and an empty or partial time", () => {
    const form = {
      ...toSettingsForm(DEFAULT_FOLLOW_UP_SETTINGS),
      maxDraftsPerDay: "0", maxDraftsPerContact: "11", contactWindowHours: "1.5", waitHours: "", lookbackDays: "91", quietStart: "", quietEnd: "25:00", timeZone: "Mars/Base",
    };
    const read = readSettingsForm(form);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.fields.sort()).toEqual(
      ["contactWindowHours", "lookbackDays", "maxDraftsPerContact", "maxDraftsPerDay", "quietEnd", "quietStart", "timeZone", "waitHours"]);
    expect([timeToMinute("00:00"), timeToMinute("23:59"), timeToMinute("9:00")]).toEqual([0, 1439, Number.NaN]);
  });

  it("offers UTC and Area/City zones, keeping the current one", () => {
    const zones = timeZoneChoices("America/New_York");
    expect(zones[0]).toBe("UTC");
    expect(zones).toContain("America/New_York");
    expect(zones.every((zone) => zone === "UTC" || zone.includes("/"))).toBe(true);
  });
});

describe("inbox: who drafted a reply", () => {
  it("names a member by email, the agent by its actor ID, and anyone else as a former member", () => {
    expect(actorName({ userId: AGENT, email: "mara@haldenrowe.example" }, AGENT)).toBe("mara@haldenrowe.example");
    expect(actorName({ userId: AGENT, email: null }, AGENT)).toBe(AGENT_AUTHOR);
    expect(actorName({ userId: "9a1b3c5d-7e9f-4a1b-8c2d-000000000009", email: null }, AGENT)).toBe("a former team member");
    expect(actorName({ userId: AGENT, email: null }, null)).toBe("a former team member");
    expect(actorName(null, AGENT)).toBe("a former team member");
  });
});
