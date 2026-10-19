-- public-intake.md P-8: each intake consent row keeps the exact disclosure text the visitor
-- agreed to, not only its version, so the evidence stands even if a page's text is later
-- edited without a new version. Earlier rows take their page's current text.

ALTER TABLE public.intake_item_consent ADD COLUMN disclosure_text text;

UPDATE public.intake_item_consent c
   SET disclosure_text = p.disclosure_text
  FROM public.intake_items i
  JOIN public.booking_pages p ON p.tenant_id = i.tenant_id AND p.id = i.page_id
 WHERE i.tenant_id = c.tenant_id AND i.id = c.intake_item_id;

ALTER TABLE public.intake_item_consent ALTER COLUMN disclosure_text SET NOT NULL;
ALTER TABLE public.intake_item_consent ADD CONSTRAINT intake_item_consent_disclosure_text_length
  CHECK (char_length(disclosure_text) BETWEEN 1 AND 2000);
