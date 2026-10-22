# Social publishing

Status: draft contract, not built (2026-10-22). Code follows this file once its first slice
lands; a change to a numbered rule needs a new revision of this file first. This is a deferred
contract: no slice starts until all of these hold:
- the repo owner has submitted the Google Business Profile API access form and Google has
  granted the project a non-zero quota (a setup step in `docs/integrations.md`);
- the Google OAuth client may ask for the `business.manage` scope (Google's app verification
  for that scope is done);
- the tenant media store of `image-port.md` (`media_assets`, IM-3) is built, for post photos.

Scope: an owner, or an assistant acting as a planner, drafts a post for the business's Google
Business Profile; the owner approves it; a worker publishes it at the scheduled time, once,
and only if the approval and the connection still stand. One platform, one official API. Owner
areas: Site (Posts) and Account, Connections.

Out of scope: running Postiz or any other social scheduler; Instagram, Facebook and other
platforms (each needs its own revision); scraping or browser automation of social sites;
replies to reviews; analytics; generated images (`image-port.md` may feed a draft, but this
contract only takes a file the tenant already owns).

## Evidence and decisions

- The first social platform is Google Business Profile; decided 2026-10-22 (supervisor brief).
  It serves local small businesses directly, publishes in one call, and reuses the Google OAuth
  and token sealing of `google-calendar.md` G-1..G-5.
- Postiz is not run; decided 2026-10-22 (supervisor brief). It is AGPL; it would add its own
  scheduler, queue and database with no `tenant_id` or RLS, hold tokens outside our sealing
  (G-3), and publish without our approval re-check (`approvals.md` A-10). We build one
  official-API publisher ourselves.
- The free Google Business Profile API access form is a setup step the repo owner submits only
  when social publishing starts; decided 2026-10-22 (supervisor brief). No agent submits it.
- Research report R5, part 2 (public docs and product pages only, never source; in our own
  words). Behaviour worth rebuilding: a check of text length, photo format and link before
  approval is asked; one calendar view of draft, waiting, scheduled and published posts with
  their live links; provider errors turned into a few states an owner can act on.
- Provider facts as the research report read Google's public docs (recheck when the first
  slice starts): posts are created per location under the v4 `localPosts` resource; a new
  project has a quota of zero until the access form is approved; a production refresh token
  has no set expiry but lapses after long disuse; the create call takes no idempotency key.
- Google's API is free per call. Social publishing reserves nothing from the wallet; a later
  platform that charges reserves under `delivery.md` D-11 with a new job kind.

## Numbered rules

**SP-1. Connecting.** The connect flow is `google-calendar.md` G-1 and G-2 with its own names:
`POST /v1/social/google/connect`, a signed state under its own secret
(`SOCIAL_STATE_SECRET`), the browser-binding cookie `zs-social-connect`, a staged grant
`zgs1.<body>.<tag>` in the `zs-social-grant` cookie, and `POST /v1/social/google/confirm
{ grantId }`, which runs `social.connection.connect` under the reserved key
`oauth-gbp:<connection id>`. Scopes: `openid email` and `business.manage`. All need `publish`
(owners). After confirm the owner picks one location; the connection stores its account and
location IDs. Every G-2 refusal (`browser_mismatch`, `denied`, `scope_missing`,
`grant_changed`, …) applies the same way. Off (404) without the social config.

**SP-2. Sealed tokens.** Refresh tokens are sealed as in G-3 with their own key pair: the API
holds `SOCIAL_TOKEN_PUBLIC_KEY`, only the social worker holds the private key, and the
additional data is `zgs1:<tenant>:<connection>`. Planners, agents and the API never hold an
access token or the private key. The access token is never stored.

**SP-3. Connection rows.** `social_connections` holds one row per grant: platform
(`google_business_profile`), Google account email, account and location IDs, `status`
(`active`, `reauthorize`, `disconnecting`, `disconnected`), the sealed token and timestamps.
At most one row per tenant and location is `active` or `reauthorize`. The runtime role may
only move `status` from `active` or `reauthorize` to `disconnecting`, as G-4 says.

