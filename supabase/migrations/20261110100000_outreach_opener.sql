-- Outreach sequencer: a researched first line per prospect, used in templates as {{opener}}
-- (docs/requirements/outreach-sequencer.md, revision 2026-11-10: OS-5, OS-7).
-- Additive only: one nullable column, one insert grant. Campaign steps are untouched, so a campaign's content and its
-- digest stay fixed; the service role already holds table-level grants on outreach_prospects.

-- One line of plain text, 1..300 characters, no CR or LF (the import trims it and stores null when it is empty).
ALTER TABLE public.outreach_prospects
  ADD COLUMN opener text CONSTRAINT outreach_prospects_opener CHECK (char_length(opener) BETWEEN 1 AND 300 AND opener !~ '[\r\n]');

-- OS-24: the runtime role inserts prospects by column list, so the new column needs its own grant. Reads are table-level.
-- It never updates the opener: a prospect's first line is fixed at import, like the rest of the row.
GRANT INSERT (opener) ON public.outreach_prospects TO authenticated;
