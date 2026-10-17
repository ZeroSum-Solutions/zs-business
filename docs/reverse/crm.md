# F2 CRM transaction slice: evidence, obligations and gaps

Authority: `docs/requirements/crm.md` (rules C-1 to C-24). Where a source behaves
differently, the code follows the requirement; the differences are listed in section 3.

## 1. What was studied, and from where

No outside code was copied or ported. Every source below informed scope or a "do not
copy" decision only.

| Source | Pinned at | What it showed |
| --- | --- | --- |
| HighLevel feature map, `/Users/zero-suminc./Inbox/notes/_unassigned/2026-10/2026-10-17-highlevel-help-docs/highlevel-feature-map.md` | note dated 2026-10-17 | Lines 10-11: contacts are the central object of a client account; opportunities sit in pipelines with stages, and one contact can have many. Line 16: account snapshots carry pipelines as configuration but never contacts, so pipeline/stage setup is configuration, separate from customer records. This set our scope: contact identity plus deals in pipeline stages, with pipeline/stage provisioning out of scope (C-13, C-20). |
| HighLevel teardown, `/Users/zero-suminc./Inbox/notes/_unassigned/2026-10/2026-10-17-highlevel-teardown.md` | note dated 2026-10-17 | Lines 10-11 list contacts and opportunities/pipelines as separate product areas. Behaviour only. |
| HighLevel calendar help page, same folder, `help.gohighlevel.com-2548190608.md` | fetched 2026-10-17 | Lines 219-220: consent capture is a separate, optional input on a booking form. Supports storing consent as its own evidence record, never inferred from an address (C-9). |
| Activepieces HubSpot piece, `/Users/zero-suminc./projects/tools/third-party/activepieces/packages/pieces/community/hubspot/src/lib/actions/create-or-update-contact.ts` | `860ce5b8` | Lines 16-18, 30-60: the upsert is keyed on email only and overwrites the found contact's properties. Contact-field shape only. |
| Activepieces Pipedrive piece, `.../pipedrive/src/lib/actions/create-person.ts` | `860ce5b8` | Lines 39-81: a person carries arrays of emails and phones; the action is not idempotent and warns callers to guard against duplicates. |
| Activepieces Pipedrive piece, `.../pipedrive/src/lib/actions/update-deal.ts` | `860ce5b8` | Lines 59-60: a deal update sets `pipeline_id` and `stage_id` directly, with no revision check. |
| SeldonFrame at `http://localhost:3000` | not revisited | The requirement already records that a 2026-10-17 visit reached only sign-in. No source, bundle or script was opened; no REA tools were run against it. |

No REA evidence ids exist for this slice: no browser scenario was captured.

## 2. Obligation ledger

Paths: `contact.ts`, `deal.ts`, `rows.ts` and `index.ts` are under `packages/core/src/crm/`;
the migration is `supabase/migrations/20261017170100_crm.sql`; tests are under
`packages/core/test/crm/` (`contact.acceptance` = `contact.acceptance.test.ts`, and so on).

