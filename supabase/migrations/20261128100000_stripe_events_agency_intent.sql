-- SS-020 / D8 (stripe.md revision 6): a dispute carries no metadata, so the billing worker looks up the
-- agency checkout session of the same payment in stripe_events. This partial expression index serves
-- that lookup. Its WHERE clause and expression must match agencySession() in
-- packages/core/src/billing/processor.ts.
CREATE INDEX IF NOT EXISTS stripe_events_agency_intent ON public.stripe_events (
  (coalesce(
    CASE jsonb_typeof(payload->'data'->'object'->'payment_intent')
      WHEN 'string' THEN payload->'data'->'object'->>'payment_intent' END,
    payload->'data'->'object'->'payment_intent'->>'id'))
) WHERE type = 'checkout.session.completed' AND processed_at IS NOT NULL AND outcome = 'not_ours'
  AND payload->'data'->'object'->>'mode' = 'payment'
  AND payload->'data'->'object'->'metadata'->'zs_agency' = '"1"'::jsonb
  AND NOT (payload->'data'->'object'->'metadata' ?| array['zs_tenant','zs_topup','zs_checkout']);
