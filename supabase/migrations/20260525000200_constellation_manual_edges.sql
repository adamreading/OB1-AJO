-- Surface user-added manual edges in the constellation.
--
-- Manual edges (POST /edges/manual → metadata.source='manual') sit alongside
-- inferred edges in the `edges` table but represent a different trust tier:
-- the user asserted the relationship directly. They should appear in the
-- constellation as solid lines (same visual weight as co-occurrence edges),
-- not dashed like inferred.
--
-- This migration:
--   1. Recreates `constellation_inferred_edges` to return ALL non-thought-
--      derived edges in the given entity set (`metadata.source IN
--      ('inferred', 'manual')`), with a `source` text column so the
--      handler can distinguish.
--   2. Same change applied to the focus_neighbors RPCs that include
--      inferred neighbours — now they also include manual neighbours, so
--      a manual edge to a non-co-occurring entity surfaces in focus mode.
--   3. Keeps the legacy `inferred` boolean column derived from source for
--      callers that only care about that distinction.
--
-- Drops the old function first because the return signature changes (added
-- source column). The only caller is the Edge Function deployed in the
-- same release.

DROP FUNCTION IF EXISTS public.constellation_inferred_edges(INT[]);

CREATE OR REPLACE FUNCTION public.constellation_inferred_edges(
  p_entity_ids INT[]
)
RETURNS TABLE (
  source INT,
  target INT,
  relation TEXT,
  weight BIGINT,
  inferred BOOLEAN,
  edge_source TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    LEAST(e.from_entity_id, e.to_entity_id)::INT AS source,
    GREATEST(e.from_entity_id, e.to_entity_id)::INT AS target,
    e.relation,
    GREATEST(e.support_count, 1)::BIGINT AS weight,
    (e.metadata->>'source' = 'inferred') AS inferred,
    (e.metadata->>'source')::TEXT AS edge_source
  FROM public.edges e
  WHERE e.from_entity_id = ANY(p_entity_ids)
    AND e.to_entity_id   = ANY(p_entity_ids)
    AND e.metadata->>'source' IN ('inferred', 'manual');
$$;

GRANT EXECUTE ON FUNCTION public.constellation_inferred_edges(INT[]) TO service_role;

-- Extend the focus_neighbors RPCs to ALSO include manual-edge neighbours
-- (previously they only walked inferred-edge neighbours). A manual edge to
-- a non-co-occurring entity should bring that entity into focus.
--
-- Both signatures unchanged; only the WHERE clause on the
-- inferred_neighbors CTE broadens to include 'manual'.

DROP FUNCTION IF EXISTS public.constellation_focus_neighbors(INT, INT, INT, TEXT, INT, TEXT[]);

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
  mentions BIGINT,
  dominant_classification TEXT
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
  co_neighbors AS (
    SELECT te.entity_id, COUNT(*)::BIGINT AS co_weight
    FROM public.thought_entities te
    JOIN scoped_thoughts st ON st.thought_id = te.thought_id
    WHERE te.entity_id <> p_focus_id
    GROUP BY te.entity_id
    HAVING COUNT(*) >= p_min_weight
  ),
  inferred_neighbors AS (
    SELECT DISTINCT
      CASE WHEN ed.from_entity_id = p_focus_id THEN ed.to_entity_id::INT ELSE ed.from_entity_id::INT END AS entity_id,
      0::BIGINT AS co_weight
    FROM public.edges ed
    WHERE (ed.from_entity_id = p_focus_id OR ed.to_entity_id = p_focus_id)
      AND ed.metadata->>'source' IN ('inferred', 'manual')
  ),
  all_neighbors AS (
    SELECT entity_id, MAX(co_weight) AS co_weight FROM (
      SELECT entity_id, co_weight FROM co_neighbors
      UNION ALL
      SELECT entity_id, co_weight FROM inferred_neighbors
    ) u
    WHERE entity_id <> p_focus_id
    GROUP BY entity_id
  ),
  filtered_neighbors AS (
    SELECT an.entity_id, an.co_weight
    FROM all_neighbors an
    JOIN public.entities e ON e.id = an.entity_id
    WHERE p_excluded_types IS NULL OR NOT (e.entity_type = ANY(p_excluded_types))
    ORDER BY an.co_weight DESC
    LIMIT GREATEST(0, p_limit - 1)
  ),
  full_set AS (
    SELECT p_focus_id AS entity_id
    UNION
    SELECT entity_id FROM filtered_neighbors
  ),
  mention_counts AS (
    SELECT te.entity_id::INT AS entity_id, COUNT(*)::BIGINT AS mentions
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
    COALESCE(mc.mentions, 0)::BIGINT,
    dc.dominant
  FROM full_set fs
  JOIN public.entities e ON e.id = fs.entity_id
  LEFT JOIN mention_counts mc ON mc.entity_id = fs.entity_id
  LEFT JOIN public.entity_dominant_classification(5000) dc ON dc.entity_id = e.id
  ORDER BY mc.mentions DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.constellation_focus_neighbors(INT, INT, INT, TEXT, INT, TEXT[]) TO service_role;

DROP FUNCTION IF EXISTS public.constellation_focus_neighbors_multi(INT[], INT, INT, TEXT, INT, TEXT[]);

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
  mentions BIGINT,
  dominant_classification TEXT
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
    WHERE te.entity_id = ANY(p_focus_ids)
      AND (p_days <= 0 OR t.created_at >= now() - (p_days || ' days')::interval)
      AND (p_classification IS NULL OR t.metadata->>'classification' = p_classification)
  ),
  co_neighbors AS (
    SELECT te.entity_id, COUNT(*)::BIGINT AS co_weight
    FROM public.thought_entities te
    JOIN scoped_thoughts st ON st.thought_id = te.thought_id
    WHERE te.entity_id <> ALL(p_focus_ids)
    GROUP BY te.entity_id
    HAVING COUNT(*) >= p_min_weight
  ),
  inferred_neighbors AS (
    SELECT DISTINCT
      CASE WHEN ed.from_entity_id = ANY(p_focus_ids)
           THEN ed.to_entity_id::INT
           ELSE ed.from_entity_id::INT
      END AS entity_id,
      0::BIGINT AS co_weight
    FROM public.edges ed
    WHERE (ed.from_entity_id = ANY(p_focus_ids) OR ed.to_entity_id = ANY(p_focus_ids))
      AND ed.metadata->>'source' IN ('inferred', 'manual')
  ),
  all_neighbors AS (
    SELECT entity_id, MAX(co_weight) AS co_weight FROM (
      SELECT entity_id, co_weight FROM co_neighbors
      UNION ALL
      SELECT entity_id, co_weight FROM inferred_neighbors
    ) u
    WHERE entity_id <> ALL(p_focus_ids)
    GROUP BY entity_id
  ),
  filtered_neighbors AS (
    SELECT an.entity_id, an.co_weight
    FROM all_neighbors an
    JOIN public.entities e ON e.id = an.entity_id
    WHERE p_excluded_types IS NULL OR NOT (e.entity_type = ANY(p_excluded_types))
    ORDER BY an.co_weight DESC
    LIMIT GREATEST(0, p_limit - cardinality(p_focus_ids))
  ),
  full_set AS (
    SELECT unnest(p_focus_ids) AS entity_id
    UNION
    SELECT entity_id FROM filtered_neighbors
  ),
  mention_counts AS (
    SELECT te.entity_id::INT AS entity_id, COUNT(*)::BIGINT AS mentions
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
    COALESCE(mc.mentions, 0)::BIGINT,
    dc.dominant
  FROM full_set fs
  JOIN public.entities e ON e.id = fs.entity_id
  LEFT JOIN mention_counts mc ON mc.entity_id = fs.entity_id
  LEFT JOIN public.entity_dominant_classification(5000) dc ON dc.entity_id = e.id
  ORDER BY mc.mentions DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.constellation_focus_neighbors_multi(INT[], INT, INT, TEXT, INT, TEXT[]) TO service_role;

-- Extend the partial index to cover manual edges too — the focus_neighbors
-- and constellation_inferred_edges RPCs both filter on this predicate now.
DROP INDEX IF EXISTS public.idx_edges_inferred;
CREATE INDEX IF NOT EXISTS idx_edges_curated
  ON public.edges ((metadata->>'source'))
  WHERE metadata->>'source' IN ('inferred', 'manual');

NOTIFY pgrst, 'reload schema';
