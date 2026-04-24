# Open Brain Pro (AJO Version) — Complete Setup Guide

This guide provides everything needed to build your Open Brain from a completely clean slate. 

---

## 🛠️ Phase 1: Cloud Database (Supabase)

### 1. Core Schema
Run these in your Supabase SQL Editor to create the thoughts, reflections, and AI processing queues.

```sql
-- 1. Enable Vector Extensions
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

-- 3. Reflections Table (Insight Tracking)
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

-- 4. Entity Extraction Queue (Background AI)
CREATE TABLE IF NOT EXISTS entity_extraction_queue (
  thought_id UUID PRIMARY KEY REFERENCES thoughts(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 5. AI Search Function (Semantic Search)
CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding vector(1536),
  match_threshold float default 0.3,
  match_count int default 20,
  p_exclude_restricted boolean default true,
  p_classification text default null
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
) LANGUAGE plpgsql AS $$
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
    AND (p_classification IS NULL OR t.classification = p_classification)
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;
```

---

## 🛠️ Phase 2: Environment API Setup

### 1. Root .env
Create a `.env` in the root of this project:
```env
SUPABASE_URL="https://your-ref.supabase.co"
SUPABASE_KEY="your-service-role-key"
BRAIN_KEY="choose-a-strong-api-password"
OLLAMA_URL="http://localhost:11434/api"
OLLAMA_MODEL="Qwen3:30b"

# Context-Aware Definitions
WORK_CONTEXT_DESC="Professional work and corporate projects"
PERSONAL_CONTEXT_DESC="Home life, side projects, and hobbies"
```

### 2. Dashboard .env.local
Create `dashboards/open-brain-dashboard-next/.env.local`:
```env
NEXT_PUBLIC_SUPABASE_URL="https://your-ref.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="your-anon-key"
BRAIN_KEY="the-same-password-from-above"
```

---

## ⚡ Phase 3: Launching

### 1. Initialize Dashboard
```powershell
cd dashboards/open-brain-dashboard-next
npm install
```

### 2. Startup Pro
Run the unified script from the project root:
```powershell
.\start_brain.ps1
```
This launches:
1. **Next.js Dashboard** (Port 3000)
2. **AI Worker** (Background categorization)

---

## 📂 Architecture Note
- **API**: Edge Function `rest-api` handles all UI requests.
- **Worker**: `scripts/local-brain-worker.js` listens to the Supabase queue and uses your local Ollama instance for auto-tagging.

*Documentation maintained by Open Brain Pro Team.*