| Rule | How the code meets it | Proof |
| --- | --- | --- |
| C-1 tenant scope | Every query filters on the dispatcher tenant and runs under RLS (`contact.ts:58-63`, `deal.ts:22-31`). Creation scope = tenant row visible (`rows.ts` `tenantVisible`). IDs are per-tenant via PK `(tenant_id,id)` (migration:30, 77). | `contact.acceptance:87`, `deal.acceptance:51`, `deal.acceptance:64` |
| C-2 email normalization | Frozen `contactEmailInputSchema` parsed in the wrapper (`index.ts:26`) and again in the handler (`contact.ts:143`). DB check mirrors canonical form (migration:22-26). | `public.test:20`, `contact.acceptance:18`, `contact.acceptance:106` |
| C-3 phone | Frozen `contactPhoneSchema`; DB check (migration:27); at least one identity (migration:31). | `contact.acceptance:106` |
| C-4 boundary and error order | Wrapper `safeParse` before dispatch (`index.ts:26,30,34`). Handler order: schema (`contact.ts:143`), future evidence (`contact.ts:144-146`), split (`contact.ts:73`), mismatch (`contact.ts:78`), id_in_use (`contact.ts:81`), consent merge (`contact.ts:107-112`). | `contact.acceptance:95`, `contact.acceptance:106` |
| C-5 no match | Insert with the candidate ID (`contact.ts:88`); existing unrelated candidate → `id_in_use` (`contact.ts:80-81`). | `contact.acceptance:18`, `contact.acceptance:73` |
| C-6 one match | Return matched ID, no spare row; fill only absent identity/name (`contact.ts:98-105`); `identity_mismatch` (`contact.ts:76-78`). | `contact.acceptance:31`, `contact.acceptance:66`, `contact.acceptance:73` |
| C-7 split identity | `contact.ts:72-73`, thrown before any write; the dispatcher transaction rolls back. | `contact.acceptance:51`, `public.test:42` |
| C-8 concurrent claims | Partial unique indexes (migration:33-36). Sorted advisory locks per email/phone/candidate key (`contact.ts:48-56`), rows read `FOR UPDATE`, attempt wrapped in a `SAVEPOINT` with `ROLLBACK TO SAVEPOINT` and re-read on `23505` (`contact.ts:149-160`). No whole-transaction retry, no re-dispatch. | `contact.acceptance:156` |
| C-9 stored consent | Separate `crm_contact_consent` table with enums and source length (migration:38-47). Absent row renders `null` (`rows.ts` `contactRecord`). | `contact.acceptance:118`, `contact.acceptance:132` |
| C-10 import | `shouldWriteConsent` returns false for any existing channel in import mode (`contact.ts:38`); null channels are filled. | `contact.acceptance:118`, `contact.acceptance:146` |
| C-11 interactive | Later wins, older ignored, equal instant → denial wins, identical keeps provenance (`contact.ts:39-44`). Compared in microseconds so sub-millisecond stored values compare exactly (`rows.ts` `loadConsent`). | `contact.acceptance:132`, `contact.acceptance:146` |
| C-12 timestamps | Injected `now` for create (`contact.ts:88-91`); `updated_at` bumped only when something changed (`contact.ts:103-121`). | `contact.acceptance:31` |
| C-13 create deal | Parent ownership first → `TenantDenied` (`deal.ts:44-49`), then stage membership → `ValidationFailed` (`deal.ts:50-51`), insert revision 1 (`deal.ts:53`). | `deal.acceptance:38`, `:44`, `:51`, `:64` |
| C-14 compare-and-set | Ownership → pipeline/stage membership → conditional `UPDATE ... AND revision=$5` (`deal.ts:86-101`); zero rows → `Conflict{reason:"stale_revision",currentRevision}` re-read from owned state (`deal.ts:102-107`). | `deal.acceptance:90`, `deal.acceptance:107`, `public.test:77` |
| C-15 successful move | Same-pipeline only (`deal.ts:93-96`); `revision+1`, `updated_at=now`, other fields kept; overflow guard in SQL (`deal.ts:99`) and CHECK (migration:75). | `deal.acceptance:78`, `deal.acceptance:149` |
| C-16 concurrent moves | The conditional UPDATE re-checks `revision` after the row lock is released (READ COMMITTED). Replays come from the dispatcher's stored result. | `deal.acceptance:126`, `deal.acceptance:138` |
| C-17 one write path | Wrappers parse, call `ctx.dispatch` once, validate the envelope (`index.ts:24-36`). Errors propagate unchanged. | `public.test` (all six), `contact.acceptance:106` |
| C-18 target verification | Contact resolver: tenant scope, no payload (`contact.ts:135-139`). Deal create resolver throws `id_in_use` for an owned existing ID (`deal.ts:34-40`); post-resolution PK race keeps SQL details and adds the reason (`deal.ts:59-65`). Move resolver loads the owned deal or returns null (`deal.ts:79-83`). | `contact.acceptance:73`, `deal.acceptance:64`, `deal.acceptance:107` |
| C-19 atomic history | All state writes use the dispatcher `tx`; typed errors throw before `record_action_and_event`, so nothing commits. | `contact.acceptance:51`, `deal.acceptance:90` |
| C-20 schema | `supabase/migrations/20261017170100_crm.sql`, mirrored in `packages/db/src/schema/crm.ts`. | `contact.acceptance:184`, `integration.test:7` |
| C-21 RLS and isolation | Enabled + forced RLS, tenant policy, revoke from PUBLIC (migration:86-101). Runtime gets column-limited UPDATE and no DELETE (migration:105-111). | `packages/db/test/isolation.test.ts` (catalog-driven, now covers all five tables), `contact.acceptance:174`, `contact.acceptance:184` |
| C-22 public tests | All seven public tests pass unchanged. | `public.test`, `integration.test` |
| C-23 handler export | `crmHandlers` has exactly the three keys (`index.ts:17-21`) and is re-exported from `packages/core/src/index.ts`. | `integration.test:7` |
| C-24 seed/read contract | Column types and nullability as listed; no extra NOT NULL columns; service role has full access, runtime may INSERT contacts. | `integration.test:7`, `contact.acceptance:174` |

