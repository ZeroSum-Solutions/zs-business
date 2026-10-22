# How outside projects join zs-business

Status: decided 2026-10-22. This file is the spec list: each project below gets one
decision, one owning dashboard area and one draft contract in `docs/requirements/`. The
"Decided by" column says where each decision came from: "coordinator" means decided
2026-10-22 (coordinator, standing approval); "supervisor" means decided 2026-10-22
(supervisor brief), a gap the coordinator's decisions did not cover. A contract marked "not
built" describes work that has not started; code follows it once its first slice lands. A
change to a decision needs a new revision of this file first.

## Rules every integration follows

- zs-business stays the system of record and the only path to side effects: approval,
  idempotency key and outbox, as `approvals.md` and `delivery.md` already require.
- Python tools run as separate services behind typed HTTP ports. Each port has a TypeScript
  fake, so `pnpm -r test` needs no Python, no network and no vendor key.
- Each integration has its own server-built principal with only the actions it needs
  (`agents.md` G-1 pattern). A transcription worker cannot read slots; an enrichment actor
  cannot send.
- Planners are separate from executors. Anything that posts, sends, calls or clicks only runs
  an approved, committed command, and re-checks the approval when it runs (`approvals.md` A-10).
- Tenant isolation reaches outside Postgres: files, scratch folders, audio, browser profiles
  and caches are keyed by the server-derived tenant and covered by a two-tenant denial test.
- Untrusted input (calls, PDFs, web pages, model output) is data, never instructions. An
  approver sees the real payload (`approvals.md` A-12).
- Spend goes through the prepaid wallet: reserve before the vendor call, capture once, release
  the rest (`delivery.md` D-4, D-5 and D-11 for any other priced job).
- Workers that run on the pilot Mac pull jobs from the API over HTTPS with a scoped token. The
  Mac exposes no inbound port, except where a contract says otherwise.
- No Shopify, Lightspeed or business Gmail connection until the owner of this repo approves
  it. No client names or client data in this public repo; the demo tenant is the invented
  "Halden & Rowe".

## Model lanes for tenant work

Decided 2026-10-22 (coordinator, standing approval), within the vendors already approved:

| Work | Lane | Why |
|---|---|---|
| Text that may hold a customer's personal data (drafts, summaries, extraction) | Cerebras (prepaid, US) | DeepSeek is not used for personal data; the personal Gemini key is not used for client traffic |
| Text with no personal data (SEO notes, template wording, test fixtures) | DeepSeek Flash | Cheapest approved lane |
| Vision on pages or images that may hold personal data | none yet | Needs a business-billed Gemini project: an open question, so vision tasks wait |
| Subscription lanes (Claude Max, Codex, Higgsfield credits) | never for tenant production traffic | Higgsfield credits serve development only |

## Decisions and contracts

