-- Add the UNIQUE constraint on edges that the entity-extraction schema spec
-- declared but the live DB never received (schema drift — the table was
-- created upstream before AJO migrations and IF NOT EXISTS skipped over it).
--
-- This unblocks Layer 2: the maintain_edge_support_count trigger does
-- INSERT INTO edges ... ON CONFLICT (from_entity_id, to_entity_id, relation),
-- which requires a matching UNIQUE constraint.
--
-- Verified beforehand that no duplicate triples exist in the table.

ALTER TABLE public.edges
  ADD CONSTRAINT edges_from_to_relation_key
  UNIQUE (from_entity_id, to_entity_id, relation);

NOTIFY pgrst, 'reload schema';
