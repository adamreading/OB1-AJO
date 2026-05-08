-- DO NOT RE-ADD trigger_queue_extraction() OR queue_entity_extraction trigger.
-- They were a duplicate of trg_queue_entity_extraction lacking the WHERE guard,
-- causing every metadata edit to re-run Ollama. Fix the guarded version instead.
--
-- Drop the duplicate extraction trigger that was added off-migration.
--
-- Background: The original entity-extraction migration (20260503000100) defined
--   trigger trg_queue_entity_extraction → function queue_entity_extraction()
-- with a WHERE guard so re-extraction only fires when content_fingerprint
-- actually changes:
--
--   ON CONFLICT (thought_id) DO UPDATE SET ...
--   WHERE entity_extraction_queue.source_fingerprint
--         IS DISTINCT FROM EXCLUDED.source_fingerprint;
--
-- A live-DB pg_dump revealed that a SECOND, unrecorded trigger was added at
-- some point:
--   trigger queue_entity_extraction (no trg_ prefix)
--   → function trigger_queue_extraction()    (also unrecorded)
-- which is identical apart from the missing WHERE guard. Both triggers fire on
-- every UPDATE OF content, metadata; the unguarded one wins, re-queueing on
-- every metadata-only edit (status change, classification toggle, tag edit).
--
-- This is incorrect: re-extraction is expensive (Ollama call per thought) and
-- gives qwen3:30b additional opportunities to misclassify the same thought.
-- It also makes the upcoming edge-provenance work (Layer 2) noisier than it
-- needs to be, since edges would get torn down and rebuilt for no-op metadata
-- changes.
--
-- Fix: drop the duplicate trigger and its function. The migration's guarded
-- trigger remains the single source of truth. Re-extraction now fires only
-- when content actually changes.

DROP TRIGGER IF EXISTS queue_entity_extraction ON public.thoughts;
DROP FUNCTION IF EXISTS public.trigger_queue_extraction();

NOTIFY pgrst, 'reload schema';
