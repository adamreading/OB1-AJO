-- Cross-link inference + type-aware clustering support.
--
-- Three things in one migration because they all touch the constellation
-- RPCs (constellation_top_entities, constellation_focus_neighbors,
-- constellation_focus_neighbors_multi) and the return signatures change.
-- Splitting would mean DROP/RECREATE twice and two separate Edge Function
-- redeploys — not worth the noise.
--
-- 1. constellation_inferred_edges(p_entity_ids) — sibling to the existing
--    constellation_co_occurrence. Returns rows from the `edges` table where
--    BOTH endpoints are in the provided id set AND metadata.source='inferred'.
--    Lets the /constellation handler merge inferred edges into the visual
--    graph, distinguishable by the `inferred` flag.
--
-- 2. entity_dominant_classification(p_limit) — for each entity, the dominant
--    classification (work | personal | null) computed across the entity's
--    linked thoughts. The constellation RPCs LEFT JOIN this so the dashboard
--    layout can cluster work entities left, personal right.
--
-- 3. constellation_focus_neighbors (single + multi) get expanded: a neighbour
--    can now be reached EITHER via co-occurrence in a thought OR via an
--    inferred edge in the `edges` table. Without this, a Kate↔Taplow
--    inferred edge would write to `edges` but Kate wouldn't show up when
--    Alex (her husband) is focused, because the old neighbour query was
--    purely thought-entities based.
--
-- All three constellation_* RPCs gain a `dominant_classification` column.
-- Edge Function signature changes are deployed in the same release.

-- ---------------------------------------------------------------------------
-- 1. constellation_inferred_edges
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.constellation_inferred_edges(
  p_entity_ids INT[]
)
RETURNS TABLE (
  source INT,
  target INT,
  relation TEXT,
  weight BIGINT,
  inferred BOOLEAN
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
    TRUE AS inferred
  FROM public.edges e
  WHERE e.from_entity_id = ANY(p_entity_ids)
    AND e.to_entity_id   = ANY(p_entity_ids)
    AND e.metadata->>'source' = 'inferred';
$$;

GRANT EXECUTE ON FUNCTION public.constellation_inferred_edges(INT[]) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. entity_dominant_classification
-- ---------------------------------------------------------------------------
-- For each entity, count thoughts classified 'work' vs 'personal' and emit
-- the dominant string. Ties (or no classification on any linked thought)
-- return NULL so the dashboard can treat them as neutral.
CREATE OR REPLACE FUNCTION public.entity_dominant_classification(
  p_limit INT DEFAULT 5000
)
RETURNS TABLE (
  entity_id INT,
  work_count BIGINT,
  personal_count BIGINT,
  dominant TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH counts AS (
    SELECT
      te.entity_id::INT AS entity_id,
      COUNT(*) FILTER (WHERE t.metadata->>'classification' = 'work')::BIGINT     AS work_count,
      COUNT(*) FILTER (WHERE t.metadata->>'classification' = 'personal')::BIGINT AS personal_count
    FROM public.thought_entities te
    JOIN public.thoughts t ON t.id = te.thought_id
    GROUP BY te.entity_id
  )
  SELECT
    entity_id,
    work_count,
    personal_count,
    CASE
      WHEN work_count > personal_count THEN 'work'
      WHEN personal_count > work_count THEN 'personal'
      ELSE NULL
    END AS dominant
  FROM counts
  ORDER BY (work_count + personal_count) DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.entity_dominant_classification(INT) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Constellation RPCs — recreate with dominant_classification column and
--    inferred-edge neighbour expansion.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.constellation_top_entities(INT, INT, TEXT, TEXT[]);

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
  mentions BIGINT,
  dominant_classification TEXT
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
  ),
  top_n AS (
    SELECT
      e.id::INT AS entity_id,
      e.canonical_name,
      e.entity_type,
      COUNT(*)::BIGINT AS mentions
    FROM scoped s
    JOIN public.entities e ON e.id = s.entity_id
    WHERE p_excluded_types IS NULL OR NOT (e.entity_type = ANY(p_excluded_types))
    GROUP BY e.id, e.canonical_name, e.entity_type
    ORDER BY mentions DESC
    LIMIT p_limit
  )
  SELECT
    tn.entity_id,
    tn.canonical_name,
    tn.entity_type,
    tn.mentions,
    dc.dominant
  FROM top_n tn
  LEFT JOIN public.entity_dominant_classification(5000) dc ON dc.entity_id = tn.entity_id;
$$;

GRANT EXECUTE ON FUNCTION public.constellation_top_entities(INT, INT, TEXT, TEXT[]) TO service_role;

-- ---

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
  -- Inferred-edge neighbours: any entity reachable from the focus via an
  -- inferred edge (regardless of direction). These wouldn't appear in
  -- co_neighbors because they have no shared thought. Without this branch
  -- inferred edges would write to `edges` but the focus mode constellation
  -- would still hide the new neighbours.
  inferred_neighbors AS (
    SELECT DISTINCT
      CASE WHEN ed.from_entity_id = p_focus_id THEN ed.to_entity_id::INT ELSE ed.from_entity_id::INT END AS entity_id,
      0::BIGINT AS co_weight
    FROM public.edges ed
    WHERE (ed.from_entity_id = p_focus_id OR ed.to_entity_id = p_focus_id)
      AND ed.metadata->>'source' = 'inferred'
  ),
  all_neighbors AS (
    -- UNION dedupes; co_neighbors wins co_weight via outer aggregate
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

-- ---

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
      AND ed.metadata->>'source' = 'inferred'
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

-- Index hint for edges.metadata->>'source' queries. Partial index on the
-- inferred subset so the planner can fast-path the 'where source=inferred'
-- filter that the new RPCs use. Without this Postgres falls back to a seq
-- scan of `edges` for every constellation request.
CREATE INDEX IF NOT EXISTS idx_edges_inferred
  ON public.edges ((metadata->>'source'))
  WHERE metadata->>'source' = 'inferred';

NOTIFY pgrst, 'reload schema';