## 3. Desired vs upstream

- **Email-keyed upsert that overwrites (HubSpot piece).** We match on email or phone,
  never overwrite a stored non-null identity or name, and raise `identity_mismatch` /
  `split_identity` instead of choosing a winner (C-6, C-7).
- **Multiple emails/phones per person (Pipedrive piece).** We store one normalized email
  and one E.164 phone per contact, because the frozen contract has one of each and
  uniqueness is per tenant (C-8, C-20).
- **Non-idempotent creates (Pipedrive piece).** Every write is an approved, idempotent
  dispatcher action; a candidate ID never creates a duplicate row (C-5, C-17).
- **Stage change without a revision check (Pipedrive `update-deal`).** We use
  compare-and-set on `revision` and forbid moving a deal between pipelines (C-14, C-15).
- **Consent as a form checkbox (HighLevel).** We store per-channel evidence with source
  and time, never derive permission, and keep import conservative (C-9 to C-11).

## 4. Licence notes

No code from any MIT source was ported or copied, so no file carries an MIT header and
`NOTICE` is unchanged. HighLevel material was used for behaviour only; none of its
wording appears in code or docs. SeldonFrame source, bundles and scripts were not opened.

## 5. Known gaps and decisions

- **Placeholder default on `crm_contacts.normalized_email`.** The frozen catalog-driven
  isolation fixture inserts only NOT NULL columns, which would violate the
  at-least-one-identity CHECK. The column therefore defaults to a unique address on the
  reserved `.invalid` TLD. It fires only when an INSERT omits the column; the handler and
  the C-24 runtime insert always list it, and an explicit NULL still hits the CHECK.
- **Direct dispatch of an unnormalized payload.** The handler re-parses with the frozen
  schema, so a raw email sent straight to the dispatcher is normalized before matching,
  while the approval binding is still the raw payload the caller approved. The wrappers
  always parse first (C-4), so this only affects callers that skip them.
- **Sub-millisecond consent times.** Our writes are millisecond values. A row seeded with
  microseconds compares exactly, but renders truncated to milliseconds in the API.
- **Advisory-lock keys hash to 64 bits.** A collision only serializes two unrelated
  claims; it cannot merge them.
- **Not covered:** contact merge, general contact edit, pipeline/stage provisioning
  actions, messaging. These are out of scope for F2 by the requirement.
- **Booking composition** (`{ ...bookingHandlers, ...crmHandlers }`) was not tested here
  beyond the public integration template, because booking handlers are not implemented in
  this branch.
