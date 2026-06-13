-- OB1 Agent Memory — make agent_memories self-contained for embeddings.
--
-- Previously the agent-memory-api wrote each memory's text into public.thoughts
-- solely to reuse the thoughts embedding column + match_thoughts ANN search.
-- That polluted the main brain with agent turn-summaries. This migration gives
-- agent_memories its own embedding column, ANN index, and match RPC so Hermes
-- (and any runtime) memory never lands in thoughts.
--
-- Additive only: public.thoughts is NOT touched. Safe to run more than once.

SET search_path TO public, extensions;

BEGIN;

-- 1) Own embedding column. Dimension matches thoughts.embedding
--    (openai/text-embedding-3-small => 1536).
ALTER TABLE public.agent_memories
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- 2) ANN index — same method/opclass as the thoughts embedding index
--    (docs/01-getting-started.md: hnsw + vector_cosine_ops).
CREATE INDEX IF NOT EXISTS idx_agent_memories_embedding
  ON public.agent_memories
  USING hnsw (embedding vector_cosine_ops);

-- 3) match_agent_memories — mirrors match_thoughts but selects from
--    agent_memories and scopes by workspace_id. Returns id/content/summary/
--    similarity (+ created_at for downstream ranking). Cosine similarity via
--    the <=> distance operator, identical to match_thoughts.
CREATE OR REPLACE FUNCTION public.match_agent_memories(
  query_embedding  vector(1536),
  match_threshold  float DEFAULT 0.25,
  match_count      int   DEFAULT 20,
  p_workspace_id   text  DEFAULT NULL,
  p_project_id     text  DEFAULT NULL
)
RETURNS TABLE (
  id          uuid,
  content     text,
  summary     text,
  similarity  float,
  created_at  timestamptz
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.summary,
    (1 - (m.embedding <=> query_embedding))::float AS similarity,
    m.created_at
  FROM public.agent_memories m
  WHERE m.embedding IS NOT NULL
    AND (p_workspace_id IS NULL OR m.workspace_id = p_workspace_id)
    AND (p_project_id IS NULL OR m.project_id = p_project_id)
    AND (1 - (m.embedding <=> query_embedding)) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION public.match_agent_memories(vector(1536), float, int, text, text) IS
  'Nearest-neighbour search over agent_memories.embedding (cosine via <=>), scoped by workspace_id (and optional project_id). Mirrors match_thoughts. Returns id/content/summary/similarity/created_at.';

GRANT EXECUTE ON FUNCTION public.match_agent_memories(vector(1536), float, int, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
