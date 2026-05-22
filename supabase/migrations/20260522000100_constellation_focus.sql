-- Constellation focus + type-filter awareness
--
-- Two related improvements:
--
-- 1. constellation_focus_neighbors(p_focus_id, ...): when the user selects an
--    entity in the wiki, refetch a constellation centred on that entity —
--    showing the focus entity + every neighbour it co-occurs with (weight
--    >= min_weight), capped at p_limit. Replaces the prior client-side
--    "filter the top-N to neighbours" trick, which only ever showed
--    neighbours that happened to also be in the global top-N.
--
-- 2. constellation_top_entities gets a p_excluded_types TEXT[] arg so the
--    server-side top-N selection can honour the wiki / dashboard type-filter
--    chips. Toggling "person" off, say, now lets project + tool + topic
--    entities take the freed slots — instead of getting capped out by people
--    that are then hidden client-side.
--
-- Signature change on constellation_top_entities means we DROP + recreate.
-- The old signature has no callers outside the Edge Function deployed in
-- the same release.

DROP FUNCTION IF EXISTS public.constellation_top_entities(INT, INT, TEXT);

CREATE OR REPLACE FUNCTION public.constellation_top_entities(
  p_days INT DEFAULT 90,
  p_limit INT DEFAULT 30,
  p_classification TEXT DEFAULT NULL,
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
  WHERE p_excluded_types IS NULL OR NOT (e.entity_type = ANY(p_excluded_types))
  GROUP BY e.id, e.canonical_name, e.entity_type
  ORDER BY mentions DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.constellation_top_entities(INT, INT, TEXT, TEXT[]) TO service_role;

CREATE OR REPLACE FUNCTION public.constellation_focus_neighbors(
  p_focus_id INT,
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
    SELECT DISTINCT te.thought_id
    FROM public.thought_entities te
    JOIN public.thoughts t ON t.id = te.thought_id
    WHERE te.entity_id = p_focus_id
      AND (p_days <= 0 OR t.created_at >= now() - (p_days || ' days')::interval)
      AND (p_classification IS NULL OR t.metadata->>'classification' = p_classification)
  ),
  neighbor_rows AS (
    SELECT te.entity_id, COUNT(*)::BIGINT AS co_weight
    FROM public.thought_entities te
    JOIN scoped_thoughts st ON st.thought_id = te.thought_id
    WHERE te.entity_id <> p_focus_id
    GROUP BY te.entity_id
    HAVING COUNT(*) >= p_min_weight
  ),
  filtered_neighbors AS (
    SELECT nr.entity_id, nr.co_weight
    FROM neighbor_rows nr
    JOIN public.entities e ON e.id = nr.entity_id
    WHERE p_excluded_types IS NULL OR NOT (e.entity_type = ANY(p_excluded_types))
    ORDER BY nr.co_weight DESC
    LIMIT GREATEST(0, p_limit - 1)
  ),
  full_set AS (
    SELECT p_focus_id AS entity_id
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

GRANT EXECUTE ON FUNCTION public.constellation_focus_neighbors(INT, INT, INT, TEXT, INT, TEXT[]) TO service_role;

NOTIFY pgrst, 'reload schema';