**SP-4. Draft and validation.** `social.post.draft` (permission `publish`) stores a `draft`
with `summary` (1 to 1,500 characters), an optional call to action (`BOOK` or `LEARN_MORE`
with an `https` URL on the tenant's public page host or its verified domain), an optional
photo (a JPEG or PNG `media_assets` row of the same tenant, `image-port.md` IM-3, with its
SHA-256), the connection and `scheduled_for`. Anything else fails
`ValidationFailed` with `details.reason` `summary_length`, `cta_url_not_owned`,
`media_not_owned`, `media_format` or `connection_inactive`, before any approval is asked. An
agent may call this action as a planner; nothing it can call publishes.

**SP-5. Fixed once asked.** Once approval is requested, `summary`, the call to action, the
photo asset and digest, the connection and `scheduled_for` cannot change (a trigger refuses the
update, as `inbox-home.md` I-4 does for replies). A change is a new draft and a new approval.

**SP-6. Approval.** `social.post.publish` is in `APPROVAL_POLICIES` with `{ request: "publish",
required: true }` (`approvals.md` A-9), so it runs only through an approved request (A-7). The
approval binds the post ID, the SHA-256 of the canonical post content (photo digest included),
the connection and `scheduled_for`, and the approver sees the text, the photo and the link
(A-12). Running the approved action sets the post `scheduled` and commits a
`social.publish_requested` outbox event in the same transaction.

**SP-7. Publish-time re-check.** The social worker (service role) claims posts that are
`scheduled` with `scheduled_for` reached by the injected clock, under leases (`FOR UPDATE SKIP
LOCKED`, a lease token checked on every write, as `delivery.md` D-3). In the transaction that
opens the attempt it re-checks the approval through `approvalForAction` (A-10), the connection
(`active`) and the photo's SHA-256. A failure ends the post blocked `approval_revoked`,
`approval_missing`, `connection_inactive` or `media_changed`, and nothing is published.

**SP-8. Outcomes.** One Google answer maps to one outcome: success with a post name is
`published` (the remote ID and live URL are stored); 400 is `rejected` (`media_rejected` or
`content_rejected`); 401, 403 or `invalid_grant` on refresh sets the connection `reauthorize`
and ends the post `connection_inactive`; 429 is `rate_limited` and retries with backoff, since
Google refused it before acceptance; a timeout, a lost connection, any 5xx or a thrown error is
`uncertain`.

**SP-9. Never twice.** Because the create call takes no idempotency key, an `uncertain` post is
never sent again. The worker lists the location's posts created since the attempt opened and
looks for the exact `summary`: a match settles the post `published` with that remote ID; no
match after 30 minutes ends it `outcome_unknown`, which the owner sees with a link to check the
profile. Publishing it again needs a new draft and approval.

**SP-10. Disconnect.** `social.connection.disconnect` (permission `publish`) moves an `active`
or `reauthorize` connection to `disconnecting`. Its posts still `scheduled` end blocked
`connection_inactive`. The worker revokes the grant unless another `active` connection
(calendar or social) shares the same Google account, as G-9 explains, then sets
`disconnected` and clears the sealed token. Posts already published stay on the profile.

**SP-11. Tenancy and retention.** `social_connections` and `social_posts` have `tenant_id`,
forced RLS and the tenant policy, are in the catalog isolation test, and have a two-tenant
denial test under the runtime role; a post cannot name another tenant's media asset. Drafts
never approved are deleted 90 days after their last edit; their photos stay in the media store.
Published and blocked posts and their attempts are kept.

## First slice

Draft, approval gate and worker against a fake Google Business Profile server; no real Google
call. `packages/core/test/social/gbp-publish.test.ts` on real Postgres proves: a draft over
1,500 characters fails `summary_length`; the worker publishes nothing while the approval is
`pending`, and a revoked approval ends the post `approval_revoked`; after approval the fake
receives exactly one create call and the post is `published` with its remote ID; a create that
times out but appears in the fake's list settles `published` without a second create; one that
never appears ends `outcome_unknown` after 30 minutes on the injected clock; and tenant B cannot
read tenant A's connection, post or photo.

## Known limits

- One platform. Instagram and Facebook need business verification and app review with Meta;
  each is a new revision and a new decision.
- Matching an uncertain post by its text (SP-9) can miss if Google changes the text; the post
  then ends `outcome_unknown` for the owner rather than risk a second post.
- Google fetches a photo from a URL. The worker hands it a signed URL that expires after 15
  minutes; the media store must offer that signed URL (Status).
- The access form, Google's review time and the quota granted are outside our control.
- Open question: whether the public page host is enough for a `LEARN_MORE` link before a tenant
  has its own domain.
