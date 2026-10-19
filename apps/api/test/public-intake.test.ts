import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bookingPageSchema,
  intakeItemOutputSchema,
  intakeItemPageSchema,
  publicBookingReplySchema,
  publicPageSchema,
} from "@zs/contracts";
import { signBookingKey, verifyBookingKey } from "@zs/core";
import {
  call,
  createApiHarness,
  KEY_SECRET,
  NOW,
  PREVIOUS_KEY_SECRET,
  provisionPage,
  PUBLIC_BASE_URL,
  type ApiHarness,
  type PageSetup,
  type TenantSetup,
} from "./helpers.js";

let h: ApiHarness;
beforeAll(async () => {
  // Generous limits here; the abuse-limit suite below runs its own harness.
  h = await createApiHarness({
    publicIntake: {
      clientIp: { header: "x-real-ip" },
      keySecrets: { current: KEY_SECRET, previous: PREVIOUS_KEY_SECRET },
      limits: {
        addressWrites: { limit: 1000, windowMs: 600_000 },
        addressReads: { limit: 1000, windowMs: 600_000 },
        tenantWrites: { limit: 1000, windowMs: 3_600_000 },
      },
    },
  });
});
afterAll(async () => h.close());

/** Monday 2026-10-19, an hour on the hour, UTC. */
const at = (hour: number, day = 19) => `2026-10-${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;
let address = 0;
const nextAddress = () => `203.0.113.${(++address % 250) + 1}`;

/** A fresh weekday 09:00-17:00 UTC resource on its own published page, so tests never share slots. */
async function freshPage(tenant: TenantSetup, options: { disclosureVersion?: string } = {}) {
  const resourceId = randomUUID();
  await h.fixture.service((tx) => tx.query(
    `INSERT INTO booking_resources (tenant_id,id,name,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
       buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
     VALUES ($1,$2,'Fitting room','UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,20160)`,
    [tenant.tenantId, resourceId, JSON.stringify([1, 2, 3, 4, 5].map((weekday) =>
      ({ weekday, windows: [{ startMinute: 540, endMinute: 1020 }] })))],
  ));
  const page = await provisionPage(h, tenant, { resourceIds: [resourceId], ...options });
  return { ...page, resourceId };
}

const visitor = (resourceId: string, over: Record<string, unknown> = {}) => ({
  resourceId,
  startsAt: at(9),
  name: "Mira Rowe",
  email: `mira.${randomUUID().slice(0, 8)}@haldenrowe.example`,
  phone: null,
  notes: null,
  consent: { email: false, sms: false },
  disclosureVersion: "v1",
  channel: "widget",
  website: "",
  ...over,
});

const book = (key: string, body: unknown, idempotencyKey: string = randomUUID(), from = nextAddress()) =>
  call(h.app, "POST", `/public/v1/pages/${key}/requests`, { body, key: idempotencyKey, headers: { "X-Real-IP": from } });

const count = (sql: string, params: unknown[]) =>
  h.fixture.service(async (tx) => Number((await tx.query<{ n: string }>(sql, params)).rows[0]!.n));
const tenantCounts = async (tenantId: string) => ({
  contacts: await count("SELECT count(*) AS n FROM crm_contacts WHERE tenant_id=$1", [tenantId]),
  consent: await count("SELECT count(*) AS n FROM crm_contact_consent WHERE tenant_id=$1", [tenantId]),
  intake: await count("SELECT count(*) AS n FROM intake_items WHERE tenant_id=$1", [tenantId]),
  intakeConsent: await count("SELECT count(*) AS n FROM intake_item_consent WHERE tenant_id=$1", [tenantId]),
  bookings: await count("SELECT count(*) AS n FROM bookings WHERE tenant_id=$1", [tenantId]),
  actions: await count("SELECT count(*) AS n FROM actions WHERE tenant_id=$1", [tenantId]),
  outbox: await count("SELECT count(*) AS n FROM outbox WHERE tenant_id=$1", [tenantId]),
});

async function ownerContact(tenant: TenantSetup, body: Record<string, unknown>) {
  const response = await call(h.app, "POST", "/v1/crm/contacts", { token: tenant.token, key: randomUUID(), body });
  expect(response.status).toBeLessThan(300);
  return response.body.result.contact as { id: string; displayName: string; updatedAt: string; consent: unknown };
}

