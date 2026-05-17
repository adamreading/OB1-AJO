-- Reflections — structured side-records attached to a thought that capture
-- the *reasoning* behind it (the deliberation that led to a decision,
-- options considered, factors weighed, the conclusion reached).
--
-- The dashboard's ReflectionComposer + thought-detail render block + REST
-- endpoint + MCP add_reflection tool all referenced a `reflections` table
-- that was never created. This migration creates the canonical schema all
-- four call sites are now aligned against.
--
-- Reflection types: decision_trace, lesson_trace, retrospective, hypothesis,
-- and a generic "general" default for AI-attached reflections that don't
-- fit the structured forms.

CREATE TABLE IF NOT EXISTS reflections (
  id              SERIAL PRIMARY KEY,
  thought_id      UUID NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  reflection_type TEXT NOT NULL DEFAULT 'general',
  trigger_context TEXT DEFAULT '',
  options         JSONB DEFAULT '[]'::jsonb,
  factors         JSONB DEFAULT '[]'::jsonb,
  conclusion      TEXT DEFAULT '',
  confidence      NUMERIC DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Index for the most common access pattern: render all reflections for a
-- given thought (dashboard detail page).
CREATE INDEX IF NOT EXISTS reflections_thought_id_idx ON reflections(thought_id);

-- Index for type-filtering, in case we later surface a "lessons" or
-- "decision traces" view across the brain.
CREATE INDEX IF NOT EXISTS reflections_type_idx ON reflections(reflection_type);
