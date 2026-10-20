/**
 * Made-up demo data for "Halden & Rowe Fine Jewelry". No real people or businesses.
 * Emails use reserved example domains and phones use the fictional 555-01xx range.
 */
import type {
  BookingPageSummary,
  BookingRecord,
  ContactRecord,
  DealSummary,
  IntakeChannel,
  IntakeItemRecord,
  LeadSource,
  PipelineSummary,
  ReplyActor,
  ReplyRecord,
  ResourceSummary,
} from "@zs/contracts";
import { addDays, weekdayOf, weekRanges, zonedDateKey, zonedTimeToUtc } from "../../time";

export const DEMO_TENANT_ID = "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a70";
export const DEMO_ZONE = "America/New_York";
export const DEMO_BUSINESS = "Halden & Rowe Fine Jewelry";

export interface DemoResource extends ResourceSummary {
  name: string;
  /** Demo-only: which seeded calendar this is. */
  kind: "showroom" | "repair";
  /** Open hours per ISO weekday, as [startMinute, endMinute] in local time. */
  hours: Partial<Record<number, [number, number]>>;
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
  name: "Commissions",
  stages: [
    { id: STAGE_IDS.inquiry, name: "Inquiry", position: 1, outcome: "open" },
    { id: STAGE_IDS.consultation, name: "Consultation", position: 2, outcome: "open" },
    { id: STAGE_IDS.design, name: "Design", position: 3, outcome: "open" },
    { id: STAGE_IDS.deposit, name: "Deposit", position: 4, outcome: "open" },
    // A delivered commission is a won deal (inbox-home.md H-2).
    { id: STAGE_IDS.delivered, name: "Delivered", position: 5, outcome: "won" },
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
  // Created by a website booking (see WEBSITE_REQUESTS).
  ["Linnea Castellanos", "linnea.castellanos@example.com", null],
];
const WEBSITE_CONTACT_INDEX = 14;

/** The members who draft and approve replies in the demo. */
export const DEMO_OWNER: ReplyActor = { userId: "9a1b3c5d-7e9f-4a1b-8c2d-000000000001", email: "mara@haldenrowe.example" };
export const DEMO_STAFF: ReplyActor = { userId: "9a1b3c5d-7e9f-4a1b-8c2d-000000000002", email: "jonah@haldenrowe.example" };

/** [contactIndex, stage, title, value in dollars or null, lead source, won: which week] */
const DEALS: [number, keyof typeof STAGE_IDS, string, number | null, LeadSource | null, "this" | "last" | null][] = [
  [0, "design", "Custom engagement ring, 2 ct oval", 14500, "referral", null],
  [2, "consultation", "Anniversary eternity band, platinum", 4200, "website", null],
  [4, "deposit", "Sapphire pendant redesign", 2800, "walk_in", null],
  [6, "inquiry", "Matching wedding bands", null, "social", null],
  [7, "design", "Heirloom ring reset, grandmother's diamond", 1900, "referral", null],
  [9, "inquiry", "Emerald cocktail ring commission", 9800, null, null],
  [10, "delivered", "Diamond stud upgrade, 1 ct each", 6400, "walk_in", "this"],
  [11, "consultation", "Custom signet ring, family crest", 3100, "website", null],
  [13, "deposit", "Pearl strand restring and new clasp", 450, "phone", null],
  [3, "delivered", "Bridal set, yellow gold", 7350, "website", "this"],
  [8, "delivered", "Tennis bracelet clasp upgrade", 1250, "referral", "last"],
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

const intakeId = (n: number) => `1f4e6a8c-3b5d-4e7f-8a9b-${String(n).padStart(12, "0")}`;
export const DEMO_PAGE_ID = "7c9e1b3d-5f7a-4b9c-8d1e-2f3a4b5c6d01";
/** A key-shaped placeholder; demo mode has no signing secret and no public route. */
const DEMO_PAGE_KEY = `zsb1_${"DemoHaldenRoweBookingPage".padEnd(64, "0")}`;
const DEMO_BOOKING_HOST = "https://book.example.com";

export const DEMO_BOOKING_PAGE: BookingPageSummary = {
  id: DEMO_PAGE_ID,
  title: "Book a Halden & Rowe appointment",
  published: true,
  disclosureVersion: "2026-10",
  resourceIds: [SHOWROOM_ID, REPAIR_ID],
  publicKey: DEMO_PAGE_KEY,
  bookingUrl: `${DEMO_BOOKING_HOST}/book/${DEMO_PAGE_KEY}`,
  embedScript: `<div data-zs-booking="${DEMO_PAGE_KEY}"></div>\n<script src="${DEMO_BOOKING_HOST}/embed.js" async></script>`,
  embedIframe: `<iframe src="${DEMO_BOOKING_HOST}/book/${DEMO_PAGE_KEY}?embed=1" title="Book an appointment" style="width:100%;min-height:640px;border:0" loading="lazy"></iframe>`,
};

/** A point inside this week so far or the same span of last week: 0 is its start, 1 is its end. */
type WeekPoint = ["this" | "last", number];

interface WebsiteRequest {
  dayOffset: number;
  kind: "showroom" | "repair";
  minute: number;
  status: "new_contact" | "possible_match" | "linked";
  channel: IntakeChannel;
  /** When the visitor sent it. */
  at: WeekPoint;
  /** For `linked`: the customer the owner confirmed. */
  linkedTo?: number;
  name: string;
  email: string;
  phone: string | null;
  notes: string | null;
  /** Indexes into CONTACTS of the customers holding this email or phone. */
  matched: number[];
  consent: { email: boolean; sms: boolean };
}

/** Website bookings: one brand-new customer and two that look like people already on file. */
const WEBSITE_REQUESTS: WebsiteRequest[] = [
  {
    dayOffset: 1, kind: "showroom", minute: 900, status: "new_contact", channel: "widget", at: ["this", 0.6], name: "Linnea Castellanos",
    email: "linnea.castellanos@example.com", phone: null, notes: "Looking at sapphire halos.", matched: [], consent: { email: true, sms: false },
  },
  {
    dayOffset: 2, kind: "repair", minute: 720, status: "possible_match", channel: "widget", at: ["this", 0.8], name: "M. Okafor",
    email: "marguerite.okafor@example.com", phone: "+12125550199", notes: "Clasp keeps opening.", matched: [0], consent: { email: true, sms: true },
  },
  {
    dayOffset: 3, kind: "repair", minute: 840, status: "possible_match", channel: "widget", at: ["this", 0.9], name: "Teo Lindqvist",
    email: "teo.lindqvist@example.net", phone: "+19175550183", notes: null, matched: [1, 2], consent: { email: false, sms: false },
  },
  // Already reviewed: these sit in their customer's Inbox thread.
  {
    dayOffset: 4, kind: "showroom", minute: 780, status: "linked", linkedTo: 11, channel: "booking_page", at: ["this", 0.4], name: "Noor Haddad",
    email: "noor.haddad@example.net", phone: null, notes: "Could we see a few engraving styles before the signet consultation?", matched: [11], consent: { email: false, sms: false },
  },
  {
    dayOffset: -2, kind: "showroom", minute: 840, status: "linked", linkedTo: 0, channel: "widget", at: ["last", 0.5], name: "Marguerite Okafor",
    email: "marguerite.okafor@example.com", phone: null, notes: "Can we try a thinner halo on the oval?", matched: [0], consent: { email: false, sms: false },
  },
];

/** Contacts created inside the compared weeks (Home's new leads); the rest are older. */
const CONTACT_CREATED: Partial<Record<number, WeekPoint>> = {
  [WEBSITE_CONTACT_INDEX]: ["this", 0.6],
  13: ["this", 0.3],
  12: ["last", 0.25],
  11: ["last", 0.5],
  10: ["last", 0.75],
};

/** [contactIndex, text, drafted by, drafted at, how far it went] */
const REPLIES: [number, string, "owner" | "staff", WeekPoint, "draft" | "approved" | "sent"][] = [
  [0, "Of course. We'll have a thinner halo ready to compare at your design review.", "staff", ["last", 0.6], "sent"],
  [9, "Hi Celeste, I've set aside two emeralds that would suit a 3.5 mm band. Happy to show you whenever suits.", "owner", ["this", 0.3], "approved"],
  [5, "Your watch band is resized and ready to collect any afternoon this week.", "staff", ["this", 0.2], "draft"],
  [11, "Hi Noor, we'd be glad to. We'll lay out hand and machine engraving samples for your consultation.", "staff", ["this", 0.5], "draft"],
];
const REPLY_SUBJECTS: Partial<Record<number, string>> = { 0: "Your design review", 9: "Emeralds for your cocktail ring" };

export type DemoBooking = BookingRecord & {
  title: string | null;
  contactName: string | null;
  source: "owner" | "website";
  intakeItemId: string | null;
};

export interface DemoSeed {
  contacts: ContactRecord[];
  deals: DealSummary[];
  bookings: DemoBooking[];
  intakeItems: IntakeItemRecord[];
  replies: ReplyRecord[];
}

const replyId = (n: number) => `e7f9a1b3-5c7d-4e9f-8a1b-${String(n).padStart(12, "0")}`;
export const DEMO_BUSINESS_SUBJECT = `Message from ${DEMO_BUSINESS}`;

export function buildSeed(now: Date): DemoSeed {
  const iso = (offsetMinutes: number) => new Date(now.getTime() + offsetMinutes * 60000).toISOString();
  // Points inside Home's weeks, so the demo's results do not depend on the weekday it runs.
  const weeks = weekRanges(now.getTime(), DEMO_ZONE, "monday");
  const at = ([week, fraction]: WeekPoint, minutes = 0) => {
    const range = week === "this" ? { from: weeks.thisWeek.from, to: now.getTime() } : weeks.lastWeek;
    return new Date(Math.floor(range.from + (range.to - range.from) * fraction) + minutes * 60000).toISOString();
  };
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
    createdAt: CONTACT_CREATED[index] ? at(CONTACT_CREATED[index]) : iso(-60 * 24 * (60 - index * 3)),
    updatedAt: CONTACT_CREATED[index] ? at(CONTACT_CREATED[index]) : iso(-60 * (index * 7 + 5)),
  }));

  const deals: DealSummary[] = DEALS.map(([contactIndex, stage, title, dollars, leadSource, won], index) => {
    // A won deal's date is the write that moved it into the won stage (H-2).
    const wonAt = won ? at([won, 0.35 + index / 100]) : null;
    return {
      id: dealId(index + 1),
      tenantId: DEMO_TENANT_ID,
      contactId: contactId(contactIndex + 1),
      pipelineId: DEMO_PIPELINE.id,
      stageId: STAGE_IDS[stage],
      title,
      revision: 1 + (index % 3),
      createdAt: iso(-60 * 24 * (20 + index)),
      updatedAt: wonAt ?? iso(-60 * (index * 11 + 3)),
      value: dollars === null ? null : { amountMinor: dollars * 100, currency: "USD" },
      leadSource,
      wonAt,
    };
  });

  const today = zonedDateKey(now, DEMO_ZONE);
  const bookings: DemoSeed["bookings"] = [];
  const place = (dayOffset: number, kind: "showroom" | "repair", minute: number, id: string, extra: Pick<DemoBooking, "title" | "contactName" | "source" | "intakeItemId" | "createdAt">) => {
    const resource = DEMO_RESOURCES.find((item) => item.kind === kind)!;
    let day = addDays(today, dayOffset);
    for (let tries = 0; tries < 7 && !resource.hours[weekdayOf(day)]; tries += 1) day = addDays(day, dayOffset < 0 ? -1 : 1);
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    const starts = zonedTimeToUtc(y, m, d, minute, DEMO_ZONE);
    const ends = new Date(starts.getTime() + resource.slotLengthMinutes * 60000);
    const record: DemoBooking = {
      id,
      tenantId: DEMO_TENANT_ID,
      resourceId: resource.id,
      startsAt: starts.toISOString(),
      endsAt: ends.toISOString(),
      occupiedStartsAt: new Date(starts.getTime() - resource.bufferBeforeMinutes * 60000).toISOString(),
      occupiedEndsAt: new Date(ends.getTime() + resource.bufferAfterMinutes * 60000).toISOString(),
      bufferBeforeMinutes: resource.bufferBeforeMinutes,
      bufferAfterMinutes: resource.bufferAfterMinutes,
      status: "confirmed" as const,
      createdAt: extra.createdAt,
      title: extra.title,
      contactName: extra.contactName,
      source: extra.source,
      intakeItemId: extra.intakeItemId,
    };
    const clash = bookings.some((other) => other.resourceId === record.resourceId &&
      other.occupiedStartsAt < record.occupiedEndsAt && record.occupiedStartsAt < other.occupiedEndsAt);
    if (clash) return null;
    bookings.push(record);
    return record;
  };
  BOOKINGS.forEach(([dayOffset, kind, minute, contactIndex, title], index) => {
    place(dayOffset, kind, minute, bookingId(index + 1), {
      title, contactName: contactIndex === null ? null : CONTACTS[contactIndex]?.[0] ?? null, source: "owner", intakeItemId: null,
      // Taken across both compared weeks, so Home has bookings to count on any weekday.
      createdAt: at([index % 2 === 0 ? "this" : "last", (index + 1) / (BOOKINGS.length + 2)]),
    });
  });

  const intakeItems: IntakeItemRecord[] = [];
  WEBSITE_REQUESTS.forEach((request, index) => {
    const id = intakeId(index + 1);
    const createdAt = at(request.at);
    const booking = place(request.dayOffset, request.kind, request.minute, bookingId(100 + index), {
      title: null, contactName: null, source: "website", intakeItemId: id, createdAt,
    });
    if (!booking) return;
    const consent = (ticked: boolean) => ticked
      ? { status: "granted" as const, purpose: "marketing_updates", disclosureVersion: DEMO_BOOKING_PAGE.disclosureVersion, source: `widget:${DEMO_PAGE_ID}`, recordedAt: createdAt }
      : null;
    intakeItems.push({
      id,
      tenantId: DEMO_TENANT_ID,
      kind: "booking_request",
      status: request.status,
      channel: request.channel,
      pageId: DEMO_PAGE_ID,
      submitted: { name: request.name, email: request.email, phone: request.phone, notes: request.notes },
      matchedContactIds: request.matched.map((contactIndex) => contactId(contactIndex + 1)),
      contactId: request.status === "new_contact" ? contactId(WEBSITE_CONTACT_INDEX + 1)
        : request.status === "linked" && request.linkedTo !== undefined ? contactId(request.linkedTo + 1) : null,
      consent: { email: consent(request.consent.email), sms: consent(request.consent.sms) },
      booking: { id: booking.id, resourceId: booking.resourceId, startsAt: booking.startsAt, endsAt: booking.endsAt },
      reviewedAt: request.status === "linked" ? at(request.at, 30) : null,
      createdAt,
    });
  });

  const replies: ReplyRecord[] = REPLIES.map(([contactIndex, body, author, drafted, status], index) => {
    const createdAt = at(drafted);
    const approvedAt = status === "draft" ? null : at(drafted, 20);
    return {
      id: replyId(index + 1),
      tenantId: DEMO_TENANT_ID,
      contactId: contactId(contactIndex + 1),
      channel: "email",
      subject: REPLY_SUBJECTS[contactIndex] ?? DEMO_BUSINESS_SUBJECT,
      body,
      status,
      draftedBy: author === "owner" ? DEMO_OWNER : DEMO_STAFF,
      createdAt,
      approvedBy: approvedAt ? DEMO_OWNER : null,
      approvedAt,
      discardedAt: null,
      settledAt: status === "sent" ? at(drafted, 25) : null,
    };
  });

  return { contacts, deals, bookings, intakeItems, replies };
}
