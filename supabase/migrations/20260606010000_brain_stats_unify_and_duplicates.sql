-- Three fixes in one migration:
--
-- 1. brain_stats_aggregate had two colliding overloads after the
--    enhanced-thoughts schema landed today:
--       brain_stats_aggregate(p_since_days int, p_classification text)   -- legacy
--       brain_stats_aggregate(p_since_days int, p_exclude_restricted bool) -- new
--    PostgREST returned PGRST203 ("could not choose best candidate") for
--    unqualified callers, and the MCP server's call with p_classification
--    was hitting the legacy one which has no top_topics aggregation, so
--    /thought_stats was returning blank top_topics even after enrichment
--    populated metadata.topics. Drop both. Recreate ONE function with
--    p_classification + p_exclude_restricted + top_topics aggregation.
--
-- 2. brain_duplicates_find RPC was missing entirely. The dashboard
--    /duplicates UI and the MCP find_duplicates tool both error with
--    "Could not find the function public.brain_duplicates_find" because
--    the RPC was never shipped. Add it: pgvector cosine similarity over
--    thoughts.embedding, optional classification filter, returns pairs
--    above threshold.
--
-- 3. Both new functions get explicit GRANT EXECUTE so PostgREST can call.

-- ============================================================
-- 1. brain_stats_aggregate — unified
-- ============================================================

DROP FUNCTION IF EXISTS brain_stats_aggregate(INTEGER, TEXT);
DROP FUNCTION IF EXISTS brain_stats_aggregate(INTEGER, BOOLEAN);

CREATE OR REPLACE FUNCTION brain_stats_aggregate(
  p_since_days INTEGER DEFAULT 30,
  p_classification TEXT DEFAULT NULL,
  p_exclude_restricted BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_total BIGINT;
  v_types JSONB;
  v_topics JSONB;
  v_since TIMESTAMPTZ;
BEGIN
  IF p_since_days > 0 THEN
    v_since := now() - (p_since_days || ' days')::interval;
  ELSE
    v_since := '-infinity'::timestamptz;
  END IF;

  SELECT count(*) INTO v_total
  FROM public.thoughts
  WHERE (NOT p_exclude_restricted OR sensitivity_tier IS DISTINCT FROM 'restricted')
    AND (p_classification IS NULL OR classification = p_classification);

  SELECT coalesce(jsonb_agg(jsonb_build_object('type', t.type, 'count', t.cnt)), '[]'::jsonb)
  INTO v_types FROM (
    SELECT type, count(*) AS cnt FROM public.thoughts
    WHERE created_at >= v_since
      AND (NOT p_exclude_restricted OR sensitivity_tier IS DISTINCT FROM 'restricted')
      AND (p_classification IS NULL OR classification = p_classification)
    GROUP BY type ORDER BY cnt DESC LIMIT 20
  ) t;

  SELECT coalesce(jsonb_agg(jsonb_build_object('topic', t.topic, 'count', t.cnt)), '[]'::jsonb)
  INTO v_topics FROM (
    SELECT topic.value AS topic, count(*) AS cnt
    FROM public.thoughts,
         jsonb_array_elements_text(coalesce(metadata->'topics', '[]'::jsonb)) AS topic(value)
    WHERE created_at >= v_since
      AND (NOT p_exclude_restricted OR sensitivity_tier IS DISTINCT FROM 'restricted')
      AND (p_classification IS NULL OR classification = p_classification)
    GROUP BY topic.value ORDER BY cnt DESC LIMIT 20
  ) t;

  RETURN jsonb_build_object('total', v_total, 'top_types', v_types, 'top_topics', v_topics);
END;
$$;

GRANT EXECUTE ON FUNCTION brain_stats_aggregate(INTEGER, TEXT, BOOLEAN)
  TO authenticated, anon, service_role;

-- ============================================================
-- 2. brain_duplicates_find — pgvector similarity over thoughts.embedding
-- ============================================================

DROP FUNCTION IF EXISTS brain_duplicates_find(NUMERIC, INTEGER, TEXT);
DROP FUNCTION IF EXISTS brain_duplicates_find(DOUBLE PRECISION, INTEGER, TEXT);

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
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
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

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
