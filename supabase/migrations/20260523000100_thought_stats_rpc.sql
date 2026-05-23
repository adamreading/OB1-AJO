-- thought_stats_summary — server-side aggregation for /stats
--
-- Replaces the "fetch a slab of rows and aggregate in JS" anti-pattern
-- in rest-api/index.ts's /stats endpoint. With PostgREST's default 1000-
-- row response limit, the previous JS aggregation silently truncated
-- once thought count exceeded 1000 — type counts under-reported as the
-- brain grew. This RPC does GROUP BY in Postgres so the answer is
-- correct regardless of total row count.
--
-- Differs from the upstream recipe version (recipes/edge-function-cost-
-- optimization/migrations/20260417_edge_fn_optimizations.sql):
--  - AJO promotes `type` and `classification` to top-level columns, so
--    we GROUP BY the column directly instead of reading metadata->>'type'.
--  - Accepts an optional p_classification filter to match the endpoint's
--    ?classification=work|personal query parameter.
--  - Returns rows (TABLE) rather than jsonb so PostgREST renders a clean
--    JSON shape with one column per field.

CREATE OR REPLACE FUNCTION public.thought_stats_summary(
  p_classification TEXT DEFAULT NULL
)
RETURNS TABLE (
  total BIGINT,
  first_ts TIMESTAMPTZ,
  last_ts TIMESTAMPTZ,
  types JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH filtered AS (
    SELECT id, type, created_at
    FROM public.thoughts
    WHERE p_classification IS NULL
       OR classification = p_classification
       OR metadata->>'classification' = p_classification
  ),
  totals AS (
    SELECT
      COUNT(*)::BIGINT AS total,
      MIN(created_at) AS first_ts,
      MAX(created_at) AS last_ts
    FROM filtered
  ),
  type_counts AS (
    SELECT COALESCE(
      jsonb_object_agg(t, cnt ORDER BY cnt DESC),
      '{}'::jsonb
    ) AS types
    FROM (
      SELECT COALESCE(type, 'thought') AS t, COUNT(*)::BIGINT AS cnt
      FROM filtered
      GROUP BY COALESCE(type, 'thought')
    ) s
  )
  SELECT
    totals.total,
    totals.first_ts,
    totals.last_ts,
    type_counts.types
  FROM totals, type_counts;
$$;

GRANT EXECUTE ON FUNCTION public.thought_stats_summary(TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