describe("public reads", () => {
  it("shows a published page without tenant or contact data", async () => {
    const page = await freshPage(h.a);
    const response = await call(h.app, "GET", `/public/v1/pages/${page.key}`);
    expect(response.status).toBe(200);
    const body = publicPageSchema.parse(response.body);
    expect(body).toMatchObject({ businessName: "Tenant A", title: "Book a fitting", disclosure: { version: "v1" } });
    expect(body.resources.map((resource) => resource.id)).toEqual([page.resourceId]);
    expect(JSON.stringify(body)).not.toContain(h.a.tenantId);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("lists free slots for a linked resource only", async () => {
    const page = await freshPage(h.a);
    const query = `resourceId=${page.resourceId}&from=${at(8)}&to=${at(12)}`;
    const free = await call(h.app, "GET", `/public/v1/pages/${page.key}/slots?${query}`);
    expect(free.status).toBe(200);
    expect(free.body.slots.map((slot: { startsAt: string }) => slot.startsAt)).toEqual([at(9), at(10), at(11)]);
    // Another resource of the same tenant, not linked to this page.
    const unlinked = `resourceId=${h.a.resourceId}&from=${at(8)}&to=${at(12)}`;
    expect((await call(h.app, "GET", `/public/v1/pages/${page.key}/slots?${unlinked}`)).status).toBe(404);
  });
});

describe("forged tenant, page and resource references (P-2, P-4)", () => {
  let page: PageSetup & { resourceId: string };
  beforeAll(async () => { page = await freshPage(h.a); });

  it("answers one fixed 404 for every forged or unusable key", async () => {
    const unpublished = await provisionPage(h, h.a, { published: false });
    const real = page.key;
    const forgedKeys = [
      "not-a-key",
      `zsb1_${"A".repeat(64)}`,
      // Right tenant and page, wrong secret.
      signBookingKey(["other", "secret", "z".repeat(32)].join("-"), { tenantId: h.a.tenantId, pageId: page.pageId }),
      // Tenant B's ID with tenant A's page ID and A's tag: the tag no longer matches.
      `zsb1_${Buffer.concat([
        Buffer.from(h.b.tenantId.replaceAll("-", ""), "hex"),
        Buffer.from(real.slice(5), "base64url").subarray(16),
      ]).toString("base64url")}`,
      // One flipped character in the tag.
      real.slice(0, -1) + (real.endsWith("A") ? "B" : "A"),
      unpublished.key,
      // A real page of tenant A, signed for tenant B.
      signBookingKey(KEY_SECRET, { tenantId: h.b.tenantId, pageId: page.pageId }),
    ];
    const bodies = new Set<string>();
    for (const key of forgedKeys) {
      const read = await call(h.app, "GET", `/public/v1/pages/${encodeURIComponent(key)}`);
      const write = await book(encodeURIComponent(key), visitor(page.resourceId));
      expect([read.status, write.status], key).toEqual([404, 404]);
      bodies.add(JSON.stringify(read.body));
      bodies.add(JSON.stringify(write.body));
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: { code: "NotFound", message: "Not found", details: {} } })]);
  });

  it("refuses another tenant's resource and an unlinked resource without writing", async () => {
    const before = await tenantCounts(h.a.tenantId);
    const beforeB = await tenantCounts(h.b.tenantId);
    expect((await book(page.key, visitor(h.b.resourceId))).status).toBe(404);
    expect((await book(page.key, visitor(h.a.resourceId))).status).toBe(404);
    expect((await book(page.key, visitor(randomUUID()))).status).toBe(404);
    expect(await tenantCounts(h.a.tenantId)).toEqual(before);
    expect(await tenantCounts(h.b.tenantId)).toEqual(beforeB);
  });

  it("rejects a tenant, status or source in the body", async () => {
    for (const extra of [{ tenantId: h.b.tenantId }, { status: "linked" }, { source: "owner" }, { pageId: randomUUID() }]) {
      const response = await book(page.key, visitor(page.resourceId, extra));
      expect(response.status).toBe(400);
    }
  });

  it("accepts keys signed with the previous secret during a rotation", async () => {
    const rotated = signBookingKey(PREVIOUS_KEY_SECRET, { tenantId: h.a.tenantId, pageId: page.pageId });
    expect((await call(h.app, "GET", `/public/v1/pages/${rotated}`)).status).toBe(200);
  });
});

