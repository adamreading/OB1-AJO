# Open Brain Pro (AJO Version) — Complete Setup Guide

This is the definitive "ground-up" guide for building the AJO fork of Open Brain. Once finished, you will have a personal knowledge system with automatic "Work vs Personal" classification, local entity graph extraction, semantic search, optional compiled wiki generation, and a full Next.js dashboard.

---

## 📋 Phase 0: Prerequisites & Credential Tracker

You'll be generating API keys and passwords across several services. **Do not trust your memory.** Create a text file called `credentials.txt` and save these as you go:

1.  **Supabase Account**: Sign up at [supabase.com](https://supabase.com).
2.  **Ollama**: Install [Ollama](https://ollama.com) locally for background classification, entity graph extraction, and wiki compilation.
3.  **OpenRouter Account (optional)**: Only needed if you deliberately want hosted embeddings or hosted metadata extraction inside Edge Functions.

| Credential | Where to find it |
| :--- | :--- |
| `SUPABASE_PROJECT_REF` | Dashboard URL: `project/THIS_PART` |
| `SUPABASE_DB_PASSWORD` | You set this during project creation |
| `SUPABASE_SERVICE_ROLE_KEY` | Settings → API → `service_role` |
| `OPENROUTER_API_KEY` | Optional: openrouter.ai/keys |
| `BRAIN_KEY` | You choose this (your API password) |
| `MCP_ACCESS_KEY` | You choose this (for remote AI access) |

---

## 🛠️ Phase 1: Supabase Project Setup

1.  **Create Project**: Go to [Supabase](https://supabase.com) → **New Project**.
2.  **Details**: Name it `open-brain`, set a strong **Database Password**, and pick a region near you.
3.  **Wait**: It takes about 2 minutes to provision.
4.  **Grab Details**: Go to **Settings** (gear) → **API**. Copy your **Project URL** and the **`service_role` (secret)** key.

---

## 💻 Phase 2: CLI & Project Linking

The CLI is the fastest way to deploy your brain's logic.

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

Run the following block in your Supabase **SQL Editor** (New Query). This creates the core thoughts table, custom AJO classification queues, and advanced search functions.

```sql
-- 1. Enable Extensions
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Thoughts Table (The Core)
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

-- 3. Thought Versions (Archiving updates)
CREATE TABLE IF NOT EXISTS thought_versions (
  id SERIAL PRIMARY KEY,
  thought_id UUID REFERENCES thoughts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Reflections Table
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

-- 5. Entity Extraction Queue (Background AI worker)
CREATE TABLE IF NOT EXISTS entity_extraction_queue (
  thought_id UUID PRIMARY KEY REFERENCES thoughts(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'complete', 'failed', 'skipped')),
  attempt_count INTEGER DEFAULT 0,
  last_error TEXT,
  queued_at TIMESTAMPTZ DEFAULT now(),
  started_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  source_fingerprint TEXT,
  source_updated_at TIMESTAMPTZ,
  worker_version TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 6. Ingestion Jobs (bulk import tracking)
CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id SERIAL PRIMARY KEY,
  source_label TEXT DEFAULT 'manual',
  status TEXT DEFAULT 'pending',
  extracted_count INTEGER DEFAULT 0,
  added_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- 7. Ingestion Items (individual extracted thoughts per job)
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

-- 8. Semantic Search Function
-- Note: filter jsonb allows optional metadata filtering (e.g. by classification)
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

-- 9. Upsert Thought (Idempotent capture with fingerprinting)
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

-- 10. Find Duplicates (Vector similarity pairs)
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

-- 11. Aggregate Stats
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

> **Important:** If you created `match_thoughts` before and semantic search returns errors about `operator does not exist: vector <=> vector`, run this fix:
> ```sql
> ALTER FUNCTION match_thoughts(vector, float, int, jsonb)
>   SET search_path = public, extensions;
> ```
> This is needed because Supabase installs pgvector in the `extensions` schema.

---

## ⚡ Phase 2: Supabase Edge Function

The dashboard talks to a single Edge Function (`rest-api`) for all API calls. The file at `supabase/functions/rest-api/index.ts` in this repo is the **canonical source** — always deploy from there.

### Routes provided

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check |
| GET | `/stats` | Dashboard summary counts |
| GET | `/thoughts` | Paginated thought list (supports `type`, `status`, `classification` filters) |
| GET | `/search` | Semantic search (falls back to text if embeddings unavailable) |
| GET | `/duplicates` | Find near-duplicate thoughts |
| GET/PUT/DELETE | `/thought/:id` | Single thought CRUD |
| GET/POST | `/thought/:id/reflection` | Reflections on a thought |
| POST | `/capture` | Quick single-thought add with dedup fingerprinting |
| GET | `/ingestion-jobs` | List bulk import jobs |
| GET | `/ingestion-jobs/:id` | Single job + items |
| POST | `/ingest` | Extract and commit a block of text as thoughts |
| POST | `/ingestion-jobs/:id/execute` | Execute a pending job's items |

### 1. Deploy via CLI (Recommended)

If you have the Supabase CLI installed, run these from the project root:

```powershell
# 1. Login and link your project
supabase login
supabase link --project-ref your-project-ref

# 2. Set Secrets
supabase secrets set BRAIN_KEY="your-api-password"
supabase secrets set MCP_ACCESS_KEY="your-mcp-access-key"
# Optional hosted fallback only:
# supabase secrets set OPENROUTER_API_KEY="your-openrouter-key"

# 3. Deploy both functions
supabase functions deploy rest-api --no-verify-jwt
supabase functions deploy open-brain-mcp --no-verify-jwt
```

### 2. Manual Deployment (Fallback)

If you prefer the web UI:
1. Go to Supabase Dashboard → **Edge Functions** → **Create a new function** → name it `rest-api`.
2. Paste the contents of `supabase/functions/rest-api/index.ts`.
3. Repeat for `open-brain-mcp` using `supabase/functions/open-brain-mcp/index.ts`.

> **Note:** `BRAIN_KEY` and `MCP_ACCESS_KEY` can be the same value for simplicity, or different if you want separate dashboard/MCP passwords.

### 3. Set Edge Function secrets

In Supabase Dashboard → **Edge Functions** → **Manage secrets**, add:

| Secret | Value |
|--------|-------|
| `BRAIN_KEY` | Your chosen API password (must match `BRAIN_KEY` in dashboard `.env.local`) |
| `MCP_ACCESS_KEY` | Your chosen MCP connector password |
| `OPENROUTER_API_KEY` | Optional hosted fallback for embeddings and metadata extraction |

> `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by Supabase — do not add them manually.

---

## 🌐 Phase 4: Local Environment & Worker

For background classification (Work vs Personal), importance scoring, summaries, and entity graph extraction, you run a local Node.js worker that talks to your local Ollama instance.

### 1. Root `.env` Setup

Create a file named `.env` in the project root:

```env
SUPABASE_URL="https://your-project-ref.supabase.co"
SUPABASE_KEY="your-service-role-key"
BRAIN_KEY="your-api-password"
OLLAMA_URL="http://localhost:11434/api"
OLLAMA_MODEL="qwen3:30b"
KANBAN_INITIAL_STATUS="backlog"

# Wiki compiler aliases used by recipes/wiki-compiler
OPEN_BRAIN_URL="https://your-project-ref.supabase.co"
OPEN_BRAIN_SERVICE_KEY="your-service-role-key"
LLM_BASE_URL="http://localhost:11434/v1"
LLM_MODEL="qwen3:30b"
LLM_API_KEY="ollama"
WIKI_ENTITY_EXTRACTION_MODE="local"

# Context definitions for the AI worker
WORK_CONTEXT_DESC="Professional work, software development, and corporate projects"
PERSONAL_CONTEXT_DESC="Home life, hobbies, fitness, and family"
```

### 2. Dashboard `.env.local`

Create `dashboards/open-brain-dashboard-next/.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL="https://your-project-ref.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="your-anon-key"
NEXT_PUBLIC_API_URL="https://your-project-ref.supabase.co/functions/v1/rest-api"
BRAIN_KEY="the-same-password-as-above"
```

---

## 🚀 Phase 5: Launching

Run the unified start script from the project root. This launches the dashboard and the local background worker simultaneously.

```powershell
.\start_brain.ps1
```

*   **Dashboard**: [http://localhost:3010](http://localhost:3010)
*   **Worker**: Watch the terminal for "Starting Open Brain local worker..."

### Optional: compile the wiki

The local worker keeps per-thought enrichment and the entity graph warm continuously. The wiki compiler is intentionally separate because it performs batch, cross-thought synthesis, but AJO defaults it to local Ollama through `http://localhost:11434/v1`. Run it manually or on a schedule after the worker has drained the queue:

```powershell
node recipes/wiki-compiler/compile-wiki.mjs --edge-limit 10
```

Start with a low `--edge-limit` because typed reasoning edges compare pairs of thoughts and can take time on a local model. Add `--skip-edges` when you only want wiki pages and do not want to classify cross-thought relationships in that run.

### Current integrated workflow

The AJO fork combines the upstream graph/wiki stack with the existing local worker:

1. **Capture stays fast and remote-safe.** `rest-api` and `open-brain-mcp` run as Supabase Edge Functions. They can use OpenRouter for cheap embeddings and lightweight metadata extraction, but capture still works with graceful fallbacks if OpenRouter is unavailable.
2. **Local worker owns enrichment.** `scripts/local-brain-worker.js` drains `entity_extraction_queue` with Ollama (`qwen3:30b` by default), preserves manual classification where present, writes summaries/classification/importance, and populates `entities`, `thought_entities`, and entity `edges`.
3. **Historical thoughts need a one-time catchup queue.** Existing thoughts created before the graph trigger was installed need to be inserted into `entity_extraction_queue` once. The entity-extraction schema contains the backfill SQL at the bottom; run it after applying the schema, then leave `start_brain.ps1` running until the queue drains.
4. **Wiki compilation runs on demand (auto-trigger coming).** `recipes/wiki-compiler/compile-wiki.mjs --skip-extraction` assumes the local worker has already warmed the graph. It runs typed reasoning edges and generates entity + topic wiki pages. Run manually after the queue drains; a worker-driven auto-trigger (queue drains → compile fires) is the next planned addition.
5. **Typed reasoning edges are fully local.** `recipes/typed-edge-classifier/classify-edges.mjs` defaults to Ollama's OpenAI-compatible endpoint (`http://localhost:11434/v1`) and `qwen3:30b`. No external API required.

### Next: wiki_pages table + dashboard wiki view

Wiki output currently lands in `compiled-wiki/` as markdown files. The next additions are:

- A `wiki_pages` Supabase table so generated pages live in the database and are queryable
- A `/wiki` dashboard page to browse entity and topic pages without leaving the dashboard
- Worker auto-trigger: when the entity extraction queue drains to zero after processing new thoughts, the worker spawns a full wiki compile automatically

---

## 🤖 Phase 6: Connect to your AI

You can now connect any MCP-compatible AI to your brain. Use your **MCP Connection URL**:
`https://YOUR_PROJECT_REF.supabase.co/functions/v1/open-brain-mcp?key=YOUR_MCP_ACCESS_KEY`

### 1. Claude Desktop (Easiest)
1. Open Claude Desktop → **Settings** → **Connectors**.
2. Click **Add custom connector**.
3. Name: `Open Brain`.
4. URL: Paste your **MCP Connection URL**.
5. Click **Add**.

### 2. ChatGPT (Plus/Pro)
1. Go to ChatGPT Settings → **Apps & Connectors**.
2. Click **Create** → Name: `Open Brain`.
3. URL: Paste your **MCP Connection URL**.
4. Auth: Select **No Authentication** (it's in the URL).

### 3. Claude Code / CLI
```bash
claude mcp add --transport http open-brain \
  https://YOUR_PROJECT_REF.supabase.co/functions/v1/open-brain-mcp \
  --header "x-brain-key: your-mcp-access-key"
```

---

## 📂 Architecture Reference

| Component | Location | Source of Truth |
| :--- | :--- | :--- |
| **Dashboard** | `dashboards/open-brain-dashboard-next/` | UI & Visual State |
| **REST API** | `supabase/functions/rest-api/index.ts` | All logic for the Dashboard |
| **MCP Server** | `supabase/functions/open-brain-mcp/index.ts` | Interface for Claude, ChatGPT, Perplexity, Copilot, etc. |
| **AI Worker** | `scripts/local-brain-worker.js` | Background classification + entity graph extraction (Ollama) |
| **Wiki Compiler** | `recipes/wiki-compiler/compile-wiki.mjs` | On-demand compiled wiki generation |

**Key Divergences in this Fork:**
*   **Context-Aware**: Every thought is tagged as `work` or `personal`.
*   **Serial IDs**: The dashboard uses simple integers (1, 2, 3) for display, while the DB uses UUIDs for security. The Edge Function maps these automatically.
*   **Local Processing**: We use local LLMs (Ollama) for classification and entity graph extraction to save on API costs and maintain privacy for sensitive thoughts.
*   **Compiled Wiki**: Wiki pages are generated artifacts from SQL + graph tables. They are not the source of truth and should be regenerated rather than manually edited.

---

*Documentation maintained by Open Brain Pro (AJO fork). Last updated May 2026 — graph pipeline, Ollama/qwen3 local processing, and wiki compiler integrated.*
