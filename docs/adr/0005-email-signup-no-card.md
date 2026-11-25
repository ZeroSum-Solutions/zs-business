# Sign-up needs a verified email and no card; paid features need a card

Every owner signs up with a verified email and no card. The Free plan has no AI drafting. Paid plans start with the 14-day card-required trial, once per tenant (Shopify installs: once per shop, verified before it is advertised). Testers instead redeem a single-use, email-bound invite code for a 14-day Solo grant with no card and no operator step. `plans.ts` is the one price source; Stripe and Shopify prices are reconciled to it. Decided 2026-11-24 in ZSB-81 (Q4, Q5, Q7, Q9).

## Considered Options

- Card at sign-up: rejected as friction for testers.
- Money-back instead of a trial: rejected; refunds stay human-run and never delete data (rule 10).
