-- Layer 2 — edge provenance + decrement-on-reprocess.
--
-- Solves the architectural flaw "edits make wrong edges worse": until now,
-- entity edges (the `edges` table) were write-only — re-extracting a thought
-- could ONLY bump support_count, never decrement, because there was no link
-- back to which thoughts contributed which edges.
--
-- This migration adds:
--
--   thought_entity_edges — provenance table. One row per (thought, from, to,
--   relation) tuple. Worker's writeGraph deletes a thought's rows before
--   re-extraction and re-inserts based on Ollama's fresh output. The triple's
--   support_count in the `edges` table is a derived aggregate.
--
--   trg_maintain_edge_support_count — trigger fires on every INSERT/DELETE of
--   thought_entity_edges. Recomputes count(*) for the (from, to, relation)
--   triple and:
--     - If count > 0: upserts edges row with support_count = count and
--                     confidence = max contributing confidence.
--     - If count = 0: checks whether either endpoint is pinned. If yes, the
--                     edges row is kept with support_count = 0. If no, the
--                     edges row is deleted.
--
-- This means re-processing a thought that no longer extracts an edge → edge
-- shrinks. Drops to zero → edge auto-deletes (unless an endpoint is pinned).

CREATE TABLE IF NOT EXISTS public.thought_entity_edges (
  thought_id UUID NOT NULL REFERENCES public.thoughts(id) ON DELETE CASCADE,
  from_entity_id BIGINT NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  to_entity_id BIGINT NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  confidence NUMERIC(3,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thought_id, from_entity_id, to_entity_id, relation),
  CHECK (from_entity_id <> to_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_thought_entity_edges_triple
  ON public.thought_entity_edges (from_entity_id, to_entity_id, relation);

CREATE INDEX IF NOT EXISTS idx_thought_entity_edges_thought
  ON public.thought_entity_edges (thought_id);

ALTER TABLE public.thought_entity_edges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS thought_entity_edges_service_role_all ON public.thought_entity_edges;
CREATE POLICY thought_entity_edges_service_role_all ON public.thought_entity_edges
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS thought_entity_edges_authenticated_select ON public.thought_entity_edges;
CREATE POLICY thought_entity_edges_authenticated_select ON public.thought_entity_edges
  FOR SELECT TO authenticated USING (true);

GRANT ALL ON public.thought_entity_edges TO service_role;
GRANT SELECT ON public.thought_entity_edges TO authenticated;

-- ─── Maintenance trigger ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.maintain_edge_support_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from BIGINT;
  v_to BIGINT;
  v_rel TEXT;
  v_count INT;
  v_max_conf NUMERIC(3,2);
  v_pinned BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_from := OLD.from_entity_id; v_to := OLD.to_entity_id; v_rel := OLD.relation;
  ELSE
    v_from := NEW.from_entity_id; v_to := NEW.to_entity_id; v_rel := NEW.relation;
  END IF;

  SELECT count(*), max(confidence)
  INTO v_count, v_max_conf
  FROM public.thought_entity_edges
  WHERE from_entity_id = v_from
    AND to_entity_id   = v_to
    AND relation       = v_rel;

  IF v_count = 0 THEN
    SELECT bool_or(pinned) INTO v_pinned
    FROM public.entities
    WHERE id IN (v_from, v_to);

    IF v_pinned THEN
      -- Keep the edges row at support=0 so manual curation survives extraction
      -- churn. The user can still see (and ✕-remove) it from the panel.
      UPDATE public.edges
      SET support_count = 0, updated_at = now()
      WHERE from_entity_id = v_from
        AND to_entity_id   = v_to
        AND relation       = v_rel;
    ELSE
      DELETE FROM public.edges
      WHERE from_entity_id = v_from
        AND to_entity_id   = v_to
        AND relation       = v_rel;
    END IF;
  ELSE
    INSERT INTO public.edges (from_entity_id, to_entity_id, relation, support_count, confidence)
    VALUES (v_from, v_to, v_rel, v_count, v_max_conf)
    ON CONFLICT (from_entity_id, to_entity_id, relation) DO UPDATE SET
      support_count = EXCLUDED.support_count,
      confidence    = EXCLUDED.confidence,
      updated_at    = now();
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_maintain_edge_support_ins ON public.thought_entity_edges;
CREATE TRIGGER trg_maintain_edge_support_ins
  AFTER INSERT ON public.thought_entity_edges
  FOR EACH ROW
  EXECUTE FUNCTION public.maintain_edge_support_count();

DROP TRIGGER IF EXISTS trg_maintain_edge_support_del ON public.thought_entity_edges;
CREATE TRIGGER trg_maintain_edge_support_del
  AFTER DELETE ON public.thought_entity_edges
  FOR EACH ROW
  EXECUTE FUNCTION public.maintain_edge_support_count();

GRANT EXECUTE ON FUNCTION public.maintain_edge_support_count() TO service_role;

NOTIFY pgrst, 'reload schema';
