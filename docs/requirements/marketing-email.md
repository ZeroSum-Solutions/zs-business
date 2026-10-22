# Marketing email

Status: draft contract, not built (2026-10-22). Code follows this file once its first slice
lands; a change to a numbered rule needs a new revision of this file first. This is a deferred
contract: no slice starts until all of these hold:
- each tenant that sends marketing has its own verified sending domain (M-2), which needs the
  open question on per-tenant Resend domains settled (`docs/integrations.md`, open question 4);
- the business profile with its postal address is built (`business-profile.md` BP-1);
- `delivery.md` revision 5 is built: D-6 and D-9 (marketing-only unsubscribe) and D-11.

Scope: an owner sends one approved newsletter (a campaign) to a frozen list of consenting
customers. Each recipient becomes one ordinary `message.send_requested` event with purpose
`marketing` (`delivery.md` D-1), so consent, suppression, approval re-check, wallet reservation
and exactly-once settlement all come from the delivery outbox. This contract adds what bulk
mail needs on top: a verified sender per tenant, an audience snapshot, a legal footer, pacing
that never delays booking mail, and a pause when bounces or complaints climb. Owner areas:
Customers (campaigns) and Account (sending domain).

Out of scope: running Listmonk or any other newsletter server; drip sequences and automations;
HTML templates (Resend sends `text` only, `resend.md` R-4); open and click tracking; A/B
tests; SMS marketing; importing outside mailing lists (imported consent follows `crm.md` C-10
only).

## Evidence and decisions

- Listmonk is not run (AGPL, no tenant isolation); decided 2026-10-22 (supervisor brief). We
  build our own marketing email on the delivery outbox; decided 2026-10-22 (coordinator,
  standing approval).
- Native newsletters are deferred until each tenant has its own verified sending domain;
  decided 2026-10-22 (coordinator, standing approval).
- Marketing one-click unsubscribe stops marketing email only and keeps booking emails;
  `delivery.md` D-6 and D-9 (revision 5) carry the rule; decided 2026-10-22 (coordinator,
  standing approval).
- Research report R5, part 1 (public docs and product pages only, never source; in our own
  words). Behaviour worth rebuilding: an audience that is frozen when the owner approves;
  bulk sending paced under the provider's rate limit while transactional mail goes first; an
  automatic pause when a campaign's bounce or complaint rate trips a threshold; a footer the
  system adds with the business name, its postal address and an unsubscribe link.
- Why not run Listmonk unmodified: it has no `tenant_id` or RLS (`AGENTS.md`), keeps its own
  subscriber and opt-out lists apart from `crm_contact_consent` and `suppressions`, does not
  reserve from the wallet (D-4, D-5) and cannot re-check an approval at send time
  (`approvals.md` A-10).
- Provider facts as the research report read Resend's public docs (recheck when the first
  slice starts): a domain moves through `not_started`, `pending`, `verified`,
  `partially_verified` and `failed`; its acceptable-use rules ask for explicit opt-in and low
  bounce and complaint rates; the default rate limit is about 10 requests a second per team.
- Today one `RESEND_FROM` sends for every tenant (`resend.md` R-6 and its Known limits).
  Marketing never uses it (M-3).

## Numbered rules

**M-1. The gate.** `marketing.campaign.send` runs only while the tenant has a `verified` row
in `tenant_email_domains` (M-2) and a non-null `business_profiles.postal_address`
(`business-profile.md` BP-1). Otherwise it fails `ValidationFailed` with
`details.reason` `domain_not_verified` or `postal_address_missing` and commits nothing. The
delivery worker re-checks the domain for every `marketing` attempt in the D-6 transaction: a
domain that is no longer `verified` blocks the delivery `domain_not_verified` and releases its
reservation. `domain_not_verified` and `campaign_paused` (M-10) join the delivery block
reasons.

**M-2. Sending domains.** `tenant_email_domains` holds one row per tenant domain: `domain` (a
subdomain the tenant owns, such as `news.example.com`), `provider`, `provider_domain_id`,
`status` (the five provider states above), the DNS records to publish (`dns_records` jsonb),
`checked_at` and `verified_at`. `email.domain.add` and `email.domain.check` need the
`integrations` permission (owners). They call the `EmailDomainProvider` port
(`createDomain`, `getDomain`); the Resend adapter and a fake implement it, and
`pnpm -r test` uses only the fake. The owner publishes the DNS records; no agent changes DNS.
A check that finds a domain still not `verified` 72 hours after `email.domain.add` sets it
`failed`.

**M-3. The sender.** A marketing delivery is sent `from` an address on the tenant's verified
domain, stored in the delivery's request at the first attempt (D-8). The adapter refuses a
`marketing` request that names no tenant sender (`rejected`, `marketing_sender_missing`), so
a marketing email never leaves from the shared `RESEND_FROM`. Transactional mail is unchanged.

