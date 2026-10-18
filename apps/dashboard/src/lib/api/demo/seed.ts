/**
 * Made-up demo data for "Halden & Rowe Fine Jewelry". No real people or businesses.
 * Emails use reserved example domains and phones use the fictional 555-01xx range.
 */
import type { BookingRecord, ContactRecord, DealRecord } from "@zs/contracts";
import { addDays, weekdayOf, zonedDateKey, zonedTimeToUtc } from "../../time";
import type { BookingResourceSummary, PipelineSummary } from "../types";

export const DEMO_TENANT_ID = "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a70";
export const DEMO_ZONE = "America/New_York";
export const DEMO_BUSINESS = "Halden & Rowe Fine Jewelry";

export interface DemoResource extends BookingResourceSummary {
  /** Open hours per ISO weekday, as [startMinute, endMinute] in local time. */
  hours: Partial<Record<number, [number, number]>>;
  slotLengthMinutes: number;
  slotStepMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minimumNoticeMinutes: number;
}

export const SHOWROOM_ID = "0b7e5c1a-9d2f-4a3b-8c6d-1e2f3a4b5c61";
export const REPAIR_ID = "0b7e5c1a-9d2f-4a3b-8c6d-1e2f3a4b5c62";

export const DEMO_RESOURCES: DemoResource[] = [
  {
    id: SHOWROOM_ID,
    name: "Showroom appointments",
    kind: "showroom",
    timeZone: DEMO_ZONE,
    hours: { 2: [600, 1080], 3: [600, 1080], 4: [600, 1140], 5: [600, 1080], 6: [600, 1020] },
    slotLengthMinutes: 45,
    slotStepMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 15,
    minimumNoticeMinutes: 60,
  },
  {
    id: REPAIR_ID,
    name: "Repair intake",
    kind: "repair",
    timeZone: DEMO_ZONE,
    hours: { 1: [600, 1020], 2: [600, 1020], 3: [600, 1020], 4: [600, 1020], 5: [600, 1020], 6: [600, 960] },
    slotLengthMinutes: 20,
    slotStepMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 10,
    minimumNoticeMinutes: 60,
  },
];

export const STAGE_IDS = {
  inquiry: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e02",
  consultation: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e03",
  design: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e04",
  deposit: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e05",
  delivered: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e06",
} as const;

export const DEMO_PIPELINE: PipelineSummary = {
  id: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e01",
  stages: [
    { id: STAGE_IDS.inquiry, name: "Inquiry" },
    { id: STAGE_IDS.consultation, name: "Consultation" },
    { id: STAGE_IDS.design, name: "Design" },
    { id: STAGE_IDS.deposit, name: "Deposit" },
    { id: STAGE_IDS.delivered, name: "Delivered" },
  ],
};

const contactId = (n: number) => `5e0c1a2b-7d3f-4c8a-9b1e-${String(n).padStart(12, "0")}`;
const dealId = (n: number) => `d3a17b5c-2e4f-4a6b-8c9d-${String(n).padStart(12, "0")}`;
const bookingId = (n: number) => `b8c2d4e6-1a3f-4b5c-9d7e-${String(n).padStart(12, "0")}`;

const CONTACTS: [string, string | null, string | null][] = [
  ["Marguerite Okafor", "marguerite.okafor@example.com", "+12125550142"],
  ["Teodor Lindqvist", "teo.lindqvist@example.net", "+12125550117"],
  ["Priya Raman-Hale", "priya.ramanhale@example.org", "+19175550183"],
  ["Colm Brennan", "colm@brennan-studio.example", null],
  ["Ines Achterberg", "ines.achterberg@example.com", "+16465550129"],
  ["Dashiell Moreau", null, "+12125550166"],
  ["Yuki Tanabe-Ross", "yuki.tr@example.net", "+19175550104"],
  ["Rosalind Abiodun", "rosalind.abiodun@example.com", "+13475550158"],
  ["August Kerrigan", "august.kerrigan@example.org", null],
  ["Celeste Vandermeer", "celeste@vandermeer.example", "+12015550191"],
  ["Rafael Quintero", "rquintero@example.com", "+16465550136"],
  ["Noor Haddad", "noor.haddad@example.net", "+19175550172"],
  ["Wendell Ashby", "wendell.ashby@example.com", "+12125550108"],
  ["Saoirse Ng", "saoirse.ng@example.org", "+13475550125"],
];