describe("same reply for new and known people (P-6, P-7)", () => {
  it("answers identically for unknown, email, phone and split matches", async () => {
    const page = await freshPage(h.a);
    const tag = randomUUID().slice(0, 8);
    const known = await ownerContact(h.a, { displayName: "Known", email: `known.${tag}@haldenrowe.example`, phone: "+447700900101" });
    await ownerContact(h.a, { displayName: "Other", email: `other.${tag}@haldenrowe.example`, phone: "+447700900102" });
    const cases = [
      { email: `fresh.${tag}@haldenrowe.example`, phone: "+447700900103" },
      { email: `known.${tag}@haldenrowe.example`, phone: null },
      { email: `new.${tag}@haldenrowe.example`, phone: "+447700900101" },
      // Email of one contact and phone of another: a split identity, still just a match.
      { email: `known.${tag}@haldenrowe.example`, phone: "+447700900102" },
    ];
    const shapes = new Set<string>();
    for (const [index, identity] of cases.entries()) {
      const response = await book(page.key, visitor(page.resourceId, { ...identity, startsAt: at(9 + index) }));
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const reply = publicBookingReplySchema.parse(response.body);
      expect(reply).toMatchObject({ status: "confirmed", resourceId: page.resourceId, startsAt: at(9 + index), endsAt: at(10 + index) });
      shapes.add(JSON.stringify({
        keys: Object.keys(response.body).sort(),
        // Names and values, so even Content-Length cannot tell a known person from a new one.
        headers: [...response.headers.entries()].filter(([name]) => name !== "date").sort(),
      }));
    }
    expect(shapes.size).toBe(1);
    const items = await h.fixture.service(async (tx) => (await tx.query<{ status: string; matched: string[] }>(
      `SELECT status, matched_contact_ids::text[] AS matched FROM intake_items WHERE tenant_id=$1 AND page_id=$2 ORDER BY created_at, submitted_email`,
      [h.a.tenantId, page.pageId],
    )).rows);
    expect(items.map((item) => item.status).sort()).toEqual(["new_contact", "possible_match", "possible_match", "possible_match"]);
    expect(items.filter((item) => item.matched.includes(known.id))).toHaveLength(3);
    expect(items.some((item) => item.matched.length === 2)).toBe(true);
  });

  it("replays a retried request and refuses a reused key with a different body", async () => {
    const page = await freshPage(h.a);
    const key = randomUUID();
    const body = visitor(page.resourceId);
    const first = await book(page.key, body, key);
    const second = await book(page.key, body, key);
    expect(first.status).toBe(201);
    expect(second).toMatchObject({ status: 201, body: first.body });
    expect(await count("SELECT count(*) AS n FROM intake_items WHERE tenant_id=$1 AND page_id=$2", [h.a.tenantId, page.pageId])).toBe(1);
    const reused = await book(page.key, { ...body, name: "Someone Else" }, key);
    expect(reused).toMatchObject({ status: 409, body: { error: { details: { reason: "idempotency_key_reused" } } } });
  });

  it("creates a brand-new contact with the intake consent", async () => {
    const page = await freshPage(h.a);
    const body = visitor(page.resourceId, { phone: "+447700900111", consent: { email: true, sms: false }, notes: "  Hem only  " });
    const response = await book(page.key, body);
    expect(response.status).toBe(201);
    const row = await h.fixture.service(async (tx) => (await tx.query<{
      status: string; contact_id: string; notes: string; display_name: string; consent: string;
    }>(
      `SELECT i.status, i.contact_id, i.notes, c.display_name,
              (SELECT string_agg(channel || ':' || status || ':' || source, ',') FROM crm_contact_consent cc
                WHERE cc.tenant_id=c.tenant_id AND cc.contact_id=c.id) AS consent
         FROM intake_items i JOIN crm_contacts c ON c.tenant_id=i.tenant_id AND c.id=i.contact_id
        WHERE i.tenant_id=$1 AND i.id=$2`,
      [h.a.tenantId, response.body.requestId],
    )).rows[0]!);
    expect(row).toMatchObject({ status: "new_contact", notes: "Hem only", display_name: "Mira Rowe" });
    expect(row.consent).toBe(`email:granted:intake:${response.body.requestId}`);
  });

  it("records what the visitor agreed to, when and on which form, and keeps one text per version", async () => {
    const page = await freshPage(h.a);
    const shown = (await call(h.app, "GET", `/public/v1/pages/${page.key}`, { headers: { "X-Real-IP": nextAddress() } }))
      .body.disclosure as { version: string; text: string };
    const response = await book(page.key, visitor(page.resourceId, { consent: { email: true, sms: false }, channel: "booking_page" }));
    expect(response.status).toBe(201);
    const provenance = () => h.fixture.service(async (tx) => (await tx.query(
      `SELECT channel::text, status::text, purpose, disclosure_version, disclosure_text, source, recorded_at
         FROM intake_item_consent WHERE tenant_id=$1 AND intake_item_id=$2`,
      [h.a.tenantId, response.body.requestId],
    )).rows);
    const recorded = [{
      channel: "email", status: "granted", purpose: "marketing_updates", disclosure_version: shown.version,
      disclosure_text: shown.text, source: `booking_page:${page.pageId}`, recorded_at: new Date(NOW),
    }];
    // The unticked SMS box records nothing: no evidence, not a denial.
    expect(await provenance()).toEqual(recorded);
    // New words under the same version would rewrite what earlier visitors agreed to.
    const edit = (version: string) => h.fixture.service((tx) => tx.query(
      "UPDATE booking_pages SET disclosure_text='Different words', disclosure_version=$3 WHERE tenant_id=$1 AND id=$2",
      [h.a.tenantId, page.pageId, version]));
    await expect(edit(shown.version)).rejects.toThrow(/needs a new disclosure version/);
    await edit("v2");
    expect(await provenance()).toEqual(recorded);
    // A visitor still holding the old version is asked to read the new words.
    const stale = await book(page.key, visitor(page.resourceId, { startsAt: at(10), consent: { email: true, sms: false } }));
    expect(stale).toMatchObject({ status: 409, body: { error: { details: { reason: "disclosure_changed" } } } });
  });
});

