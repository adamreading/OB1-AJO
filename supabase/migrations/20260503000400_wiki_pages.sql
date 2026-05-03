CREATE TABLE IF NOT EXISTS public.wiki_pages (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'entity' CHECK (type IN ('entity', 'topic')),
  entity_id BIGINT REFERENCES public.entities(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  thought_count INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  manually_edited BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_type ON public.wiki_pages (type);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_entity_id ON public.wiki_pages (entity_id);
NOTIFY pgrst, 'reload schema';
