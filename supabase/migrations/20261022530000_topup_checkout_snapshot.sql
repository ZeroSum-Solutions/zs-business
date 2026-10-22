-- stripe.md S-2 (revision 4): the Checkout parameters that come from config are stored with the
-- top-up when the action creates it, so a retry under the same Idempotency-Key sends the first
-- request even after a deploy changes them. The session URL is stored once Stripe answers, and a
-- retry returns it without asking Stripe again. Top-ups stored before this have no snapshot.
ALTER TABLE public.wallet_topups
  ADD COLUMN checkout_success_url text
    CONSTRAINT wallet_topups_checkout_success_url CHECK (char_length(checkout_success_url) BETWEEN 1 AND 8192),
  ADD COLUMN checkout_cancel_url text
    CONSTRAINT wallet_topups_checkout_cancel_url CHECK (char_length(checkout_cancel_url) BETWEEN 1 AND 8192),
  ADD COLUMN checkout_product_name text
    CONSTRAINT wallet_topups_checkout_product_name CHECK (char_length(checkout_product_name) BETWEEN 1 AND 100),
  ADD COLUMN checkout_url text
    CONSTRAINT wallet_topups_checkout_url CHECK (char_length(checkout_url) <= 8192 AND checkout_url LIKE 'https://_%'),
  ADD CONSTRAINT wallet_topups_checkout_snapshot CHECK (
    (checkout_success_url IS NULL) = (checkout_cancel_url IS NULL)
    AND (checkout_success_url IS NULL) = (checkout_product_name IS NULL));

-- The action inserts the snapshot; the member's route records the session URL, once.
GRANT INSERT (checkout_success_url, checkout_cancel_url, checkout_product_name) ON public.wallet_topups TO authenticated;
GRANT UPDATE (checkout_url) ON public.wallet_topups TO authenticated;