describe("victim protection (P-7, P-8)", () => {
  it("leaves a victim's contact and recorded denial unchanged under forged consent", async () => {
    const page = await freshPage(h.a);
    const tag = randomUUID().slice(0, 8);
    const victim = await ownerContact(h.a, {
      displayName: "Elin Halden",
      email: `elin.${tag}@haldenrowe.example`,
      phone: "+447700900201",
      consent: { email: { status: "denied", source: "front-desk", recordedAt: "2026-10-01T10:00:00.000Z" }, sms: null },
    });
    const snapshot = () => h.fixture.service(async (tx) => ({
      contact: (await tx.query("SELECT display_name, normalized_email, e164_phone, updated_at FROM crm_contacts WHERE tenant_id=$1 AND id=$2",
        [h.a.tenantId, victim.id])).rows,
      consent: (await tx.query(
        "SELECT channel::text, status::text, source, recorded_at FROM crm_contact_consent WHERE tenant_id=$1 AND contact_id=$2 ORDER BY channel",
        [h.a.tenantId, victim.id])).rows,
    }));
    const before = await snapshot();
    const contactsBefore = await count("SELECT count(*) AS n FROM crm_contacts WHERE tenant_id=$1", [h.a.tenantId]);

    const response = await book(page.key, visitor(page.resourceId, {
      name: "Attacker Name",
      email: `ELIN.${tag}@HaldenRowe.example`,
      phone: "+447700900201",
      consent: { email: true, sms: true },
    }));
    expect(response.status).toBe(201);
    expect(await snapshot()).toEqual(before);
    expect(await count("SELECT count(*) AS n FROM crm_contacts WHERE tenant_id=$1", [h.a.tenantId])).toBe(contactsBefore);

    const items = intakeItemPageSchema.parse((await call(h.app, "GET", "/v1/intake/items?status=possible_match", { token: h.a.token })).body);
    const item = items.items.find((candidate) => candidate.id === response.body.requestId)!;
    expect(item).toMatchObject({
      status: "possible_match", contactId: null, matchedContactIds: [victim.id],
      submitted: { name: "Attacker Name", email: `elin.${tag}@haldenrowe.example` },
      consent: {
        email: { status: "granted", purpose: "marketing_updates", disclosureVersion: "v1", source: `widget:${page.pageId}`, recordedAt: NOW },
        sms: { status: "granted", source: `widget:${page.pageId}` },
      },
    });

    // Linking fills only the channel with no evidence: the denial stays, SMS is filled.
    const linked = await call(h.app, "POST", `/v1/intake/items/${item.id}/link`, {
      token: h.a.token, key: randomUUID(), body: { contactId: victim.id },
    });
    expect(linked.status).toBe(200);
    expect(intakeItemOutputSchema.parse(linked.body).result).toMatchObject({ status: "linked", contactId: victim.id });
    const after = await snapshot();
    expect(after.contact[0].display_name).toBe("Elin Halden");
    expect(after.consent).toEqual([
      expect.objectContaining({ channel: "email", status: "denied", source: "front-desk" }),
      expect.objectContaining({ channel: "sms", status: "granted", source: `intake:${item.id}` }),
    ]);
  });
});

