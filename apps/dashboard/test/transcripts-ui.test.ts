// Transcripts screen (transcription.md X-7): the demo adapter returns what the contract
// allows, the list shows each job in plain words, and speakers read as "Speaker N".
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import { transcriptionDetailSchema, transcriptionListSchema } from "@zs/contracts";
import { createDemoTranscripts, DEMO_DEAD_JOB_ID, DEMO_TRANSCRIPT_JOB_ID } from "../src/lib/api/demo/transcripts";
import { formatClock, speakerName, TranscriptsView } from "../src/components/inbox/transcripts-view";
import { isApiError } from "../src/lib/api";
import { keys, renderScreen } from "./helpers/render";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => "/inbox/transcripts",
}));

const NOW = new Date("2026-10-20T15:00:00.000Z");
const api = createDemoTranscripts({ clock: { now: () => NOW } });

describe("demo transcripts", () => {
  it("lists newest first in the contract's shape", async () => {
    const list = await api.listTranscriptions();
    expect(transcriptionListSchema.safeParse({ items: list }).success).toBe(true);
    expect(list.map((job) => job.createdAt)).toEqual([...list.map((job) => job.createdAt)].sort().reverse());
    expect(list.find((job) => job.id === DEMO_TRANSCRIPT_JOB_ID)?.transcript).toMatchObject({ speakerCount: 2, segmentCount: 3 });
  });

  it("returns ordered segments for two speakers, and a 404 for an unknown job", async () => {
    const detail = await api.getTranscription(DEMO_TRANSCRIPT_JOB_ID);
    expect(transcriptionDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail.transcript?.segments.map((segment) => segment.speaker)).toEqual(["S1", "S2", "S1"]);
    const starts = detail.transcript!.segments.map((segment) => segment.startMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    await expect(api.getTranscription("00000000-0000-4000-8000-000000000000")).rejects.toSatisfy((error) => isApiError(error, "not_found"));
  });
});

describe("transcripts screen", () => {
  it("shows each recording with a plain status", async () => {
    const items = await api.listTranscriptions();
    const html = renderScreen(h(TranscriptsView), { fill: (client) => { client.setQueryData(keys.transcriptions, items); } }).replaceAll("<!-- -->", "");
    expect(html).toContain("Voicemail");
    expect(html).toContain("Ready");
    expect(html).toContain("Waiting for the worker");
    expect(html).toContain("Could not transcribe");
    expect(html).toContain(`data-job="${DEMO_DEAD_JOB_ID}"`);
    expect(html).toContain("Pick a recording");
  });

  it("names speakers and times in words", () => {
    expect(speakerName("S2")).toBe("Speaker 2");
    expect(speakerName(null)).toBe("Unknown speaker");
    expect(formatClock(65_400)).toBe("1:05");
  });
});
