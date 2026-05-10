-- Aggregation RPCs to replace fetch-then-group-in-JS patterns in the
-- rest-api Edge Function. Each function runs entirely in Postgres so the
-- Edge Function ships only the aggregated answer (a few rows / KB), making
-- the previous row caps (50000 / 8000) obsolete.

-- ----------------------------------------------------------------------------
-- 1. sources_summary — distinct source_type values with counts
--    Replaces: SELECT source_type FROM thoughts LIMIT 50000 + JS group.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sources_summary()
RETURNS TABLE (source_type TEXT, count BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.source_type, COUNT(*)::BIGINT
  FROM public.thoughts t
  WHERE t.source_type IS NOT NULL
  GROUP BY t.source_type
  ORDER BY COUNT(*) DESC;
$$;

GRANT EXECUTE ON FUNCTION public.sources_summary() TO service_role;

-- ----------------------------------------------------------------------------
-- 2. entity_types_summary — distinct entity_type values with counts
--    Replaces: SELECT entity_type FROM entities LIMIT 50000 + JS group.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.entity_types_summary()
RETURNS TABLE (entity_type TEXT, count BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.entity_type, COUNT(*)::BIGINT
  FROM public.entities e
  WHERE e.entity_type IS NOT NULL
  GROUP BY e.entity_type
  ORDER BY COUNT(*) DESC;
$$;

GRANT EXECUTE ON FUNCTION public.entity_types_summary() TO service_role;

-- ----------------------------------------------------------------------------
-- 3. constellation_top_entities — top N entities by mention count, optionally
--    scoped to a recent window and a classification.
--    Replaces the first half of the /constellation path that pulled up to
--    8000 thought_entities rows.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.constellation_top_entities(
  p_days INT DEFAULT 90,
  p_limit INT DEFAULT 30,
  p_classification TEXT DEFAULT NULL
)
RETURNS TABLE (
  entity_id INT,
  canonical_name TEXT,
  entity_type TEXT,
  mentions BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT te.entity_id
    FROM public.thought_entities te
    JOIN public.thoughts t ON t.id = te.thought_id
    WHERE
      (p_days <= 0 OR t.created_at >= now() - (p_days || ' days')::interval)
      AND (p_classification IS NULL OR t.metadata->>'classification' = p_classification)
  )
  SELECT
    e.id::INT,
    e.canonical_name,
    e.entity_type,
    COUNT(*)::BIGINT AS mentions
  FROM scoped s
  JOIN public.entities e ON e.id = s.entity_id
  GROUP BY e.id, e.canonical_name, e.entity_type
  ORDER BY mentions DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.constellation_top_entities(INT, INT, TEXT) TO service_role;

-- ----------------------------------------------------------------------------
-- 4. constellation_co_occurrence — co-occurrence edges among a given set of
--    entity ids. Returns one row per unordered pair (a < b) with weight =
--    number of thoughts that mention both.
--    Replaces the JS double-loop over thought_to_entities.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.constellation_co_occurrence(
  p_entity_ids INT[],
  p_days INT DEFAULT 90,
  p_classification TEXT DEFAULT NULL,
  p_min_weight INT DEFAULT 1
)
RETURNS TABLE (
  source INT,
  target INT,
  weight BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT te.thought_id, te.entity_id
    FROM public.thought_entities te
    JOIN public.thoughts t ON t.id = te.thought_id
    WHERE
      te.entity_id = ANY(p_entity_ids)
      AND (p_days <= 0 OR t.created_at >= now() - (p_days || ' days')::interval)
      AND (p_classification IS NULL OR t.metadata->>'classification' = p_classification)
  )
  SELECT
    LEAST(a.entity_id, b.entity_id)::INT AS source,
    GREATEST(a.entity_id, b.entity_id)::INT AS target,
    COUNT(*)::BIGINT AS weight
  FROM scoped a
  JOIN scoped b
    ON a.thought_id = b.thought_id
    AND a.entity_id < b.entity_id
  GROUP BY 1, 2
  HAVING COUNT(*) >= p_min_weight
  ORDER BY weight DESC;
$$;

GRANT EXECUTE ON FUNCTION public.constellation_co_occurrence(INT[], INT, TEXT, INT) TO service_role;

NOTIFY pgrst, 'reload schema';
