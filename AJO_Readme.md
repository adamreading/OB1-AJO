# Open Brain Pro (AJO Version) — Complete Setup Guide

This is the definitive "ground-up" guide for building the AJO fork of Open Brain. Once finished, you will have a personal knowledge system with automatic "Work vs Personal" classification, local entity graph extraction, semantic search, compiled wiki generation (with auto-trigger), and a full Next.js dashboard.

---

## 📋 Phase 0: Prerequisites & Credential Tracker

You'll be generating API keys and passwords across several services. **Do not trust your memory.** Create a text file called `credentials.txt` and save these as you go:

1.  **Supabase Account**: Sign up at [supabase.com](https://supabase.com).
2.  **Ollama**: Install [Ollama](https://ollama.com) locally for background classification, entity graph extraction, and wiki compilation. Pull the default model: `ollama pull qwen3:30b`
3.  **OpenRouter Account (optional)**: Only needed if you want hosted embeddings or metadata extraction inside Edge Functions.

| Credential | Where to find it |
| :--- | :--- |
| `SUPABASE_PROJECT_REF` | Dashboard URL: `project/THIS_PART` |
| `SUPABASE_DB_PASSWORD` | You set this during project creation |
| `SUPABASE_SERVICE_ROLE_KEY` | Settings → API → `service_role` |
| `SUPABASE_ANON_KEY` | Settings → API → `anon` (public) |
| `OPENROUTER_API_KEY` | Optional: openrouter.ai/keys |
| `BRAIN_KEY` | You choose this (dashboard API password) |
| `MCP_ACCESS_KEY` | You choose this (for remote AI/MCP access) |

---

## 🛠️ Phase 1: Supabase Project Setup

1.  **Create Project**: Go to [Supabase](https://supabase.com) → **New Project**.
2.  **Details**: Name it `open-brain`, set a strong **Database Password**, and pick a region near you.
3.  **Wait**: It takes about 2 minutes to provision.
4.  **Grab Details**: Go to **Settings** (gear) → **API**. Copy your **Project URL**, the **`service_role` (secret)** key, and the **`anon` (public)** key.
5.  **Enable pgvector**: Database → Extensions → search "vector" → flip pgvector ON.

---

## 💻 Phase 2: CLI & Project Linking

### 1. Install Supabase CLI
*   **Mac/Linux**: `brew install supabase/tap/supabase`
*   **Windows (PowerShell)**:
    ```powershell
    scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
    scoop install supabase
    ```

### 2. Initialize and Link
In your terminal, navigate to your project folder and run:
```powershell
supabase login
supabase init
supabase link --project-ref your-project-ref
```

---

## 🗄️ Phase 3: AJO SQL Schema

Run each block below in your Supabase **SQL Editor** (New Query → Run). Run them in order.

### Block 1: Core Thoughts Table + Functions

```sql
-- 1. Thoughts Table (The Core)
CREATE TABLE IF NOT EXISTS thoughts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  serial_id SERIAL UNIQUE,
  content TEXT NOT NULL,
  type TEXT DEFAULT 'observation',
  status TEXT DEFAULT 'backlog' CHECK (status IN ('backlog', 'planning', 'active', 'review', 'done', 'archived')),
  importance INTEGER DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  quality_score INTEGER DEFAULT 50,
  classification TEXT DEFAULT 'personal' CHECK (classification IN ('work', 'personal')),
  embedding VECTOR(1536),
  metadata JSONB DEFAULT '{}'::jsonb,
  sensitivity_tier TEXT DEFAULT 'standard',
  source_type TEXT DEFAULT 'manual',
  status_updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  version INTEGER DEFAULT 1,
  content_fingerprint TEXT UNIQUE
);

-- 2. Thought Versions (archiving updates)
CREATE TABLE IF NOT EXISTS thought_versions (
  id SERIAL PRIMARY KEY,
  thought_id UUID REFERENCES thoughts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Reflections Table
CREATE TABLE IF NOT EXISTS reflections (
  id SERIAL PRIMARY KEY,
  thought_id UUID REFERENCES thoughts(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  trigger_context TEXT,
  conclusion TEXT,
  options JSONB DEFAULT '[]'::jsonb,
  factors JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Ingestion Jobs (bulk import tracking)
CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id SERIAL PRIMARY KEY,
  source_label TEXT DEFAULT 'manual',
  status TEXT DEFAULT 'pending',
  extracted_count INTEGER DEFAULT 0,
  added_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- 5. Ingestion Items (individual extracted thoughts per job)
CREATE TABLE IF NOT EXISTS ingestion_items (
  id SERIAL PRIMARY KEY,
  job_id INTEGER REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  type TEXT DEFAULT 'observation',
  fingerprint TEXT DEFAULT '',
  action TEXT DEFAULT 'pending',
  status TEXT DEFAULT 'pending',
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 6. Semantic Search Function
CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.3,
  match_count int DEFAULT 20,
  filter jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id uuid,
  serial_id int,
  content text,
  type text,
  status text,
  importance int,
  classification text,
  metadata jsonb,
  similarity float,
  created_at timestamptz
) LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id,
    t.serial_id,
    t.content,
    t.type,
    t.status,
    t.importance,
    t.classification,
    t.metadata,
    1 - (t.embedding <=> query_embedding) AS similarity,
    t.created_at
  FROM thoughts t
  WHERE 1 - (t.embedding <=> query_embedding) > match_threshold
    AND (filter = '{}'::jsonb OR t.metadata @> filter)
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;

-- 7. Upsert Thought (idempotent capture with fingerprinting)
CREATE OR REPLACE FUNCTION upsert_thought(p_content TEXT, p_payload JSONB DEFAULT '{}')
RETURNS JSONB AS $$
DECLARE
  v_fingerprint TEXT;
  v_result JSONB;
  v_id UUID;
  v_serial INT;
BEGIN
  v_fingerprint := encode(sha256(convert_to(
    lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))),
    'UTF8'
  )), 'hex');

  INSERT INTO thoughts (content, content_fingerprint, metadata, type, importance, sensitivity_tier, source_type)
  VALUES (
    p_content,
    v_fingerprint,
    COALESCE(p_payload->'metadata', '{}'::jsonb),
    COALESCE(p_payload->>'type', 'observation'),
    COALESCE((p_payload->>'importance')::int, 3),
    COALESCE(p_payload->>'sensitivity_tier', 'standard'),
    COALESCE(p_payload->>'source_type', 'manual')
  )
  ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
  SET updated_at = now(),
      metadata = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb)
  RETURNING id, serial_id INTO v_id, v_serial;

  v_result := jsonb_build_object('id', v_id, 'serial_id', v_serial, 'fingerprint', v_fingerprint);
  RETURN v_result;
END;
$$ LANGUAGE plpgsql;

-- 8. Find Duplicates (vector similarity pairs)
CREATE OR REPLACE FUNCTION brain_duplicates_find(
  p_threshold float DEFAULT 0.85,
  p_limit int DEFAULT 50,
  p_classification text DEFAULT NULL
)
RETURNS TABLE (
  thought_a_serial int,
  thought_b_serial int,
  content_a text,
  content_b text,
  similarity float
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    t1.serial_id AS thought_a_serial,
    t2.serial_id AS thought_b_serial,
    t1.content AS content_a,
    t2.content AS content_b,
    1 - (t1.embedding <=> t2.embedding) AS similarity
  FROM thoughts t1
  JOIN thoughts t2 ON t1.id < t2.id
  WHERE (p_classification IS NULL OR (t1.metadata->>'classification' = p_classification AND t2.metadata->>'classification' = p_classification))
    AND 1 - (t1.embedding <=> t2.embedding) > p_threshold
  ORDER BY similarity DESC
  LIMIT p_limit;
END;
$$;

-- 9. Aggregate Stats
CREATE OR REPLACE FUNCTION brain_stats_aggregate(
  p_since_days int DEFAULT 30,
  p_classification text DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_total int;
  v_types jsonb;
BEGIN
  SELECT count(*) INTO v_total
  FROM thoughts
  WHERE created_at > now() - (p_since_days || ' days')::interval
    AND (p_classification IS NULL OR metadata->>'classification' = p_classification);

  SELECT jsonb_object_agg(type, count) INTO v_types
  FROM (
    SELECT COALESCE(type, 'observation') as type, count(*) as count
    FROM thoughts
    WHERE created_at > now() - (p_since_days || ' days')::interval
      AND (p_classification IS NULL OR metadata->>'classification' = p_classification)
    GROUP BY type
  ) t;

  RETURN jsonb_build_object(
    'total', v_total,
    'types', COALESCE(v_types, '{}'::jsonb),
    'top_topics', '[]'::jsonb,
    'window_days', p_since_days
  );
END;
$$;
```

> **Tip:** If semantic search later returns `operator does not exist: vector <=> vector`, run:
> ```sql
> ALTER FUNCTION match_thoughts(vector, float, int, jsonb)
>   SET search_path = public, extensions;
> ```

---

### Block 2: Entity Extraction Graph

```sql
-- Entities (canonical graph nodes)
CREATE TABLE IF NOT EXISTS public.entities (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_type, normalized_name)
);

-- Entity-to-entity edges
CREATE TABLE IF NOT EXISTS public.edges (
  id BIGSERIAL PRIMARY KEY,
  from_entity_id BIGINT NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  to_entity_id BIGINT NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  support_count INT NOT NULL DEFAULT 1,
  confidence NUMERIC(3,2),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  decay_weight NUMERIC(3,2),
  UNIQUE (from_entity_id, to_entity_id, relation)
);

-- Thought-entity links
CREATE TABLE IF NOT EXISTS public.thought_entities (
  thought_id UUID NOT NULL REFERENCES public.thoughts(id) ON DELETE CASCADE,
  entity_id BIGINT NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  mention_role TEXT NOT NULL DEFAULT 'mentioned',
  confidence NUMERIC(3,2),
  source TEXT NOT NULL DEFAULT 'entity_worker',
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (thought_id, entity_id, mention_role)
);

-- Entity extraction queue
CREATE TABLE IF NOT EXISTS public.entity_extraction_queue (
  thought_id UUID PRIMARY KEY REFERENCES public.thoughts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'complete', 'failed', 'skipped')),
  attempt_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  source_fingerprint TEXT,
  source_updated_at TIMESTAMPTZ,
  worker_version TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Consolidation log (audit trail for merges)
CREATE TABLE IF NOT EXISTS public.consolidation_log (
  id BIGSERIAL PRIMARY KEY,
  operation TEXT NOT NULL,
  survivor_id UUID,
  loser_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_entities_type ON public.entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_normalized ON public.entities(normalized_name);
CREATE INDEX IF NOT EXISTS idx_edges_from ON public.edges(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON public.edges(to_entity_id);
CREATE INDEX IF NOT EXISTS idx_thought_entities_entity ON public.thought_entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_thought_entities_thought ON public.thought_entities(thought_id);
CREATE INDEX IF NOT EXISTS idx_extraction_queue_status
  ON public.entity_extraction_queue(status)
  WHERE status = 'pending';

-- Auto-queue trigger: when a thought is inserted or content changes, queue for extraction
CREATE OR REPLACE FUNCTION public.queue_entity_extraction()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_source_fingerprint TEXT;
BEGIN
  IF NEW.metadata->>'generated_by' IS NOT NULL THEN RETURN NEW; END IF;
  v_source_fingerprint := COALESCE(
    NEW.content_fingerprint,
    md5(lower(trim(regexp_replace(NEW.content, '\s+', ' ', 'g'))))
  );
  INSERT INTO public.entity_extraction_queue (thought_id, status, source_fingerprint, source_updated_at)
  VALUES (NEW.id, 'pending', v_source_fingerprint, NEW.updated_at)
  ON CONFLICT (thought_id) DO UPDATE SET
    status = 'pending', attempt_count = 0, last_error = NULL, queued_at = now(),
    source_fingerprint = EXCLUDED.source_fingerprint,
    source_updated_at = EXCLUDED.source_updated_at
  WHERE entity_extraction_queue.source_fingerprint IS DISTINCT FROM EXCLUDED.source_fingerprint;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_queue_entity_extraction ON public.thoughts;
CREATE TRIGGER trg_queue_entity_extraction
  AFTER INSERT OR UPDATE OF content, metadata ON public.thoughts
  FOR EACH ROW EXECUTE FUNCTION public.queue_entity_extraction();

-- RLS + Grants
ALTER TABLE public.entities               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edges                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thought_entities       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entity_extraction_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consolidation_log      ENABLE ROW LEVEL SECURITY;

CREATE POLICY entities_service_role_all ON public.entities FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY edges_service_role_all ON public.edges FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY thought_entities_service_role_all ON public.thought_entities FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY entity_extraction_queue_service_role_all ON public.entity_extraction_queue FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY consolidation_log_service_role_all ON public.consolidation_log FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT ALL ON public.entities, public.edges, public.thought_entities,
             public.entity_extraction_queue, public.consolidation_log TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

NOTIFY pgrst, 'reload schema';
```

> **Backfill existing thoughts** (run once after applying schema to an existing brain):
> ```sql
> INSERT INTO public.entity_extraction_queue (thought_id, status, source_fingerprint, source_updated_at)
> SELECT id, 'pending', content_fingerprint, updated_at
> FROM public.thoughts
> WHERE (metadata->>'generated_by') IS NULL
> ON CONFLICT (thought_id) DO NOTHING;
> ```

---

### Block 3: Wiki Pages

```sql
CREATE TABLE IF NOT EXISTS public.wiki_pages (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'entity' CHECK (type IN ('entity', 'topic')),
  entity_id BIGINT REFERENCES public.entities(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  notes TEXT DEFAULT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  thought_count INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  manually_edited BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wiki_pages_type ON public.wiki_pages (type);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_entity_id ON public.wiki_pages (entity_id);

ALTER TABLE public.wiki_pages ENABLE ROW LEVEL SECURITY;
CREATE POLICY wiki_pages_service_role_all ON public.wiki_pages FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.wiki_pages TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.wiki_pages_id_seq TO service_role;

NOTIFY pgrst, 'reload schema';
```

> **If upgrading an existing install**, run this migration to add the `notes` column:
> ```sql
> ALTER TABLE public.wiki_pages ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT NULL;
> NOTIFY pgrst, 'reload schema';
> ```

---

## ⚡ Phase 4: Supabase Edge Functions

Two Edge Functions serve the AJO fork. Both are in this repo and must be deployed from the project root.

### Routes provided by `rest-api`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check |
| GET | `/stats` | Dashboard summary counts |
| GET | `/thoughts` | Paginated thought list (type, status, classification filters) |
| GET | `/search` | Semantic search (falls back to text if embeddings unavailable) |
| GET | `/duplicates` | Find near-duplicate thoughts |
| GET/PUT/DELETE | `/thought/:id` | Single thought CRUD |
| GET/POST | `/thought/:id/reflection` | Reflections on a thought |
| POST | `/capture` | Quick single-thought add with dedup fingerprinting |
| POST | `/capture-pending` | Capture thought pending human review — stores `metadata.review_status: pending_review` without queueing for entity extraction. Accepts `type`, `classification`, `ollama_decision`, `update_target_id`, `original_content`. Used by the Plaud webhook. |
| POST | `/review/approve` | Batch approve pending thoughts by `serial_id` array. NEW: queues for extraction + embedding, clears review_status. UPDATE: applies merged content to target thought, re-queues target, deletes pending vessel. |
| GET | `/ingestion-jobs` | List bulk import jobs |
| GET | `/ingestion-jobs/:id` | Single job + items |
| POST | `/ingest` | Extract and commit a block of text as thoughts |
| POST | `/ingestion-jobs/:id/execute` | Execute a pending job's items |
| GET | `/thoughts` | Now also accepts `review_status` (`pending_review` / `approved`) and `source_type` query filters |
| GET | `/action-items` | Thoughts with non-empty `metadata.action_items`; supports `classification`, `since_hours`, `limit` |
| GET | `/wiki-pages?page=&per_page=` | List wiki pages, paginated (default per_page 5000, max 10000). Returns `{ data, total, page, per_page }` |
| GET | `/wiki-pages/:slug` | Single wiki page with full content |
| PUT | `/wiki-pages/:slug` | Update wiki page content |
| PATCH | `/wiki-pages/:slug/notes` | Update curator notes only (never overwritten by compiler). Treated as HIGHEST AUTHORITY by the regen prompt. |
| GET | `/entities` | Search entities. `?search=` matches canonical_name OR any alias (case-insensitive). RPC-backed. `?no_wiki=true` filters to entities without a wiki page. |
| GET | `/entities/:id/edges` | Edges touching the entity, with `other_slug` joined for one-click navigation. |
| PATCH | `/entities/:id` | Rename entity (`canonical_name`) and/or reclassify (`entity_type`). Auto-absorbs invisible duplicates by `(entity_type, normalized_name)`. |
| PATCH | `/entities/:id/aliases` | Add or remove an alias. **Add** auto-absorbs any other entity whose canonical_name OR existing alias matches under loose normalization (lowercase, hyphen↔space). **Remove** options: `action: "remove"` drops the alias only; `action: "remove_and_resplit"` ALSO re-queues every linked thought into `entity_extraction_queue` so the worker re-derives entities and recreates anything the alias was masking — use this to undo a bad auto-absorb. |
| POST | `/entities/:id/merge` | Merge source entity into target (moves all thoughts + edges) |
| DELETE | `/entities/:id` | Delete entity + wiki page (thought_entities and edges cascade) |
| GET | `/entity-types` | Distinct entity_types with color + count. RPC-backed (`entity_types_summary()`) — no row cap. |
| GET | `/sources` | Distinct source_type values from thoughts with counts. RPC-backed (`sources_summary()`) — no row cap. |
| GET | `/constellation?days=&limit=&min_weight=&classification=` | Top-N entities by mention count + co-occurrence edges (RPC-backed via `constellation_top_entities` + `constellation_co_occurrence`). Each node carries its wiki `slug`. |
| GET | `/health/quotas` | For each cap-bound table, reports current row count vs cap + utilization. Aggregations report cap as null/∞ (RPC-backed, no row cap). The dashboard polls this and shows a warning banner at >80% utilization. |

### Deploy via CLI

```powershell
# 1. Login and link your project
supabase login
supabase link --project-ref your-project-ref

# 2. Set secrets
supabase secrets set BRAIN_KEY="your-api-password"
supabase secrets set MCP_ACCESS_KEY="your-mcp-access-key"
# Optional hosted embeddings/extraction fallback:
# supabase secrets set OPENROUTER_API_KEY="your-openrouter-key"

# 3. Deploy both functions
# IMPORTANT: always use --use-api --no-verify-jwt for this fork
npx.cmd supabase functions deploy rest-api --use-api --no-verify-jwt
npx.cmd supabase functions deploy open-brain-mcp --use-api --no-verify-jwt
```

> **Why `--use-api --no-verify-jwt`?** The `rest-api` function uses `x-brain-key` header auth instead of Supabase JWT tokens. Without `--no-verify-jwt`, Supabase's JWT middleware intercepts requests before the function code runs and returns 401. `--use-api` forces the CLI to use the Management API instead of Docker for deployment (required on Windows and in CI).

### Set Edge Function secrets

In Supabase Dashboard → **Edge Functions** → **Manage secrets**, add:

| Secret | Value |
|--------|-------|
| `BRAIN_KEY` | Your chosen API password (must match dashboard `.env.local`) |
| `MCP_ACCESS_KEY` | Your chosen MCP connector password |
| `OPENROUTER_API_KEY` | Optional: hosted embeddings and metadata extraction |
| `OPEN_BRAIN_CITATION_BASE_URL` | Optional: base URL for thought citation links in MCP results (default: `https://openbrain.local/thoughts`) |

> `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — do not add them manually.

---

## 🌐 Phase 5: Local Environment & Worker

### 1. Root `.env` Setup

Create a file named `.env` in the project root:

```env
SUPABASE_URL="https://your-project-ref.supabase.co"
SUPABASE_KEY="your-service-role-key"
BRAIN_KEY="your-api-password"
OLLAMA_URL="http://localhost:11434/api"
OLLAMA_MODEL="qwen3:30b"
KANBAN_INITIAL_STATUS="backlog"

WORK_CONTEXT_DESC="Professional work, software development, and corporate projects"
PERSONAL_CONTEXT_DESC="Home life, hobbies, fitness, and family"

# Plaud webhook (optional — default port is 4001)
# PLAUD_WEBHOOK_PORT=4001
```

> **Note:** The wiki compiler also uses these env vars via the fallback aliases `OPEN_BRAIN_URL` (= `SUPABASE_URL`) and `OPEN_BRAIN_SERVICE_KEY` (= `SUPABASE_KEY`). The generate-wiki.mjs script handles both names automatically. The `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY` env vars are not required — the script detects `OLLAMA_URL` and derives the OpenAI-compatible endpoint automatically.

### 2. Dashboard `.env.local`

Create `dashboards/open-brain-dashboard-next/.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL="https://your-project-ref.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="your-anon-key"
NEXT_PUBLIC_API_URL="https://your-project-ref.supabase.co/functions/v1/rest-api"
BRAIN_KEY="the-same-password-as-above"
```

---

## 🚀 Phase 6: Launching

Run the unified start script from the project root. This launches all four processes inside a single Windows Terminal window using **psmux** with a 2×2 pane layout — easier to monitor than four scattered PowerShell windows.

```powershell
.\start_brain.ps1
```

| Pane | Process | URL / Notes |
|------|---------|-------------|
| Top-left | **Dashboard** (Next.js) | http://localhost:3010 |
| Top-right | **Plaud Webhook** | http://127.0.0.1:4001/webhook — receives Applaud `transcript_ready` events |
| Bottom-left | **Brain Worker** | classification + entity extraction via Ollama |
| Bottom-right | **Applaud** | http://127.0.0.1:44471 — Plaud sync daemon (polls Plaud API, fires webhooks) |

> **Prerequisites**: `psmux` and Windows Terminal (`wt.exe`) must be on the system. Install psmux via `winget install psmux` (or equivalent). Paths to `psmux`, `wt`, and `powershell.exe` are pinned at the top of `start_brain.ps1` — edit if your install locations differ.
>
> **Applaud path**: `start_brain.ps1` hardcodes the Applaud directory. Edit the `$ApplaudPath` variable at the top of the script if Applaud is cloned elsewhere.
>
> **Plaud setup**: In Applaud's web UI, set the webhook URL to `http://127.0.0.1:4001/webhook`. New Plaud transcripts will then land in the **Review** panel (`/review`) in the dashboard before entering the brain.

### How the integrated workflow runs

1. **Capture stays fast and remote-safe.** `rest-api` and `open-brain-mcp` run as Supabase Edge Functions and handle all read/write from any MCP-connected AI or the dashboard.
2. **Local worker owns enrichment.** `scripts/local-brain-worker.js` polls `entity_extraction_queue` and drains it with Ollama (`qwen3:30b`). For each thought it: classifies work/personal, scores importance, extracts entities into `entities`/`thought_entities`/`edges`.
3. **Wiki auto-generates when the queue drains.** When the worker processes new thoughts and the queue reaches zero, it automatically spawns `recipes/entity-wiki/generate-wiki.mjs` for each entity it touched. All pages are always regenerated — curator notes (the `notes` column) are the safe place to add content that survives regeneration, since the compiler reads them and injects them into each page before sending to the LLM.
4. **Manual wiki run:** To regenerate all pages for entities with 3+ linked thoughts:
   ```powershell
   node --env-file=.env recipes/entity-wiki/generate-wiki.mjs --batch
   ```
   To include entities with only 1+ thought (catches everything):
   ```powershell
   node --env-file=.env recipes/entity-wiki/generate-wiki.mjs --batch --batch-min-linked 1
   ```
   To regenerate a specific entity by ID:
   ```powershell
   node --env-file=.env recipes/entity-wiki/generate-wiki.mjs --id 42
   ```
   To generate the personal autobiography wiki page:
   ```powershell
   node --env-file=.env recipes/wiki-synthesis/scripts/synthesize-wiki.mjs --topic autobiography
   ```
5. **Historical thoughts need a one-time backfill** (see Block 2 above). Run the backfill SQL after applying the schema to an existing brain, then leave `start_brain.ps1` running until the queue drains.
6. **One-time quality score backfill.** All thoughts start at `quality_score = 50` until the extraction worker processes them. To score all existing thoughts using heuristics (content length, vocabulary richness, metadata completeness):
   ```powershell
   node --env-file=.env scripts/score-thoughts.mjs --dry-run   # preview first
   node --env-file=.env scripts/score-thoughts.mjs              # apply
   ```
   Run with `--only-default` on subsequent installs to only update thoughts still at the default 50.

### Entity deduplication

The worker prevents duplicate entities in two ways:
1. **Before insertion**: checks if an existing entity's `aliases` array contains the extracted name — if so, uses the existing entity instead of creating a new one.
2. **Extraction prompt**: instructs the LLM to always use the most complete canonical form of a name (e.g., "Tom Falconar" not "Tom").

For manual merges of already-created duplicates, use the **Merge** button on any entity's wiki page in the dashboard. After merging, add short-name aliases (e.g., "Tom") so the worker recognises future mentions.

### Wiping and rebuilding wiki pages

After entity merges the wiki_pages table may contain orphaned pages (referencing deleted entities). Wipe and rebuild cleanly:

```powershell
# Dry-run: reports entity health + orphaned pages, no delete
node --env-file=.env scripts/wiki-wipe.mjs --dry-run

# Wipe all wiki_pages rows
node --env-file=.env scripts/wiki-wipe.mjs

# Rebuild from scratch (all entities with 1+ linked thought)
node --env-file=.env recipes/entity-wiki/generate-wiki.mjs --batch --batch-min-linked 1
```

---

## 🤖 Phase 7: Connect to Your AI

Use your **MCP Connection URL**:
`https://YOUR_PROJECT_REF.supabase.co/functions/v1/open-brain-mcp?key=YOUR_MCP_ACCESS_KEY`

### Claude Desktop
1. Settings → **Connectors** → **Add custom connector**
2. Name: `Open Brain` | URL: paste MCP Connection URL | Click **Add**

### ChatGPT (Plus/Pro)
1. Settings → **Apps & Connectors** → **Advanced settings** → enable **Developer Mode**
2. Click **Create** → Name: `Open Brain` → URL: paste MCP Connection URL → Auth: **No Authentication**

> **Note:** ChatGPT's standard connector surfaces `search_thoughts`, `list_thoughts`, `thought_stats`, and `capture_thought`. ChatGPT's "company knowledge" and "deep research" connector modes look for tools named exactly `search` and `fetch` — the MCP server exposes these as read-only aliases so both modes work from the same URL.

### Claude Code / CLI
```bash
claude mcp add --transport http open-brain \
  https://YOUR_PROJECT_REF.supabase.co/functions/v1/open-brain-mcp \
  --header "x-brain-key: your-mcp-access-key"
```

### Source identification

The MCP `capture_thought` tool requires clients to pass their own name in the `source` parameter. This is stored as `mcp-{source}` in the database (e.g., `mcp-claude`, `mcp-chatgpt`, `mcp-perplexity`). If a client sends the wrong name (e.g., Perplexity passing `source: "chatgpt"`), you can identify and correct it by filtering thoughts by `source_type` in the dashboard.

### MCP Tool Reference (v1.4.0)

| Tool | Read-only | Description |
|------|-----------|-------------|
| `search_thoughts` | ✓ | Semantic search; optional `classification`, `source`, `threshold` filters |
| `list_thoughts` | ✓ | Recent thoughts; optional `classification`, `type`, `source`, `since_hours` filters |
| `thought_stats` | ✓ | Summary counts for last 30 days |
| `capture_thought` | — | Save one atomic thought; `source` param required (use your client name) |
| `update_thought` | — | Update content/context; archives old version |
| `delete_thought` | — | Permanently delete a thought by serial ID or UUID |
| `distill_transcript` | ✓ | Split a long text block into atomic thought suggestions |
| `find_duplicates` | ✓ | Find semantically near-duplicate thought pairs |
| `add_reflection` | — | Save an AI-generated insight on a specific thought |
| `capture_review` | ✓ | List recent auto-captured memories (Fieldy, Plaud, etc.) for review; optional `source` filter |
| `search_wiki` | ✓ | Find wiki entity pages by name or alias |
| `read_wiki_page` | ✓ | Full wiki article by slug; returns cited thought IDs and linked entity slugs |
| `get_entity_connections` | ✓ | Knowledge graph edges for an entity (relation, direction, confidence) |
| `get_context_brief` | ✓ | Session-start briefing: active Kanban, recent captures, entities, action items, wiki. `scope` + `hours` params |
| `resume` | ✓ | "Where was I?" — last 6 captures, active Kanban, 24h action items, top entity focus |
| `list_action_items` | ✓ | All extracted action items across thoughts; `classification` + `since_hours` filters |
| `search` / `fetch` | ✓ | ChatGPT deep-research aliases for `search_thoughts` / single thought fetch |

> **Start any new AI session with `get_context_brief`.** Any AI client that calls it gets the same live briefing from the database — no copy-paste between sessions.

---

## 📂 Architecture Reference

| Component | Location | Purpose |
| :--- | :--- | :--- |
| **Dashboard** | `dashboards/open-brain-dashboard-next/` | UI + visual state |
| **REST API** | `supabase/functions/rest-api/index.ts` | All logic for the Dashboard |
| **MCP Server** | `supabase/functions/open-brain-mcp/index.ts` | Interface for Claude, ChatGPT, Perplexity, etc. |
| **AI Worker** | `scripts/local-brain-worker.js` | Classification + entity graph extraction (Ollama) |
| **Plaud Webhook** | `scripts/plaud-webhook.js` | Applaud → brain bridge; parses `---ENTRY---` blocks, runs Ollama SKIP/NEW/UPDATE triage, captures to `/capture-pending` for human review |
| **Wiki Compiler** | `recipes/entity-wiki/generate-wiki.mjs` | On-demand and auto-triggered wiki generation |
| **Wiki Synthesis** | `recipes/wiki-synthesis/scripts/synthesize-wiki.mjs` | Autobiography / topic wiki page generation |
| **Score Thoughts** | `scripts/score-thoughts.mjs` | Heuristic quality scoring backfill |
| **Wiki Wipe** | `scripts/wiki-wipe.mjs` | Clear wiki_pages + entity health report |
| **Persona Synthesis** | `scripts/synthesize-persona.mjs` | Generate conceptual `topic-adam-*` wiki pages from semantic clusters (requires `OPENROUTER_API_KEY` + Ollama) |

**Key Divergences from Upstream Open Brain:**
*   **Context-Aware**: Every thought is tagged `work` or `personal`. The dashboard, wiki, and MCP tools all support filtering by context.
*   **Serial IDs**: Dashboard uses simple integers (1, 2, 3) for display; DB uses UUIDs. The Edge Function maps these automatically.
*   **Local Processing**: Ollama handles classification, importance scoring, and entity graph extraction — no external API required for core enrichment.
*   **Entity Graph + Wiki**: Entities, edges, and wiki pages are first-class citizens. The wiki is auto-generated from the entity graph and regenerates automatically when the queue drains.
*   **Edge relation vocabulary**: The worker uses a typed relation vocabulary (`works_on`, `uses`, `collaborates_with`, `integrates_with`, `alternative_to`, `evaluates`, `member_of`, `located_in`, `related_to`, `co_occurs_with`). Directional edges require explicit textual evidence (min confidence 0.65). Co-occurrence without stated relationship produces `co_occurs_with` only. Symmetric relations are canonicalized by entity ID ordering to prevent duplicates.
*   **Wiki always regenerates**: All pages are regenerated on every compiler run. Use the `notes` column (editable in the dashboard) for curator content that survives regeneration — the compiler reads it and incorporates it before calling the LLM. The `manually_edited` column still exists in the DB but is no longer used by the compiler.
*   **Wiki deep-linking**: The wiki page is always at `/wiki`. Entity cross-links use `?slug=` query params (e.g. `/wiki?slug=person-adam-ososki`) and are intercepted client-side. Clicking a link in wiki content navigates to that entity's page without a full reload.
*   **Wiki entity management**: The detail header has inline controls for Rename, Aliases (add/remove + "remove & resplit" to undo a bad auto-absorb), Merge, Absorb, entity Type (inline dropdown), and Delete. Adding an alias auto-absorbs duplicate entities by loose-name match (lowercase, hyphen↔space) — moves their thought_entities + edges to the survivor and deletes the duplicate. The "Remove & resplit" alias action undoes a bad absorb by re-queueing every linked thought for re-extraction so the worker can recreate any entity the alias was masking.
*   **Wiki view modes**: Two views toggleable from the header. **Graph** (default) — collapsible constellation hero + 2-col body (Summary/Key Facts/Timeline left, Relationships/Open Questions/Curator Note right). Bare entity names auto-link in prose against the entity-name→slug map, so the LLM emitting "Adam Ososki" as plain text still becomes a clickable link. **List** — alphabetical sidebar (virtualised via `@tanstack/react-virtual`) + side-panel detail. Filter chips on the sidebar are dynamic from `/entity-types`.
*   **Constellation interactivity**: Top-N chooser (30/60/100) — Wiki defaults to 60, Dashboard to 30. Min co-occurrence slider thins weak edges client-side. Search filters to matches PLUS first-degree neighbors. Click → wiki nav (or in-page select on Wiki), shift/cmd-click → focus mode (filters to neighborhood with the focused node centred).
*   **No-cap aggregation principle**: All endpoints that aggregate counts (`/sources`, `/entity-types`, `/constellation`, `/entities` search) use Postgres `GROUP BY` via RPCs — never "fetch a slab and aggregate in JS". `/health/quotas` reports utilization on remaining cap-bound tables; the dashboard banner warns at 80%.
*   **Heuristic quality scoring**: `quality_score` is populated at creation time (default 50) and can be backfilled with `scripts/score-thoughts.mjs`. The Audit page threshold is configurable in the UI (default < 30).
*   **Kanban card-to-card drag**: Cards can be dragged between existing cards in any column, not just to empty space. Uses `@dnd-kit/sortable` with per-column `SortableContext`.
*   **Action Items pipeline**: The enrichment worker extracts `action_items` from every thought into metadata. The `/actions` dashboard page surfaces these as a triage inbox — each item can be dismissed (Done) or promoted to a Kanban task (→ Kanban, which creates a `type=task, status=backlog` thought). Action items are the discovery layer; Kanban is the execution layer. Also available via the `list_action_items` MCP tool.
*   **Session context sharing**: `get_context_brief` and `resume` MCP tools let any AI client (Claude, ChatGPT, Perplexity) pull a live briefing from the database at session start, solving the cross-AI context copy-paste problem without any sync infrastructure.
*   **Source-agnostic capture review**: `capture_review` MCP tool (replaces `fieldy_review`) lists recent auto-captured memories from any device — Fieldy, Plaud, or future auto-capture sources. Filter by source or see all.
*   **Plaud capture triage**: Thoughts from Plaud land in a Review panel (`/review`) before entering the brain. `POST /capture-pending` stores them with `metadata.review_status: pending_review` — they are invisible to the wiki, Kanban, and action items pipeline until approved. The webhook pre-processes each `---ENTRY---` block from the Plaud template: TYPE and CONTEXT fields are parsed and set directly on the thought; classification defaults to `work` if the CONTEXT field is absent. UPDATE decisions (where Ollama decides a new entry should merge with an existing thought) synthesise the merge at webhook time and store the result as a pending thought — the original is never touched until the user approves in the Review panel, making reject always safe with nothing to restore.

---

*AJO fork of Open Brain Pro. Last updated May 2026 — wiki notes/rename/alias/type/delete UI, entity-type sidebar filter, deep-linking, heuristic scoring, configurable audit threshold, Kanban card-to-card drag, wiki-wipe + score-thoughts scripts, ChatGPT search/fetch compatibility tools, wiki MCP tools (search_wiki/read_wiki_page/get_entity_connections), improved edge extraction (typed relation vocabulary + entity-type constraints), persona synthesis script, MCP v1.4.0 (get_context_brief/resume/list_action_items/capture_review), Actions dashboard page with Done + Promote to Kanban triage, Plaud/Applaud capture pipeline with Review triage panel (capture-pending gate, Ollama SKIP/NEW/UPDATE decisions, safe UPDATE handling, TYPE+CONTEXT parsing from template).*
