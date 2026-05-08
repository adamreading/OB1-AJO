-- Entity pinning. Pinned entities are protected from auto-deletion when their
-- linked-thought count drops below MIN_LINKED_FOR_WIKI, and (combined with
-- Layer 2's edge provenance) their edges are not deleted when support_count
-- drops to zero.
--
-- Default rule: any entity with 5+ linked thoughts is auto-pinned. Beyond that,
-- manual pins can be set via the entities table or a future UI toggle. Manual
-- pins survive — only auto-pins should be unset by the refresh function below.
--
-- Auto vs manual is tracked in entities.metadata.pin_source = 'auto' | 'manual'
-- to distinguish, so refresh_auto_pinned_entities can promote/demote the auto
-- ones without stomping on user choices.

ALTER TABLE public.entities
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_entities_pinned ON public.entities (pinned) WHERE pinned = true;

-- Auto-pin entities with 5+ linked thoughts. metadata.pin_source = 'auto' lets
-- us distinguish auto-pins (which the refresh function may demote) from manual
-- pins (which the refresh function never touches).
WITH eligible AS (
  SELECT entity_id, count(*) AS thought_count
  FROM public.thought_entities
  GROUP BY entity_id
  HAVING count(*) >= 5
)
UPDATE public.entities e
SET pinned = true,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('pin_source', 'auto'),
    updated_at = now()
FROM eligible
WHERE e.id = eligible.entity_id
  AND e.pinned = false;

-- Refresh function: re-evaluate auto-pins. Promotes entities crossing the 5+
-- threshold; demotes auto-pinned entities that fall below it. Manual pins are
-- never touched (regardless of thought count).
CREATE OR REPLACE FUNCTION public.refresh_auto_pinned_entities(p_threshold INT DEFAULT 5)
RETURNS TABLE(promoted INT, demoted INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_promoted INT;
  v_demoted INT;
BEGIN
  -- Promote
  WITH eligible AS (
    SELECT entity_id FROM public.thought_entities
    GROUP BY entity_id HAVING count(*) >= p_threshold
  ),
  did_promote AS (
    UPDATE public.entities e
    SET pinned = true,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('pin_source', 'auto'),
        updated_at = now()
    WHERE e.pinned = false AND e.id IN (SELECT entity_id FROM eligible)
    RETURNING 1
  )
  SELECT count(*) INTO v_promoted FROM did_promote;

  -- Demote auto-pinned entities below threshold (manual pins untouched)
  WITH below AS (
    SELECT e.id FROM public.entities e
    LEFT JOIN public.thought_entities te ON te.entity_id = e.id
    WHERE e.pinned = true
      AND COALESCE(e.metadata->>'pin_source', 'auto') = 'auto'
    GROUP BY e.id
    HAVING count(te.thought_id) < p_threshold
  ),
  did_demote AS (
    UPDATE public.entities e
    SET pinned = false, updated_at = now()
    WHERE e.id IN (SELECT id FROM below)
    RETURNING 1
  )
  SELECT count(*) INTO v_demoted FROM did_demote;

  promoted := v_promoted;
  demoted := v_demoted;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_auto_pinned_entities(INT) TO service_role;

NOTIFY pgrst, 'reload schema';