| Project | Decision | Decided by | Owner area | Contract |
|---|---|---|---|---|
| Business profile (audit U2 follow-up) | Build: name, legal name, time zone, currency, postal address | coordinator (V-20, spec list) | Account | [business-profile.md](requirements/business-profile.md) |
| Booking customer link (audit U2-7) | Build: link a contact to an owner-made booking, outside `booking.create` | supervisor | Calendar | [booking-customer.md](requirements/booking-customer.md) |
| Agent kinds and real model (M6 extension; Paperclip ideas only) | Build: `agent_kind`, usage and cost caps, model adapters for the lanes above, templated reminders with a standing template approval | coordinator (lanes, template approval); supervisor (Paperclip ideas) | Agents | [agents.md](requirements/agents.md) G-14..G-21, [approvals.md](requirements/approvals.md) A-15 |
| Wallet spend beyond messages | Build: reservations for any priced job, not only deliveries | supervisor | Account | [delivery.md](requirements/delivery.md) D-11 |
| Missed-call text-back (before any voice AI) | Build: press 1 to opt in, then text the booking link | coordinator | Inbox | [twilio.md](requirements/twilio.md) T-10..T-14 |
| Treg (lead enrichment) | Build: company enrichment only, fixed price per call, archive off, org-scoped token, $5 balance alert | coordinator | Customers | [enrichment.md](requirements/enrichment.md) |
| Docling (document intake) | Build: PDF first, rows approved as one diff | coordinator (PDF first); supervisor (one diff) | Site (catalog), Agents | [document-intake.md](requirements/document-intake.md) |
| WhisperX (transcription) | Build: local Mac worker, pyannote licence accepted as a setup step | coordinator | Inbox | [transcription.md](requirements/transcription.md) |
| Image port (Higgsfield now, ComfyUI later) | Build: Kie.ai or FAL in production billed to the tenant wallet, Higgsfield in development, product pixels locked | coordinator | Site | [image-port.md](requirements/image-port.md) |
| Browser Use (website tasks) | Build later: read-only tasks first, runner on the pilot Mac | coordinator | Agents | [browser-tasks.md](requirements/browser-tasks.md) |
| Pipecat (voice receptionist) | Build after missed-call text-back proves call volume: local STT/TTS plus Cerebras | coordinator (local plus Cerebras); supervisor (order) | Agents, Inbox | [voice-receptionist.md](requirements/voice-receptionist.md) |
| Listmonk (newsletters) | Do not run it (AGPL, no tenant isolation). Defer; then build our own on the delivery outbox once each tenant has its own sending domain | coordinator (defer, build native); supervisor (not run) | Customers, Account | [marketing-email.md](requirements/marketing-email.md) |
| Postiz (social scheduling) | Do not run it (AGPL). Defer; then build one official-API publisher, Google Business Profile first | supervisor | Site | [social-publishing.md](requirements/social-publishing.md) |
| Paperclip | Not the client runtime; no agent org chart. Ideas only (cost ledger, budget stop, run events, watchdog), written fresh | supervisor | Agents | [agents.md](requirements/agents.md) |
| ComfyUI | Later adapter behind the image port, run unmodified as a separate service | supervisor | Site | [image-port.md](requirements/image-port.md) |
| Nosto and Discovery | Future product for stores with a catalog; waits for a pilot store and an approved store connection | earlier ([future/discovery.md](future/discovery.md)) | Site | [future/discovery.md](future/discovery.md) |
| Claude financial-services | Out | supervisor | — | — |

## Build order

Each step's first slice lands with its acceptance test before the next step starts, except
where steps share no files.

1. Business profile, then booking customer link. Small, and later steps read the profile's
   currency, time zone and postal address.
2. Wallet D-11, agent kinds (G-14..G-21) and the standing template approval (A-15). Every
   priced or agent-run feature below needs them.
3. Missed-call text-back. It costs no AI and measures call volume.
4. Enrichment (company only).
5. Document intake (PDF). It feeds the `document_intake` agent kind.
6. Transcription on the pilot Mac.
7. Image port with the Kie.ai or FAL adapter.
8. Browser tasks, read-only, on the pilot Mac.
9. Voice receptionist, once missed-call text-back shows the volume and the inbound media
   stream has a host (open question below).
10. Marketing email and social publishing, deferred until per-tenant sending domains and the
    Google Business Profile API access exist.

## Setup steps the repo owner runs (no agent account actions)

- Treg: turn the team's public answer archive off; mint an org-scoped agent token with a
  per-call cap and store it in the vault; set the $5 balance alert. No auto top-up.
- Hugging Face: accept the `pyannote/speaker-diarization-community-1` gate (CC-BY-4.0) and
  store a read-only token in the vault, before the transcription worker's first run.
- Kie.ai and FAL keys for production image jobs come from the vault; Higgsfield stays signed
  in on development machines only.
- Google Business Profile Basic API Access form: submitted only when social publishing starts.

## Open questions (not decided here)

1. Real-time voice needs an inbound WebSocket from Twilio to the Pipecat service. On the pilot
   Mac that needs a tunnel or a hosted box; both are new vendors or new spend.
2. Vision for browser tasks and image checks needs a business-billed Gemini project.
3. GDPR review before any enrichment of EU or UK contacts.
4. Per-tenant Resend sending domains: plan tier and DNS ownership per tenant.
