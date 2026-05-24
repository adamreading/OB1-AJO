-- constellation_focus_neighbors_multi — like constellation_focus_neighbors
-- (single focus) but accepts an array of focus entity IDs. Returns the
-- union of every focus's neighbourhood plus the focus entities
-- themselves, so a search hit list like {Zoom, Zoom Contact Centre,
-- Zoom Virtual Agents} appears together with their first-degree
-- neighbours all at once rather than only the "best match" being
-- visible.
--
-- The single-focus RPC stays around for callers that haven't migrated.
-- For wiki search where we routinely have 2-5 matches per query, the
-- multi version is the right default.

CREATE OR REPLACE FUNCTION public.constellation_focus_neighbors_multi(
  p_focus_ids INT[],
  p_days INT DEFAULT 90,
  p_limit INT DEFAULT 100,
  p_classification TEXT DEFAULT NULL,
  p_min_weight INT DEFAULT 1,
  p_excluded_types TEXT[] DEFAULT NULL
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
  WITH scoped_thoughts AS (
    -- Thoughts that mention ANY of the focus entities. DISTINCT because
    -- a single thought can mention more than one focus entity.
    SELECT DISTINCT te.thought_id
    FROM public.thought_entities te
    JOIN public.thoughts t ON t.id = te.thought_id
    WHERE te.entity_id = ANY(p_focus_ids)
      AND (p_days <= 0 OR t.created_at >= now() - (p_days || ' days')::interval)
      AND (p_classification IS NULL OR t.metadata->>'classification' = p_classification)
  ),
  neighbor_rows AS (
    -- Entities co-occurring in any scoped thought, excluding the focus
    -- entities themselves (we'll add them back unconditionally via
    -- full_set so they always appear regardless of the limit).
    SELECT te.entity_id, COUNT(*)::BIGINT AS co_weight
    FROM public.thought_entities te
    JOIN scoped_thoughts st ON st.thought_id = te.thought_id
    WHERE te.entity_id <> ALL(p_focus_ids)
    GROUP BY te.entity_id
    HAVING COUNT(*) >= p_min_weight
  ),
  filtered_neighbors AS (
    SELECT nr.entity_id, nr.co_weight
    FROM neighbor_rows nr
    JOIN public.entities e ON e.id = nr.entity_id
    WHERE p_excluded_types IS NULL OR NOT (e.entity_type = ANY(p_excluded_types))
    ORDER BY nr.co_weight DESC
    -- Cap at p_limit minus how many focus IDs we'll add back, so the
    -- total returned set stays under p_limit.
    LIMIT GREATEST(0, p_limit - cardinality(p_focus_ids))
  ),
  full_set AS (
    SELECT unnest(p_focus_ids) AS entity_id
    UNION
    SELECT entity_id FROM filtered_neighbors
  ),
  mention_counts AS (
    SELECT te.entity_id, COUNT(*)::BIGINT AS mentions
    FROM public.thought_entities te
    JOIN public.thoughts t ON t.id = te.thought_id
    WHERE te.entity_id IN (SELECT entity_id FROM full_set)
      AND (p_days <= 0 OR t.created_at >= now() - (p_days || ' days')::interval)
      AND (p_classification IS NULL OR t.metadata->>'classification' = p_classification)
    GROUP BY te.entity_id
  )
  SELECT
    e.id::INT,
    e.canonical_name,
    e.entity_type,
    COALESCE(mc.mentions, 0)::BIGINT
  FROM full_set fs
  JOIN public.entities e ON e.id = fs.entity_id
  LEFT JOIN mention_counts mc ON mc.entity_id = fs.entity_id
  ORDER BY mc.mentions DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.constellation_focus_neighbors_multi(INT[], INT, INT, TEXT, INT, TEXT[]) TO service_role;

NOTIFY pgrst, 'reload schema';
