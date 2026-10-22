-- M3c deal values (docs/requirements/inbox-home.md H-1, revision 4): a currency is an ISO 4217
-- code, not any three capitals. The same list as CURRENCY_CODES in packages/contracts/src/home.ts.
-- Deals stored under the old check may hold a code outside it. The check is added NOT VALID, so
-- every new or updated row is checked from here on, and it is validated below only when no
-- stored row breaks it. Otherwise it stays NOT VALID with a NOTICE giving the count: list those
-- deals with supabase/preflight/20261022520000_deal_currency_iso.sql, fix their values, and a
-- later migration validates. This migration never rewrites or deletes a deal.
ALTER TABLE public.crm_deals DROP CONSTRAINT crm_deals_currency_code;
ALTER TABLE public.crm_deals ADD CONSTRAINT crm_deals_currency_code CHECK (currency IN (
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF',
  'BMD', 'BND', 'BOB', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY', 'COP', 'CRC',
  'CUC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL',
  'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HRK', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'IQD', 'IRR',
  'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR',
  'LRD', 'LSL', 'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR',
  'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR',
  'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SLL', 'SOS', 'SRD', 'SSP',
  'STN', 'SVC', 'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX', 'USD',
  'UYU', 'UZS', 'VED', 'VES', 'VND', 'VUV', 'WST', 'XAF', 'XCD', 'XCG', 'XDR', 'XOF', 'XPF', 'XSU', 'YER', 'ZAR',
  'ZMW', 'ZWG', 'ZWL'
)) NOT VALID;
-- One-time count of stored rows. Under FORCE ROW LEVEL SECURITY a migrator that is not a
-- superuser (postgres on hosted Supabase) sees no rows, and VALIDATE, which does see them, would
-- then fail the whole batch (as in 20261018090000). The table owner lifts FORCE for the count
-- only; ALTER TABLE holds an ACCESS EXCLUSIVE lock until commit, so no other session sees the
-- table without it. The count reads the check's own expression, so the list lives once here.
ALTER TABLE public.crm_deals NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  invalid bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM public.crm_deals WHERE (%s) IS FALSE',
    (SELECT pg_catalog.pg_get_expr(conbin, conrelid) FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public.crm_deals'::regclass AND conname = 'crm_deals_currency_code'))
    INTO invalid;
  IF invalid = 0 THEN
    ALTER TABLE public.crm_deals VALIDATE CONSTRAINT crm_deals_currency_code;
  ELSE
    RAISE NOTICE 'crm_deals holds % deal(s) whose currency is not an ISO 4217 code; crm_deals_currency_code stays NOT VALID until they are fixed (supabase/preflight/20261022520000_deal_currency_iso.sql lists them)', invalid;
  END IF;
END $$;
ALTER TABLE public.crm_deals FORCE ROW LEVEL SECURITY;
