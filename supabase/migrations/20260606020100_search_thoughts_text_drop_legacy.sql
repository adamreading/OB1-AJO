-- search_thoughts_text had two overloads after today's enhanced-thoughts
-- schema landed:
--   search_thoughts_text(p_query text, p_limit int, p_metadata_filter jsonb, p_offset int, p_exclude_restricted bool)  -- legacy
--   search_thoughts_text(p_query text, p_limit int, p_filter jsonb, p_offset int)                                       -- new (today)
-- The smoke test (and any 3-arg caller using p_query+p_limit+p_offset) hit
-- a PGRST203 "could not choose best candidate" because both functions match
-- those three positional/named args. Drop the legacy 5-arg version. No
-- caller in the codebase uses p_metadata_filter or p_exclude_restricted,
-- verified via grep on 2026-06-06. The new 4-arg version has the indexed
-- tsvector path and covers all current use cases.

DROP FUNCTION IF EXISTS search_thoughts_text(TEXT, INTEGER, JSONB, INTEGER, BOOLEAN);

NOTIFY pgrst, 'reload schema';
