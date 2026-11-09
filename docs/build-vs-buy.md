# Build vs buy: paid tools the hub uses

Goal (Devin, 2026-11-08): self-build as much of the ZS Hub stack as we can, so the hub can
charge for it later. This file lists every paid tool the hub uses, what it costs us each
month, and whether we could build it ourselves.

Read on 2026-11-08. "Checked" means a bill, a billing API or a dashboard confirmed the plan.
"List price" means the plan is confirmed but the amount is the vendor's public price, not a
bill. "Unverified" means nobody has checked the bill yet.

## Table

| # | Tool | What the hub uses it for | Monthly cost | Source | Build it? | Rough effort | Decision |
|---|---|---|---|---|---|---|---|
| 1 | Smartlead | Cold outreach sequences from the 2 outreach mailboxes | ~$39 (Basic), month 1 only | Unverified (no bill yet) | Yes: hub sequencer that sends through the Gmail API from both inboxes, with a daily cap per inbox, follow-up steps, stop on reply and the hub's existing unsubscribe | 1–2 weeks (contract, Gmail OAuth per mailbox, scheduler worker, reply poll, tests) | **Build.** Cancel Smartlead when the hub sequencer matches it. Warm-up stays manual (low volume). |
| 2 | Google Workspace, outreach (zerosum-solutions.com) | 2 sending mailboxes: devin@ and devin.wiggins@ | ~$16.80 (Business Starter Flexible, 2 users) | Devin's plan choice, 2026-11-08; no bill yet | No. A real Google mailbox carries the sender reputation | — | **Buy.** Kept paid for deliverability. |
| 3 | Google Workspace, main (zerosumsolutions.com) | Devin's main mail, calendar, Drive | Unverified (current balance $22.00 due) | Billing page, 2026-11-08 (balance only) | No | — | **Buy.** |
| 4 | Vercel | Hosts api, dashboard and workers projects | $20 per seat (Pro) | Plan checked via Vercel API (team `devin-wiggins-projects` = pro); amount is list price, usage overage unverified | Partly: a self-hosted Node box could run Hono and Next.js, but we lose preview deploys, cron and the CDN | 1–2 weeks plus ongoing ops | **Buy.** Ops time costs more than the plan. Revisit if usage overage appears. |
| 5 | Supabase | Postgres (prod + preview), Auth, backups | $25 org base (Pro) with $10 compute credit; zs-business adds 2 Micro instances (~$10 each) | Plan checked via Management API (org Zerosumsolutions-Projects = pro); amounts are list price. The org also hosts 7 other projects, so the bill is shared | Partly: self-hosted Postgres plus GoTrue | 2–3 weeks plus backups, upgrades, on-call | **Buy.** RLS, Auth and managed backups are core. PITR ($100/mo) was declined 2026-11-08. |
| 6 | Resend | Transactional email (auth mail, delivery outbox) from mail.zerosumsolutions.com | Unverified; likely Pro $20 (2 verified domains exceeds Free's 1) | Domain list checked via API; plan and bill unverified | Partly: direct SMTP through a cheaper relay (for example Amazon SES) | 3–5 days (adapter is already behind a port) | **Buy for now.** Revisit when per-tenant sending domains push the plan tier up (`integrations.md` open question 4). |
| 7 | Composio | Long-tail tenant connections (Shopify first) | $29 (pilot) | Devin approved $29/mo on 2026-11-06; bill unverified | Yes for each core service (own OAuth apps); no for the long tail | Per service: 3–5 days | **Buy for the long tail; build core services.** Shopify already starts a native install (C-18). |
| 8 | Stripe | Hub subscriptions and tenant billing | 2.9% + $0.30 per card charge, no monthly fee | List price; live account active since 2026-11-07, no volume yet | No (payments licence, PCI) | — | **Buy.** |
| 9 | Cloudflare | DNS for zerosum-solutions.com; registrar | ~$0.93 ($11.17/yr for zerosum-solutions.com) | Registrar renewal checked 2026-11-08; zerosumsolutions.com registrar unverified | No | — | **Buy.** Free DNS plan. |
| 10 | Treg | Company enrichment (pay per call) | Usage only; $5 balance alert, no auto top-up | Price per call unverified (no live call yet) | Partly: scrape public company pages ourselves | 1–2 weeks, and data quality is worse | **Buy** while volume is low; the tenant wallet pays per call. |
| 11 | Apollo | Lead lists for outreach | Unverified | No bill found | Partly: Google Maps Places search plus enrichment | 1–2 weeks | **Unverified.** Price it before month 2. |
| 12 | Model lanes (Cerebras, DeepSeek Flash) | Tenant drafts and summaries | Usage only, prepaid | Unverified | No (inference) | — | **Buy.** Billed to tenant wallets. |

## Totals (fixed monthly, month 1)

About $146 a month with Smartlead, about $107 after the hub sequencer replaces it:
$39 + $16.80 + $20 + ~$20 (Supabase, 2 Micro) + ~$20 (Resend, if Pro) + $29 + $0.93.
This counts rows 1, 2, 4, 5 (zs-business share), 6, 7 and 9. It leaves out row 3, usage-based
rows (8, 10, 12) and unverified Apollo. Replace list prices with bill amounts as they are
checked.

## Next to check

- Resend plan and bill (dashboard, Billing).
- Vercel usage overage on the last invoice.
- Apollo: is there a paid seat, and what does it cost.
- Smartlead: the real plan once Devin signs up.
