# Discovery: personalization as a Mish client service

Researched 2026-10-21. Reviewed by GPT-6.1 Sol the same day.

## The idea

Give every client store what large personalization platforms (Nosto, Rebuy, Klevu) give
enterprise brands: product recommendations, personalized search, smart category ranking,
targeted content, a generated shopping experience and an agent the owner can ask questions.
We sell it as one checkbox in the Mish checkout ("Discovery") and run it for the client.

- Sites that Mish builds get it as section types (recommendation slots, search, generated
  sections).
- Shopify stores get it through one Shopify app. Each new store is an install and a new
  tenant, not a new project.
- Other platforms (WooCommerce, BigCommerce, headless) come later, one connector each.
  A script tag alone cannot read a catalog, confirm purchases or control a platform's own
  search pages, so we never promise "any website".

A pilot Shopify store funds the first build. It needs the feature within weeks, so the
engine is built multi-tenant from day one and the pilot is tenant 1.

## Is it viable

Yes, for stores with a real catalog (about 100+ products) and steady traffic.

- The market pays for this today: Nosto (quote-based, enterprise), Rebuy (from $25/month),
  Klevu, Searchanise.
- The hard parts have permissive open-source building blocks (below).
- Our edge is not price. Shopify's own Search & Discovery app is free. Our edge is
  managed setup and tuning, an owner agent, and one bundle with the site, email and CRM we
  already run.
- Not for service businesses without a catalog (trainers, clinics). Do not show it to them.
- Price idea to test: a setup fee plus a managed monthly fee between the cheap apps and
  Nosto. Validate with real quotes and logged delivery hours.

## Feature list

Grouped by area. (P) = in the first pilot build. Everything else is later.

### 1. Data layer
- (P) Shopper events from a Shopify Web Pixel (consent-aware) or a Mish site SDK.
- (P) Catalog sync: products, variants, prices, stock, images, collections, tags.
- (P) Order sync from platform webhooks. Browser events are never proof of purchase.
- In-store (POS) orders merged into the same profile (omnichannel profiles).
- Anonymous-to-known identity linking only through verified platform identity.
- (P) Consent: follow the store's existing consent banner and opt-outs (GPC); useful
  unpersonalized results when there is no consent.
- Retention limits, query redaction and deletion that reaches events, profiles, embeddings
  and exports.

### 2. Shopper profiles and predictions
- (P) Affinities: brand or designer, category, price band, size, color, material.
- Lifecycle stage: new visitor, first-time buyer, repeat, lapsed.
- Purchase probability and churn risk.
- Inventory velocity: how long stock lasts at the current sales rate.
- Lookalike audiences for ads.

### 3. Recommendations
- (P) Recommended for you.
- (P) Bought together and viewed together.
- (P) Visually similar items, and an alternative when an item is out of stock.
- (P) Same designer or brand.
- (P) Staff-picked pairings (merchandiser overrides beat the model).
- Complete the look: sets built from visual style, co-purchase data and staff rules.
- Recently viewed, trending, new for you, back in stock.
- Cart recommendations and free-gift or spend-threshold nudges.
- Post-purchase one-click add (thank-you page on all Shopify plans; extra checkout steps
  need Shopify Plus).
- (P) Email recommendations as a feed for the store's email tool (Klaviyo first).
- Dynamic bundles.

### 4. Search
- (P) Semantic search: understands intent, not only keywords.
- (P) Personalized ranking of results per shopper and context.
- Typo tolerance, AI-suggested synonyms (owner approves).
- Visual search: upload a photo, find similar products.
- Conversational search: the shopper describes a need; the search asks one follow-up
  question and shows products.
- Zero-results recovery and a search-gaps report.

### 5. Merchandising
- (P) Rules: pin, boost, bury, demote low stock, hide.
- Personalized category ranking, including the best variant shown first (SKU face-out).
- Revenue- or margin-aware ranking.
- Content tiles inside the product grid, chosen by segment and funnel stage.
- Scheduled rules (launches, sales, holidays).

### 6. Targeting and testing
- Contextual offers by traffic source, campaign, location, visit count and cart value.
- Affinity-targeted banners and hero content.
- Behavioral pop-ups (exit intent, inactivity).
- A/B tests and a permanent holdout group to measure real lift.

### 7. Generative UI
- Generated sections per visitor, built only from the typed Mish section catalog
  (never free HTML), so every output is valid, on-brand and reviewable.
- Generated landing pages per campaign or ad, from the ad's promise to matching products.
- Generated collections from a phrase ("gifts under $500 for her").
- A shopping assistant chat that answers with product cards, comparisons and size help as
  live widgets.
