-- Edge blocklist + per-thought blocklist_hits counter.
--
-- Layer 1 of the "edits make wrong edges worse" architectural fix:
--   1. edge_blocklist — manual override. When the user removes an edge from
--      the dashboard's Edit Relationships panel, the (from, to, relation)
--      tuple is recorded here. The local worker's upsertEdge() consults this
--      table and silently drops any matching extraction. Stops bad edges
--      from coming back when thoughts are re-processed.
--
--   2. thoughts.blocklist_hits — diagnostic counter. Every time a thought's
--      Ollama extraction would have produced a blocklisted edge, the worker
--      increments this counter. Surfaces which thought content is generating
--      bad edges so it can be edited or split. No UI yet — just a column.
--
-- Symmetric edge convention: matches the existing upsertEdge logic in
-- scripts/local-brain-worker.js (line 444). For symmetric relations
-- (alternative_to, co_occurs_with, related_to, collaborates_with,
-- integrates_with), entries are stored with from_entity_id < to_entity_id
-- so a single blocklist row blocks both directions.

CREATE TABLE IF NOT EXISTS public.edge_blocklist (
  from_entity_id BIGINT NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  to_entity_id   BIGINT NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  relation       TEXT NOT NULL,
  reason         TEXT NOT NULL DEFAULT 'user_removed',  -- user_removed | merged | extraction_blocked
  blocked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_entity_id, to_entity_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_edge_blocklist_from ON public.edge_blocklist (from_entity_id);
CREATE INDEX IF NOT EXISTS idx_edge_blocklist_to   ON public.edge_blocklist (to_entity_id);

ALTER TABLE public.edge_blocklist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS edge_blocklist_service_role_all ON public.edge_blocklist;
CREATE POLICY edge_blocklist_service_role_all ON public.edge_blocklist
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS edge_blocklist_authenticated_select ON public.edge_blocklist;
CREATE POLICY edge_blocklist_authenticated_select ON public.edge_blocklist
  FOR SELECT TO authenticated USING (true);

GRANT ALL ON public.edge_blocklist TO service_role;
GRANT SELECT ON public.edge_blocklist TO authenticated;

-- ---------------------------------------------------------------
-- thoughts.blocklist_hits — count of extractions blocked per thought
-- ---------------------------------------------------------------

ALTER TABLE public.thoughts
  ADD COLUMN IF NOT EXISTS blocklist_hits INTEGER NOT NULL DEFAULT 0;

NOTIFY pgrst, 'reload schema';
