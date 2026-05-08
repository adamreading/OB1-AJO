-- Entity Blocklist — prevents deleted/merged entity names from being recreated
-- by the local worker. Aliases short-circuit BEFORE the blocklist check, so a
-- merged-then-aliased name still links to the surviving entity correctly.
-- The blocklist only gates *creation* of new entity rows.

CREATE TABLE IF NOT EXISTS public.entity_blocklist (
  entity_type TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'deleted',
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_entity_blocklist_normalized
  ON public.entity_blocklist (normalized_name);

ALTER TABLE public.entity_blocklist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entity_blocklist_service_role_all ON public.entity_blocklist;
CREATE POLICY entity_blocklist_service_role_all ON public.entity_blocklist
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS entity_blocklist_authenticated_select ON public.entity_blocklist;
CREATE POLICY entity_blocklist_authenticated_select ON public.entity_blocklist
  FOR SELECT TO authenticated USING (true);

GRANT ALL ON public.entity_blocklist TO service_role;
GRANT SELECT ON public.entity_blocklist TO authenticated;

NOTIFY pgrst, 'reload schema';
