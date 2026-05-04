-- Add curator notes field to wiki_pages.
-- Notes are written by the user in the dashboard and are never overwritten
-- by auto-regeneration. The wiki compiler reads them and incorporates
-- any corrections into the generated content.

ALTER TABLE public.wiki_pages
  ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT NULL;

NOTIFY pgrst, 'reload schema';
