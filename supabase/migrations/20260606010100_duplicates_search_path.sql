-- Fix brain_duplicates_find: the pgvector <=> (cosine distance) operator
-- lives in the `extensions` schema, but the function was created with
-- SET search_path = public so it couldn't resolve the operator at runtime.
-- Add `extensions` to the search path.

CREATE OR REPLACE FUNCTION brain_duplicates_find(
  p_threshold DOUBLE PRECISION DEFAULT 0.85,
  p_limit INTEGER DEFAULT 50,
  p_classification TEXT DEFAULT NULL
)
RETURNS TABLE (
  thought_a_id UUID,
  thought_b_id UUID,
  thought_a_serial INTEGER,
  thought_b_serial INTEGER,
  thought_a_preview TEXT,
  thought_b_preview TEXT,
  similarity DOUBLE PRECISION,
  thought_a_created TIMESTAMPTZ,
  thought_b_created TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT id, serial_id, content, embedding, created_at, classification, sensitivity_tier
    FROM public.thoughts
    WHERE embedding IS NOT NULL
      AND sensitivity_tier IS DISTINCT FROM 'restricted'
      AND (p_classification IS NULL OR classification = p_classification)
  )
  SELECT
    a.id AS thought_a_id,
    b.id AS thought_b_id,
    a.serial_id AS thought_a_serial,
    b.serial_id AS thought_b_serial,
    left(a.content, 200) AS thought_a_preview,
    left(b.content, 200) AS thought_b_preview,
    (1 - (a.embedding <=> b.embedding))::double precision AS similarity,
    a.created_at AS thought_a_created,
    b.created_at AS thought_b_created
  FROM candidates a
  JOIN candidates b ON a.serial_id < b.serial_id
  WHERE (1 - (a.embedding <=> b.embedding)) >= p_threshold
  ORDER BY similarity DESC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION brain_duplicates_find(DOUBLE PRECISION, INTEGER, TEXT)
  TO authenticated, anon, service_role;

NOTIFY pgrst, 'reload schema';