describe("one transaction (P-9)", () => {
  it("lets one of two concurrent requests for a slot win and leaves nothing from the loser", async () => {
    const page = await freshPage(h.a);
    const before = await tenantCounts(h.a.tenantId);
    const [first, second] = await Promise.all([
      book(page.key, visitor(page.resourceId, { startsAt: at(11) })),
      book(page.key, visitor(page.resourceId, { startsAt: at(11) })),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const loser = first.status === 409 ? first : second;
    expect(["slot_unavailable", "overlap"]).toContain(loser.body.error.details.reason);
    const after = await tenantCounts(h.a.tenantId);
    expect(after).toEqual({
      contacts: before.contacts + 1,
      consent: before.consent,
      intake: before.intake + 1,
      intakeConsent: before.intakeConsent,
      bookings: before.bookings + 1,
      actions: before.actions + 1,
      outbox: before.outbox + 1,
    });
  });

  it("refuses a taken slot before any work that depends on who the visitor is", async () => {
    const page = await freshPage(h.a);
    const tag = randomUUID().slice(0, 8);
    await ownerContact(h.a, { displayName: "Known", email: `taken.${tag}@haldenrowe.example`, phone: "+447700900401" });
    expect((await book(page.key, visitor(page.resourceId, { startsAt: at(14) }))).status).toBe(201);
    // Any contact or intake write for this tenant now fails loudly: a 409 proves none was attempted.
    const fail = `zs_fail_${randomUUID().replaceAll("-", "")}`;
    await h.database.pool.query(`
      CREATE FUNCTION ${fail}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.tenant_id = '${h.a.tenantId}' THEN RAISE EXCEPTION 'identity work before the slot check'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${fail} BEFORE INSERT ON crm_contacts FOR EACH ROW EXECUTE FUNCTION ${fail}();
      CREATE TRIGGER ${fail} BEFORE INSERT ON intake_items FOR EACH ROW EXECUTE FUNCTION ${fail}();
      CREATE TRIGGER ${fail} BEFORE INSERT ON intake_item_consent FOR EACH ROW EXECUTE FUNCTION ${fail}();`);
    try {
      const before = await tenantCounts(h.a.tenantId);
      const replies = [];
      for (const identity of [
        { email: `unknown.${tag}@haldenrowe.example`, phone: "+447700900402" },
        { email: `taken.${tag}@haldenrowe.example`, phone: "+447700900401" },
      ]) {
        const response = await book(page.key, visitor(page.resourceId, { ...identity, startsAt: at(14), consent: { email: true, sms: true } }));
        expect(response.status, JSON.stringify(response.body)).toBe(409);
        replies.push({ body: response.body, headers: [...response.headers.entries()].filter(([name]) => name !== "date") });
      }
      expect(replies[0]).toEqual(replies[1]);
      expect(replies[0]!.body.error.details.reason).toBe("slot_unavailable");
      expect(await tenantCounts(h.a.tenantId)).toEqual(before);
    } finally {
      await h.database.pool.query(`
        DROP TRIGGER ${fail} ON crm_contacts; DROP TRIGGER ${fail} ON intake_items;
        DROP TRIGGER ${fail} ON intake_item_consent; DROP FUNCTION ${fail}();`);
    }
  });

  it("rolls everything back when a late step fails", async () => {
    const page = await freshPage(h.a, {});
    const fail = `zs_fail_${randomUUID().replaceAll("-", "")}`;
    // The booking is the last insert before the action row; failing it must undo the
    // contact, intake item and consent rows written before it.
    await h.database.pool.query(`
      CREATE FUNCTION ${fail}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.source = 'website' AND NEW.resource_id = '${page.resourceId}' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${fail} BEFORE INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION ${fail}();`);
    const before = await tenantCounts(h.a.tenantId);
    const key = randomUUID();
    const body = visitor(page.resourceId, { phone: "+447700900301", consent: { email: true, sms: true } });
    try {
      const failed = await book(page.key, body, key);
      expect(failed.status).toBe(500);
      expect(JSON.stringify(failed.body)).not.toContain("injected");
      expect(await tenantCounts(h.a.tenantId)).toEqual(before);
    } finally {
      await h.database.pool.query(`DROP TRIGGER ${fail} ON bookings; DROP FUNCTION ${fail}();`);
    }
    // Nothing was stored under the key, so the same attempt now succeeds.
    expect((await book(page.key, body, key)).status).toBe(201);
  });

  it("rolls back when the outbox write fails", async () => {
    const page = await freshPage(h.a);
    const fail = `zs_fail_${randomUUID().replaceAll("-", "")}`;
    await h.database.pool.query(`
      CREATE FUNCTION ${fail}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type LIKE 'booking.public_request%' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${fail} BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION ${fail}();`);
    const before = await tenantCounts(h.a.tenantId);
    try {
      const failed = await book(page.key, visitor(page.resourceId, { consent: { email: true, sms: false } }));
      expect(failed.status).toBe(500);
      expect(await tenantCounts(h.a.tenantId)).toEqual(before);
    } finally {
      await h.database.pool.query(`DROP TRIGGER ${fail} ON outbox; DROP FUNCTION ${fail}();`);
    }
  });

  it("refuses consent given against an old disclosure and writes nothing", async () => {
    const page = await freshPage(h.a, { disclosureVersion: "v2" });
    const before = await tenantCounts(h.a.tenantId);
    const response = await book(page.key, visitor(page.resourceId, { consent: { email: true, sms: false } }));
    expect(response).toMatchObject({ status: 409, body: { error: { details: { reason: "disclosure_changed" } } } });
    expect(await tenantCounts(h.a.tenantId)).toEqual(before);
  });
});

describe("input limits (P-10)", () => {
  it("refuses an oversized body, a filled honeypot and a missing idempotency key", async () => {
    const page = await freshPage(h.a);
    const big = await book(page.key, visitor(page.resourceId, { notes: "x".repeat(9000) }));
    expect(big.status).toBe(413);
    expect((await book(page.key, visitor(page.resourceId, { website: "http://spam.example" }))).status).toBe(400);
    const noKey = await call(h.app, "POST", `/public/v1/pages/${page.key}/requests`, { body: visitor(page.resourceId) });
    expect(noKey.status).toBe(400);
    const notUuid = await book(page.key, visitor(page.resourceId), "owner-style-key");
    expect(notUuid.status).toBe(400);
  });
});

describe("owner review (P-12)", () => {
  async function possibleMatch(page: { key: string; resourceId: string }, startsAt: string) {
    const tag = randomUUID().slice(0, 8);
    const contact = await ownerContact(h.a, { displayName: "Owner Copy", email: `review.${tag}@haldenrowe.example` });
    const response = await book(page.key, visitor(page.resourceId, { email: `review.${tag}@haldenrowe.example`, startsAt }));
    expect(response.status).toBe(201);
    return { itemId: response.body.requestId as string, contactId: contact.id };
  }

  it("rejects an item once and refuses a second review", async () => {
    const page = await freshPage(h.a);
    const { itemId, contactId } = await possibleMatch(page, at(9));
    const rejected = await call(h.app, "POST", `/v1/intake/items/${itemId}/reject`, { token: h.a.token, key: randomUUID(), body: {} });
    expect(rejected.status).toBe(200);
    expect(rejected.body.result).toMatchObject({ status: "rejected", contactId: null, reviewedAt: NOW });
    const again = await call(h.app, "POST", `/v1/intake/items/${itemId}/link`, { token: h.a.token, key: randomUUID(), body: { contactId } });
    expect(again).toMatchObject({ status: 409, body: { error: { details: { reason: "already_reviewed" } } } });
  });

  it("keeps intake items inside their tenant", async () => {
    const page = await freshPage(h.a);
    const { itemId, contactId } = await possibleMatch(page, at(10));
    const listB = intakeItemPageSchema.parse((await call(h.app, "GET", "/v1/intake/items", { token: h.b.token })).body);
    expect(listB.items.map((item) => item.id)).not.toContain(itemId);
    const linkB = await call(h.app, "POST", `/v1/intake/items/${itemId}/link`, { token: h.b.token, key: randomUUID(), body: { contactId } });
    expect(linkB.status).toBe(403);
    // Tenant A cannot link its item to tenant B's contact.
    const foreign = await ownerContact(h.b, { displayName: "B", email: `b.${randomUUID().slice(0, 8)}@haldenrowe.example` });
    const cross = await call(h.app, "POST", `/v1/intake/items/${itemId}/link`, { token: h.a.token, key: randomUUID(), body: { contactId: foreign.id } });
    expect(cross.status).toBe(403);
    expect((await call(h.app, "GET", "/public/v1/pages/x/items")).status).toBe(404);
  });

  it("shows website bookings with their customer in the bookings list", async () => {
    const page = await freshPage(h.a);
    const response = await book(page.key, visitor(page.resourceId, { name: "Ines Rowe", startsAt: at(14) }));
    const list = bookingPageSchema.parse((await call(h.app, "GET", `/v1/booking/bookings?resourceId=${page.resourceId}`, { token: h.a.token })).body);
    expect(list.items).toEqual([expect.objectContaining({
      source: "website", intakeItemId: response.body.requestId,
      customer: { contactId: expect.any(String), name: "Ines Rowe", status: "new_contact" },
    })]);
    const owner = bookingPageSchema.parse((await call(h.app, "GET", `/v1/booking/bookings?resourceId=${h.a.resourceId}`, { token: h.a.token })).body);
    for (const booking of owner.items) expect(booking).toMatchObject({ source: "owner", intakeItemId: null, customer: null });
  });

  it("names the linked customer on a website booking once the owner links it", async () => {
    const page = await freshPage(h.a);
    const { itemId, contactId } = await possibleMatch(page, at(15));
    const customerOf = async () => bookingPageSchema.parse((await call(h.app, "GET", `/v1/booking/bookings?resourceId=${page.resourceId}`, { token: h.a.token })).body)
      .items.find((booking) => booking.intakeItemId === itemId)?.customer;
    expect(await customerOf()).toEqual({ contactId: null, name: "Mira Rowe", status: "possible_match" });
    const linked = await call(h.app, "POST", `/v1/intake/items/${itemId}/link`, { token: h.a.token, key: randomUUID(), body: { contactId } });
    expect(linked.status).toBe(200);
    expect(await customerOf()).toEqual({ contactId, name: "Owner Copy", status: "linked" });
  });

  it("lists the owner's pages with a working key and embed snippets", async () => {
    const page = await freshPage(h.a);
    const response = await call(h.app, "GET", "/v1/booking/pages", { token: h.a.token });
    expect(response.status).toBe(200);
    const summary = response.body.items.find((item: { id: string }) => item.id === page.pageId);
    expect(summary).toMatchObject({ published: true, resourceIds: [page.resourceId], bookingUrl: `${PUBLIC_BASE_URL}/book/${summary.publicKey}` });
    expect(verifyBookingKey({ current: KEY_SECRET }, summary.publicKey)).toEqual({ tenantId: h.a.tenantId, pageId: page.pageId });
    expect(summary.embedScript).toContain(`data-zs-booking="${summary.publicKey}"`);
    expect(summary.embedScript).toContain(`${PUBLIC_BASE_URL}/embed.js`);
    const pagesB = await call(h.app, "GET", "/v1/booking/pages", { token: h.b.token });
    expect(pagesB.body.items.map((item: { id: string }) => item.id)).not.toContain(page.pageId);
  });
});

describe("hosted page and widget assets (P-14)", () => {
  it("serves the booking page framable, with a strict CSP", async () => {
    const page = await freshPage(h.a);
    const response = await h.app.request(`/book/${page.key}`);
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors *");
    expect(csp).not.toContain("unsafe-inline");
    expect(response.headers.get("x-frame-options")).toBeNull();
    const html = await response.text();
    expect(html).toContain('src="/booker.js"');
    expect(html).not.toContain(page.key);
    expect((await h.app.request("/book/zsb1_forged")).status).toBe(404);
    for (const asset of ["/booker.js", "/booker.css", "/embed.js"]) {
      const file = await h.app.request(asset);
      expect(file.status, asset).toBe(200);
      expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("keeps public routes free of owner auth and CORS grants", async () => {
    const page = await freshPage(h.a);
    const response = await call(h.app, "GET", `/public/v1/pages/${page.key}`, { headers: { Origin: "https://evil.example" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    // An owner token adds nothing: the page key alone decides the tenant.
    const withToken = await call(h.app, "GET", `/public/v1/pages/${page.key}`, { token: h.b.token });
    expect(withToken.body.businessName).toBe("Tenant A");
  });
});

describe("abuse limits (P-10)", () => {
  let limited: ApiHarness;
  let now = Date.parse(NOW);
  beforeAll(async () => {
    limited = await createApiHarness({
      clock: { now: () => new Date(now) },
      publicIntake: {
        clientIp: { trustedProxies: ["10.0.0.0/8"] },
        limits: {
          addressWrites: { limit: 2, windowMs: 600_000 },
          addressReads: { limit: 3, windowMs: 600_000 },
          tenantWrites: { limit: 3, windowMs: 3_600_000 },
        },
        botCheck: async ({ token }) => token !== "bot",
      },
    });
  });
  afterAll(async () => limited.close());

  // Through the trusted proxy 10.0.0.1, which appends the address it saw.
  const post = (key: string, body: unknown, from: string, forwarded = `198.51.100.250, ${from}`, socket = "10.0.0.1") =>
    call(limited.app, "POST", `/public/v1/pages/${key}/requests`, { body, key: randomUUID(), headers: { "X-Forwarded-For": forwarded }, socket });
  const body = (resourceId: string, hour: number, over: Record<string, unknown> = {}) => ({
    resourceId, startsAt: at(hour), name: "Limit Test", email: `limit.${randomUUID().slice(0, 8)}@haldenrowe.example`,
    phone: null, notes: null, consent: { email: false, sms: false }, disclosureVersion: "v1", channel: "booking_page", website: "", ...over,
  });

  it("limits writes per address and per tenant, and a refusal consumes nothing", async () => {
    const page = await provisionPage(limited, limited.a);
    const resourceId = limited.a.resourceId;
    expect((await post(page.key, body(resourceId, 9), "192.0.2.1")).status).toBe(201);
    expect((await post(page.key, body(resourceId, 10), "192.0.2.1")).status).toBe(201);
    const refused = await post(page.key, body(resourceId, 11), "192.0.2.1");
    expect(refused).toMatchObject({ status: 429, body: { error: { code: "RateLimited" } } });
    expect(Number(refused.headers.get("retry-after"))).toBe(600);
    // The refused request did not count against the tenant: one more address may still write.
    expect((await post(page.key, body(resourceId, 11), "192.0.2.2")).status).toBe(201);
    // Tenant budget (3) is now spent, whatever the address.
    expect((await post(page.key, body(resourceId, 12), "192.0.2.3")).status).toBe(429);
    // Forged keys still cost the address, so key guessing is limited too.
    expect((await post("zsb1_forged", body(resourceId, 13), "192.0.2.4")).status).toBe(404);
    expect((await post("zsb1_forged", body(resourceId, 13), "192.0.2.4")).status).toBe(404);
    expect((await post("zsb1_forged", body(resourceId, 13), "192.0.2.4")).status).toBe(429);
    // A new window opens after ten minutes for the address, but the tenant hour is still spent.
    now += 600_000;
    expect((await post(page.key, body(resourceId, 13), "192.0.2.1")).status).toBe(429);
    now += 3_000_000;
    expect((await post(page.key, body(resourceId, 13), "192.0.2.1")).status).toBe(201);
  });

  it("limits reads per address, walking forwarded entries past trusted proxies only", async () => {
    const page = await provisionPage(limited, limited.a);
    // Client, then two trusted hops: 10.0.0.2 forwarded to 10.0.0.1, which is the socket peer.
    const read = (forwarded: string) => call(limited.app, "GET", `/public/v1/pages/${page.key}`,
      { headers: { "X-Forwarded-For": forwarded }, socket: "10.0.0.1" });
    for (let i = 0; i < 3; i++) expect((await read(`203.0.113.${i}, 192.0.2.50, 10.0.0.2`)).status).toBe(200);
    // A different spoofed left-most entry is still the same caller.
    expect((await read("203.0.113.99, 192.0.2.50, 10.0.0.2")).status).toBe(429);
    expect((await read("192.0.2.51, 10.0.0.2")).status).toBe(200);
    // IPv4-mapped IPv6 and a port are the same address.
    expect((await read("[::ffff:192.0.2.51]:443")).status).toBe(200);
    expect((await read("192.0.2.51:8080")).status).toBe(200);
    expect((await read("192.0.2.51")).status).toBe(429);
  });

  it("ignores X-Forwarded-For from a peer that is not a trusted proxy", async () => {
    const page = await provisionPage(limited, limited.b);
    const direct = (forwarded: string) => post(page.key, body(limited.b.resourceId, 10, { email: `direct.${randomUUID().slice(0, 8)}@haldenrowe.example` }),
      "", forwarded, "203.0.113.77");
    expect((await direct("192.0.2.70")).status).not.toBe(429);
    // Changing only the header does not buy a fresh quota: the socket address is the caller.
    expect((await direct("192.0.2.71")).status).not.toBe(429);
    expect((await direct("192.0.2.72")).status).toBe(429);
  });

  it("puts every address of one IPv6 /64 in one bucket", async () => {
    const page = await provisionPage(limited, limited.b);
    const read = (socket: string) => call(limited.app, "GET", `/public/v1/pages/${page.key}`, { socket });
    for (let i = 1; i <= 3; i++) expect((await read(`2001:db8:1:2::${i}`)).status).toBe(200);
    expect((await read("2001:db8:1:2:ffff:ffff:ffff:ffff")).status).toBe(429);
    expect((await read("2001:db8:1:3::1")).status).toBe(200);
  });

  it("refuses a request the bot check rejects", async () => {
    const page = await provisionPage(limited, limited.b);
    const response = await post(page.key, body(limited.b.resourceId, 9, { botToken: "bot" }), "192.0.2.60");
    expect(response.status).toBe(400);
  });
});