**M-4. Audience snapshot.** A campaign's audience is either every contact or the contacts with
an open deal in one named stage. When the owner requests approval, the server writes
`marketing_campaign_recipients` (campaign, contact, address) for each contact that, at that
moment, has email consent `granted`, a usable address (`usableEmail`), no suppression row of
any reason, and an address whose local part is not a role name (`abuse`, `postmaster`,
`noreply`, `no-reply`, `mailer-daemon`). The snapshot is frozen: later contacts are not added.
A campaign holds at most 2,000 recipients; a larger audience fails `ValidationFailed`
(`audience_too_large`). The D-6 checks still run for every recipient at delivery, so a consent
withdrawn after the snapshot blocks that send. Each `message.send_requested` carries the
snapshot address, and a marketing delivery goes only to that address: when the contact's
current address differs, the delivery blocks `address_changed` (`delivery.md` D-6) and is
never sent to the new address. A test changes a recipient's address between approval and the
first attempt and checks that nothing is sent to either address.

**M-5. Content and footer.** A campaign has a one-line subject and a plain-text body. The
server appends the footer when the approval is requested: the business display name, the
postal address from BP-1 and the fixed placeholder `{{unsubscribe_url}}`. The approved body,
and the digest the approval binds (M-6), include the footer with the placeholder, so a later
edit of the postal address does not change an approved campaign. The delivery worker replaces
the placeholder with that delivery's own D-9 token URL after the approval check (`delivery.md`
D-6); the placeholder is the only text it may change. A test sends to three recipients and
checks three distinct URLs, each of which unsubscribes only its own address. `marketing.campaign.send` refuses a campaign whose stored body does not end with the
footer it built (`footer_missing`).

**M-6. Planner and executor.** `marketing.campaign.draft` (permission `customers`) creates or
edits a `draft` campaign; an agent may call it as a planner but never sends. `marketing.campaign.send`
is in `APPROVAL_POLICIES` with `{ request: "customers", required: true }` (`approvals.md` A-9),
so it runs only through an approved request (A-7). The approval binds the campaign ID, the
subject, the SHA-256 digest of the body with footer, the recipient count, the digest of the
recipient list and the estimated cost; the approver sees all of them (A-12). Once approved,
the action commits one `message.send_requested` per recipient with purpose `marketing` in one
transaction, and the campaign becomes `sending`.

**M-7. Wallet.** The estimated cost is recipient count × the email price (D-5). The send
action fails `insufficient_funds` when the wallet's available amount is below it at run time,
and commits nothing. This check reserves nothing: each delivery still reserves its own price
under D-5 and D-11 (kind `message_delivery`), so a wallet that runs dry mid-campaign stops the
rest as D-5 says.

**M-8. Pacing.** Each worker run claims due `transactional` deliveries first. Marketing
deliveries are claimed after them, at most `MARKETING_SEND_RATE` per second per provider
account (default 2, never above 5). A test commits 20 marketing and 1 transactional delivery
due at the same instant and proves the transactional one is sent first.

**M-9. Unsubscribe.** Every marketing email carries the D-9 `List-Unsubscribe` and
`List-Unsubscribe-Post` headers and the visible footer link. A valid one-click POST records
`marketing_unsubscribe` (D-9, revision 5). D-6 then blocks every later marketing delivery to
that address, including the rest of a campaign in flight, and lets booking notices and replies
through.

**M-10. Hygiene pause.** After at least 50 of a campaign's deliveries have settled, a permanent
bounce rate of 3 % or more, or a complaint rate of 0.05 % or more (`resend.md` R-8 events),
sets the campaign `paused_hygiene`. Its deliveries not yet attempted end blocked
`campaign_paused` and release their reservations. A paused campaign never resumes; the owner
drafts a new one, which needs a new approval.

**M-11. Tenancy and retention.** `tenant_email_domains`, `marketing_campaigns` and
`marketing_campaign_recipients` have `tenant_id`, forced RLS and the tenant policy, are in the
catalog isolation test, and have a two-tenant denial test under the runtime role. Drafts never
sent are deleted 90 days after their last edit. Sent campaigns, recipient rows, deliveries,
consent and suppression rows are kept.

## First slice

Sending domain and the send gate, with the queue split; nothing reaches a real provider.
`packages/core/test/marketing/domain-gate.test.ts` against real Postgres and the fake
`EmailDomainProvider` proves: `marketing.campaign.send` for a tenant with a `pending` domain
fails `domain_not_verified` and commits no outbox row; after the fake reports `verified` and a
postal address is saved, an approved campaign of three consenting contacts commits three
`marketing` events; a contact with a `marketing_unsubscribe` row is left out of the snapshot
yet still gets a transactional reply; 20 marketing and 1 transactional deliveries due together
settle the transactional one first; and tenant B cannot read tenant A's domain or campaign.

## Known limits

- No Resend plan upgrade or spend is decided here. Per-tenant domains likely exceed the
  current plan's domain count; plan tier and who owns each tenant's DNS stay open
  (`docs/integrations.md`, open question 4).
- The bounce and complaint thresholds in M-10 are ours, set below the provider's published
  limits as the research report read them; they are not tuned on real traffic.
- Audience filters are coarse (all, or one deal stage). CRM has no tags yet.
- Plain text only; no tracking of opens or clicks.
- The 2,000-recipient cap keeps one approval's outbox write in one transaction; larger lists
  need batching and a new revision.
