-- search_entities — DB-side entity search that matches both canonical_name AND
-- any alias (case-insensitive). Powers the dashboard MergeModal's
-- search-on-input picker, so the user can type a fragment of an alias and
-- still find the entity (the previous endpoint only matched canonical_name).

CREATE OR REPLACE FUNCTION public.search_entities(
  p_search TEXT DEFAULT NULL,
  p_no_wiki BOOLEAN DEFAULT FALSE,
  p_limit INT DEFAULT 500
)
RETURNS TABLE (
  id INT,
  canonical_name TEXT,
  entity_type TEXT,
  aliases TEXT[],
  normalized_name TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    e.id::INT,
    e.canonical_name,
    e.entity_type,
    e.aliases,
    e.normalized_name
  FROM public.entities e
  WHERE
    -- search filter: matches canonical_name OR any alias
    (
      p_search IS NULL
      OR p_search = ''
      OR e.canonical_name ILIKE '%' || p_search || '%'
      OR EXISTS (
        SELECT 1 FROM unnest(COALESCE(e.aliases, ARRAY[]::TEXT[])) AS a
        WHERE a ILIKE '%' || p_search || '%'
      )
    )
    AND (
      NOT p_no_wiki
      OR NOT EXISTS (
        SELECT 1 FROM public.wiki_pages wp WHERE wp.entity_id = e.id
      )
    )
  ORDER BY e.canonical_name
  LIMIT GREATEST(1, LEAST(p_limit, 5000));
$$;

GRANT EXECUTE ON FUNCTION public.search_entities(TEXT, BOOLEAN, INT) TO service_role;

NOTIFY pgrst, 'reload schema';
