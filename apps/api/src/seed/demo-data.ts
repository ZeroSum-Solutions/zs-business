// Made-up demo business for local development. Names, emails (example.com) and phone
// numbers (555-01xx fictional range) are invented; no client data.
/** The demo owner's sign-in address. */
export const DEMO_OWNER_EMAIL = "owner@example.com";
export const DEMO_TENANT_NAME = "Halden & Rowe Fine Jewelry";
export const DEMO_ZONE = "America/New_York";

const hours = (from: number, to: number) => [{ startMinute: from * 60, endMinute: to * 60 }];

export const DEMO_RESOURCES = [
  {
    key: "showroom",
    name: "Showroom appointments",
    // Tuesday to Saturday, 10:00-18:00 local.
    weekly: [2, 3, 4, 5, 6].map((weekday) => ({ weekday, windows: hours(10, 18) })),
    slotLengthMinutes: 60, slotStepMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 15,
    minimumNoticeMinutes: 120, bookingHorizonMinutes: 60 * 24 * 60,
  },
  {
    key: "repair",
    name: "Repair intake",
    // Monday to Friday, 09:30-17:00 local.
    weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, windows: [{ startMinute: 570, endMinute: 1020 }] })),
    slotLengthMinutes: 20, slotStepMinutes: 20, bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
    minimumNoticeMinutes: 60, bookingHorizonMinutes: 30 * 24 * 60,
  },
] as const;

export const DEMO_STAGES = ["Inquiry", "Consultation", "Design", "Deposit", "Delivered"] as const;
export type DemoStage = (typeof DEMO_STAGES)[number];

export const DEMO_CONTACTS = [
  { name: "Maren Ashby", email: "maren.ashby@example.com", phone: "+12025550101" },
  { name: "Tobias Wren", email: "tobias.wren@example.com", phone: "+12025550102" },
  { name: "Priya Calloway", email: "priya.calloway@example.com", phone: null },
  { name: "Desmond Lyle", email: null, phone: "+12025550104" },
  { name: "Ines Marchetti", email: "ines.marchetti@example.com", phone: "+12025550105" },
  { name: "Gareth Okonjo", email: "gareth.okonjo@example.com", phone: null },
  { name: "Lucia Fenwick", email: "lucia.fenwick@example.com", phone: "+12025550107" },
  { name: "Rafael Strand", email: null, phone: "+12025550108" },
  { name: "Noor Halvorsen", email: "noor.halvorsen@example.com", phone: "+12025550109" },
  { name: "Callum Avery", email: "callum.avery@example.com", phone: null },
  { name: "Elsie Moravec", email: "elsie.moravec@example.com", phone: "+12025550111" },
  { name: "Jonah Petrakis", email: "jonah.petrakis@example.com", phone: "+12025550112" },
] as const;

export const DEMO_DEALS: readonly { contact: number; title: string; stage: DemoStage }[] = [
  { contact: 0, title: "Engagement ring, oval sapphire halo", stage: "Design" },
  { contact: 1, title: "Matching wedding bands", stage: "Consultation" },
  { contact: 2, title: "Heirloom brooch restoration", stage: "Deposit" },
  { contact: 4, title: "Custom pendant, mother's birthstones", stage: "Inquiry" },
  { contact: 5, title: "Anniversary eternity band", stage: "Delivered" },
  { contact: 6, title: "Pearl strand restring and clasp", stage: "Consultation" },
  { contact: 8, title: "Signet ring with family crest", stage: "Design" },
  { contact: 10, title: "Diamond stud upgrade", stage: "Inquiry" },
];

/** The demo business's public booking page; fake text only. */
export const DEMO_BOOKING_PAGE = {
  title: "Book a Halden & Rowe appointment",
  description: "Showroom visits and repair drop-offs at our Bath workshop.",
  disclosureVersion: "2026-10",
  disclosureText: "Halden & Rowe may email or text you about your order and occasional collection news. Untick to opt out; you can stop at any time.",
} as const;