- Generated product copy and image alt text, sent to the owner for approval.
- Owner dashboard widgets the agent builds on request ("show me best sellers for
  first-time visitors this month").

### 8. Store agent
- Data analyst: answers questions about products, segments and results, with sample
  counts and data freshness.
- Merchandising agent: finds weak categories and proposes rule changes.
- Suggests synonyms, bundles and new segments.
- Every change goes through the approval path. The agent proposes; a named person decides.
- An MCP server over the same reads, so outside agents (Claude, Cursor) can use it.

### 9. Agent-ready commerce
- Clean product feed and structured data for AI shopping agents.
- Watch the agent checkout protocols: Agentic Commerce Protocol (OpenAI and Stripe) and
  Universal Commerce Protocol (Google and Shopify). Adopt when clients ask.

### 10. Content and social
- Visual tagging of product and user photos (style, color, objects).
- Shoppable user-generated content on the site and in social posts.

### 11. Ties to the Business OS
- Book an in-store viewing from a product page, through our booking service.
- Clienteling: staff see a customer's affinities before an appointment.
- Discovery results (revenue from recommendations, search conversions, lift) on Home.
- Discovery controls live under Site, results under Home, consent under Customers and read
  tools under Agents. No new tab.

## Building blocks (checked 2026-10-21)

Stars and last push from the GitHub API on 2026-10-21. Licences from each repository or
model card. Recheck before use.

| Part | Project | Licence | Use |
|---|---|---|---|
| Recommendations | [gorse-io/gorse](https://github.com/gorse-io/gorse) (9.9k stars) | Apache-2.0 | Full engine with API and dashboard. No native multi-tenancy ([issue #336](https://github.com/gorse-io/gorse/issues/336)). |
| Real-time re-ranking | [metarank/metarank](https://github.com/metarank/metarank) (2.5k) | Apache-2.0 | LambdaMART re-ranking with live features. Event schema has an optional tenant field. |
| Semantic and image search | [marqo-ai/marqo](https://github.com/marqo-ai/marqo) (5k) | Apache-2.0 | Built for e-commerce. |
| Ranking and search platform | [vespa-engine/vespa](https://github.com/vespa-engine/vespa) (7.1k) | Apache-2.0 | Heavier; has a shopping sample app. |
| Learning to rank | [o19s/elasticsearch-learning-to-rank](https://github.com/o19s/elasticsearch-learning-to-rank) | Apache-2.0 | Rank by labels we choose (conversion, revenue). |
| Profiles and segments | [apache/unomi](https://github.com/apache/unomi) | Apache-2.0 | Reference for profile and segment design. |
| Event collection | [jitsucom/jitsu](https://github.com/jitsucom/jitsu) | MIT | Reference; Shopify Web Pixels first. |
| A/B testing | [growthbook/growthbook](https://github.com/growthbook/growthbook) | MIT core, some Enterprise directories | Exclude Enterprise paths. |
| Typed UI from JSON | [vercel-labs/json-render](https://github.com/vercel-labs/json-render) | Apache-2.0 | Generative UI renderer (already in the assembly plan). |
| Agent checkout | [Agentic Commerce Protocol](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol), [Universal Commerce Protocol](https://github.com/Universal-Commerce-Protocol/ucp) | Apache-2.0 | Specs to follow. |

Hugging Face models:

| Model | Licence | Use |
|---|---|---|
| [Marqo/marqo-ecommerce-embeddings-L](https://huggingface.co/Marqo/marqo-ecommerce-embeddings-L) | Apache-2.0 | Product text and image embeddings for search and similarity |
| [Marqo/marqo-fashionSigLIP](https://huggingface.co/Marqo/marqo-fashionSigLIP) | Apache-2.0 | Fashion and jewelry style, color and category |
| [patrickjohncyh/fashion-clip](https://huggingface.co/patrickjohncyh/fashion-clip) | MIT | Alternative fashion model |
| [BAAI/bge-reranker-v2-m3](https://huggingface.co/BAAI/bge-reranker-v2-m3) | Apache-2.0 | Re-rank search results |

No open-source project covers the whole product. The merchandiser UI, targeting rules,
shopper profiles with predictions and the agent layer are ours to build. Marqo models are
not in the Cloudflare Workers AI catalog; prove an affordable way to run them first.

How a large vendor does it (behaviour only, from their public demo, 2026-10-21): their own
models for personalization, merchandising, testing and segments; fine-tuned paid LLMs for
generative features; open-source models picked and tested from Hugging Face. Their main
advantage is training data from thousands of stores. We do not pool shopper data across
clients until the legal basis is cleared (see below).

## Constraints from the Sol review

Each of these must have an answer in the requirements before build.

1. **Public event intake is new.** Today the only anonymous write is
   `booking.public_request` (`docs/requirements/public-intake.md`, P-1). Shopper events
   need their own contract: quotas, validation, server-built principals.
2. **Approvals bind one action.** Live targeting needs approved, immutable rule versions
   that can be revoked or expire; serving reads the approved version.
3. **Tenant isolation beyond Postgres.** Vector indexes, caches, model files, jobs and
   exports each enforce the server-derived tenant, with cross-tenant denial tests.
4. **External systems update through the outbox.** Search index, recommendation engine,
   Shopify and email tool get versioned, idempotent, retried projections with
   reconciliation.
5. **Catalog truth.** Product facts (materials, stones, provenance, sizes) come from
   approved store data, never from an image model. Check stock and price at serving time.
6. **Consent and data law.** Follow the store's banner and opt-outs. A contract clause alone
   does not permit cross-store shopper profiling (California CPPA rules). Health clients
   are out of scope.
7. **Platform limits.** Publish a capability matrix by platform, plan and placement before
   selling (for example, Shopify checkout-step extensions need Plus).
8. **Releases.** Personalized parts must not break immutable site releases, preview,
   rollback or cache isolation, and must fall back to static content fast.
9. **Measurement.** Report incremental gross profit against a holdout, not widget-attributed
   revenue. Small stores rarely have traffic for classic A/B significance.
10. **Stack size.** Start in TypeScript and Postgres. Add Gorse, Marqo, GrowthBook or
    another store only when a measurement justifies it.

## Build order

1. Spec and a Shopify Partner development store with sample products (no client access
   needed).
2. Shopify app skeleton, catalog and order sync, Web Pixel events, tenant-scoped tables.
3. Recommendations (pilot set in section 3) and the email feed.
4. Semantic search with personalized ranking; merchandising rules.
5. Owner settings, holdout measurement, results on Home.
6. Install on the pilot store when access is granted; then POS merge.
7. Generative UI sections, shopping assistant and store agent.
8. Second client install; then other platforms.

## Start when

- The pilot store grants collaborator access with app-install permission and approves
  Zero Sum as a data processor.
- Requirements for constraints 1 to 4 exist in `docs/requirements/`.
