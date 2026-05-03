-- AJO graph compatibility columns
--
-- Some AJO installs had an earlier graph prototype before the upstream
-- entity-extraction schema was merged. CREATE TABLE IF NOT EXISTS does not
-- upgrade those existing tables, so add the missing provenance/timestamp
-- columns explicitly.

ALTER TABLE public.entities
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.thought_entities
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'entity_worker',
  ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

NOTIFY pgrst, 'reload schema';
