# Open Brain Pro (AJO Version) — Complete Setup Guide

This guide provides everything needed to build your Open Brain from a completely clean slate.

---

## 🛠️ Phase 1: Cloud Database (Supabase)

### 1. Core Schema

Run these in your Supabase SQL Editor to create the thoughts, reflections, and AI processing queues.

```sql
-- 1. Enable Vector Extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Thoughts Table (The Core)
CREATE TABLE IF NOT EXISTS thoughts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  serial_id SERIAL UNIQUE,
  content TEXT NOT NULL,
  type TEXT DEFAULT 'observation',
  status TEXT DEFAULT 'new' CHECK (status IN ('new', 'planning', 'active', 'review', 'done', 'archived')),
  importance INTEGER DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  quality_score INTEGER DEFAULT 50,
  classification TEXT DEFAULT 'personal' CHECK (classification IN ('work', 'personal')),
  embedding VECTOR(1536),
  metadata JSONB DEFAULT '{}'::jsonb,
  sensitivity_tier TEXT DEFAULT 'standard',
  source_type TEXT DEFAULT 'manual',
  status_updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
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

-- 4. Entity Extraction Queue (Background AI worker)
CREATE TABLE IF NOT EXISTS entity_extraction_queue (
  thought_id UUID PRIMARY KEY REFERENCES thoughts(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 5. Ingestion Jobs (bulk import tracking)
CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id SERIAL PRIMARY KEY,
  source_label TEXT DEFAULT 'manual',
  status TEXT DEFAULT 'pending',
  extracted_count INTEGER DEFAULT 0,
  added_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- 6. Ingestion Items (individual extracted thoughts per job)
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

-- 7. Semantic Search Function
-- Note: filter jsonb allows optional metadata filtering (e.g. by classification)
CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.3,
  match_count int DEFAULT 20,
  filter jsonb DEFAULT '{}'::jsonb,
  p_exclude_restricted boolean DEFAULT true
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
    AND (NOT p_exclude_restricted OR t.sensitivity_tier <> 'restricted')
    AND (filter = '{}'::jsonb OR t.metadata @> filter)
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;
```

> **Important:** If you created `match_thoughts` before and semantic search returns errors about `operator does not exist: vector <=> vector`, run this fix:
> ```sql
> ALTER FUNCTION match_thoughts(vector, float, int, jsonb, boolean)
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

### 1. Deploy the function

1. Go to Supabase Dashboard → **Edge Functions** → **Create a new function** → name it `rest-api`
2. Paste the full contents of `supabase/functions/rest-api/index.ts` from this repo
3. Click **Deploy**

> **Updating:** When you pull new changes from this repo, re-paste and redeploy the Edge Function the same way — the Supabase UI editor is the deployment mechanism.

### 2. Set Edge Function secrets

In Supabase Dashboard → **Edge Functions** → **Manage secrets**, add:

| Secret | Value |
|--------|-------|
| `BRAIN_KEY` | Your chosen API password (must match `BRAIN_KEY` in dashboard `.env.local`) |
| `OPENROUTER_API_KEY` | Your OpenRouter API key (for embeddings + AI extraction) |

> `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by Supabase — do not add them manually.

---

## 🌐 Phase 3: Environment Setup

### 1. Root `.env` (for the local AI worker)

Create `.env` in the project root:

```env
SUPABASE_URL="https://your-ref.supabase.co"
SUPABASE_KEY="your-service-role-key"
BRAIN_KEY="choose-a-strong-api-password"
OLLAMA_URL="http://localhost:11434/api"
OLLAMA_MODEL="qwen3:30b"

# Context definitions used by the AI worker for classification
WORK_CONTEXT_DESC="Professional work and corporate projects"
PERSONAL_CONTEXT_DESC="Home life, side projects, and hobbies"
```

### 2. Dashboard `.env.local`

Create `dashboards/open-brain-dashboard-next/.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL="https://your-ref.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="your-anon-key"
NEXT_PUBLIC_API_URL="https://your-ref.supabase.co/functions/v1/rest-api"
BRAIN_KEY="the-same-password-as-BRAIN_KEY-above"
```

> `NEXT_PUBLIC_API_URL` points at the Edge Function. Replace `your-ref` with your actual Supabase project reference ID (found in Settings → General).

---

## 🚀 Phase 4: Launching

### 1. Install dashboard dependencies

```powershell
cd dashboards/open-brain-dashboard-next
npm install
```

### 2. Start everything

Run the unified script from the project root:

```powershell
.\start_brain.ps1
```

This launches:
1. **Next.js Dashboard** on port 3000
2. **Local AI Worker** — background classification via your local Ollama instance

---

## 📂 Architecture

| Component | Location | Purpose |
|-----------|----------|---------|
| Dashboard | `dashboards/open-brain-dashboard-next/` | Next.js UI (Kanban, Search, Ingest, Audit) |
| Edge Function | `supabase/functions/rest-api/index.ts` | REST API — all dashboard calls go here |
| AI Worker | `scripts/local-brain-worker.js` | Polls Supabase queue, classifies via Ollama |
| Schema | Phase 1 SQL above | Supabase tables + `match_thoughts` RPC |

**Key design decisions:**
- `serial_id` (integer) is used as the dashboard-facing `id`; `id` (UUID) is the DB primary key. The Edge Function's `mapThought()` swaps these on every response.
- The Edge Function is the single source of truth for all API logic. The dashboard's `app/api/` routes are thin auth proxies that forward to it.
- Semantic search uses OpenRouter (`text-embedding-3-small`) with automatic text-search fallback if embeddings are unavailable or the RPC fails.
- Theme switching (Coal / Midnight / Slate / Ocean / Forest) is built into the sidebar — click the cog icon at the bottom. No setup needed.
- The `match_thoughts` function **must** be created with `SET search_path = public, extensions` (included in the Phase 1 SQL above). Without this, Supabase's pgvector `<=>` operator won't resolve and semantic search will silently fall back to text.

---

## 🔄 Keeping Up to Date

When you pull new changes from this repo:

1. **Edge Function** — re-paste `supabase/functions/rest-api/index.ts` into the Supabase editor and redeploy
2. **Dashboard** — `npm install` if `package.json` changed, then restart `npm run dev`
3. **Schema** — check `AJO_Readme.md` for any new SQL to run; new tables are always `CREATE TABLE IF NOT EXISTS` safe to re-run

---

*Documentation maintained by Open Brain Pro (AJO fork). Last updated April 2026.*