const DEALS: [number, keyof typeof STAGE_IDS, string][] = [
  [0, "design", "Custom engagement ring, 2 ct oval"],
  [2, "consultation", "Anniversary eternity band, platinum"],
  [4, "deposit", "Sapphire pendant redesign"],
  [6, "inquiry", "Matching wedding bands"],
  [7, "design", "Heirloom ring reset, grandmother's diamond"],
  [9, "inquiry", "Emerald cocktail ring commission"],
  [10, "delivered", "Diamond stud upgrade, 1 ct each"],
  [11, "consultation", "Custom signet ring, family crest"],
  [13, "deposit", "Pearl strand restring and new clasp"],
];

const BOOKINGS: [number, "showroom" | "repair", number, number | null, string][] = [
  // [dayOffset, resource, localMinute, contactIndex, title]
  [0, "showroom", 660, 0, "Ring design review"],
  [0, "repair", 900, 5, "Watch band resize"],
  [1, "showroom", 780, 2, "Eternity band sizing"],
  [1, "repair", 630, 12, "Prong re-tip"],
  [2, "showroom", 960, 7, "Heirloom stone viewing"],
  [3, "showroom", 720, 11, "Signet ring consultation"],
  [4, "repair", 690, 13, "Pearl restring drop-off"],
  [5, "showroom", 840, 3, "Bridal consultation"],
  [-2, "showroom", 720, 10, "Stud pickup"],
  [-3, "repair", 600, 8, "Chain repair estimate"],
];

export interface DemoSeed {
  contacts: ContactRecord[];
  deals: DealRecord[];
  bookings: (BookingRecord & { title: string | null; contactName: string | null })[];
}

export function buildSeed(now: Date): DemoSeed {
  const iso = (offsetMinutes: number) => new Date(now.getTime() + offsetMinutes * 60000).toISOString();
  const contacts: ContactRecord[] = CONTACTS.map(([name, email, phone], index) => ({
    id: contactId(index + 1),
    tenantId: DEMO_TENANT_ID,
    displayName: name,
    email,
    phone,
    consent: {
      email: email ? { status: "granted", source: "Showroom sign-up card", recordedAt: iso(-60 * 24 * (40 + index)) } : null,
      sms: phone ? { status: index % 3 === 0 ? "denied" : "granted", source: "Booking form", recordedAt: iso(-60 * 24 * (30 + index)) } : null,
    },
    createdAt: iso(-60 * 24 * (60 - index * 3)),
    updatedAt: iso(-60 * (index * 7 + 5)),
  }));

  const deals: DealRecord[] = DEALS.map(([contactIndex, stage, title], index) => ({
    id: dealId(index + 1),
    tenantId: DEMO_TENANT_ID,
    contactId: contactId(contactIndex + 1),
    pipelineId: DEMO_PIPELINE.id,
    stageId: STAGE_IDS[stage],
    title,
    revision: 1 + (index % 3),
    createdAt: iso(-60 * 24 * (20 + index)),
    updatedAt: iso(-60 * (index * 11 + 3)),
  }));

  const today = zonedDateKey(now, DEMO_ZONE);
  const bookings: DemoSeed["bookings"] = [];
  BOOKINGS.forEach(([dayOffset, kind, minute, contactIndex, title], index) => {
    const resource = DEMO_RESOURCES.find((item) => item.kind === kind)!;
    let day = addDays(today, dayOffset);
    for (let tries = 0; tries < 7 && !resource.hours[weekdayOf(day)]; tries += 1) day = addDays(day, dayOffset < 0 ? -1 : 1);
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    const starts = zonedTimeToUtc(y, m, d, minute, DEMO_ZONE);
    const ends = new Date(starts.getTime() + resource.slotLengthMinutes * 60000);
    const record = {
      id: bookingId(index + 1),
      tenantId: DEMO_TENANT_ID,
      resourceId: resource.id,
      startsAt: starts.toISOString(),
      endsAt: ends.toISOString(),
      occupiedStartsAt: new Date(starts.getTime() - resource.bufferBeforeMinutes * 60000).toISOString(),
      occupiedEndsAt: new Date(ends.getTime() + resource.bufferAfterMinutes * 60000).toISOString(),
      bufferBeforeMinutes: resource.bufferBeforeMinutes,
      bufferAfterMinutes: resource.bufferAfterMinutes,
      status: "confirmed" as const,
      createdAt: iso(-60 * 24 * 3),
      title,
      contactName: contactIndex === null ? null : CONTACTS[contactIndex]?.[0] ?? null,
    };
    const clash = bookings.some((other) => other.resourceId === record.resourceId &&
      other.occupiedStartsAt < record.occupiedEndsAt && record.occupiedStartsAt < other.occupiedEndsAt);
    if (!clash) bookings.push(record);
  });

  return { contacts, deals, bookings };
}
