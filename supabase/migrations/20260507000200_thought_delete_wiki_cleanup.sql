-- When a thought is deleted, clean up any wiki pages that cited it.
-- - For each entity linked to the deleted thought, count remaining links.
-- - If the entity drops below MIN_LINKED_FOR_WIKI (3), delete its wiki_pages
--   row. The page would otherwise carry stale [#N] citations forever.
-- - If the entity is still above the threshold, re-queue its most recent
--   linked thought into entity_extraction_queue. The local worker will pick
--   it up within ~10s, re-process via Ollama, and regenerate the wiki page
--   without the dead citation.
--
-- Runs in a BEFORE DELETE trigger so thought_entities is still queryable
-- (cascade fires AFTER the delete completes).

CREATE OR REPLACE FUNCTION public.cleanup_wikis_on_thought_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected_entity_id BIGINT;
  link_count INT;
  recent_thought_id UUID;
  min_linked CONSTANT INT := 3;
BEGIN
  FOR affected_entity_id IN
    SELECT DISTINCT entity_id FROM public.thought_entities WHERE thought_id = OLD.id
  LOOP
    SELECT count(*) INTO link_count
    FROM public.thought_entities
    WHERE entity_id = affected_entity_id
      AND thought_id <> OLD.id;

    IF link_count < min_linked THEN
      DELETE FROM public.wiki_pages WHERE entity_id = affected_entity_id;
    ELSE
      SELECT te.thought_id INTO recent_thought_id
      FROM public.thought_entities te
      JOIN public.thoughts t ON t.id = te.thought_id
      WHERE te.entity_id = affected_entity_id
        AND te.thought_id <> OLD.id
      ORDER BY t.updated_at DESC NULLS LAST
      LIMIT 1;

      IF recent_thought_id IS NOT NULL THEN
        INSERT INTO public.entity_extraction_queue (thought_id, status, queued_at)
        VALUES (recent_thought_id, 'pending', now())
        ON CONFLICT (thought_id) DO UPDATE SET
          status = 'pending',
          attempt_count = 0,
          last_error = NULL,
          queued_at = now();
      END IF;
    END IF;
  END LOOP;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_cleanup_wikis_on_thought_delete ON public.thoughts;
CREATE TRIGGER trg_cleanup_wikis_on_thought_delete
  BEFORE DELETE ON public.thoughts
  FOR EACH ROW
  EXECUTE FUNCTION public.cleanup_wikis_on_thought_delete();

GRANT EXECUTE ON FUNCTION public.cleanup_wikis_on_thought_delete() TO service_role;

NOTIFY pgrst, 'reload schema';
