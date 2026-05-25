import { Hono } from "hono";
import { cors } from "hono/middleware";
import { createClient } from "@supabase/supabase-js";

const app = new Hono();

// CORS config - allow everything
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-brain-key, accept",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

app.use("*", cors());

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
);

// Fallback chain for the access key
const API_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") ||
                       Deno.env.get("BRAIN_KEY") ||
                       Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// --- MIDDLEWARE ---

app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") return c.text("ok", 200, corsHeaders);

  const provided = c.req.header("x-brain-key") ||
                   c.req.header("Authorization")?.replace("Bearer ", "") ||
                   new URL(c.req.url).searchParams.get("key");

  if (!provided || provided !== API_ACCESS_KEY) {
    return c.json({ error: "Unauthorized: Invalid or missing access key" }, 401, corsHeaders);
  }
  await next();
});

// Returns null instead of throwing so search gracefully falls back to text
async function getEmbedding(text: string): Promise<number[] | null> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) return null;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/text-embedding-3-small",
        input: text,
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.data[0].embedding;
  } catch {
    return null;
  }
}

// Map database thoughts to Dashboard-expected format (swapping serial_id -> id)
const mapThought = (t: any) => {
  if (!t) return null;
  return {
    ...t,
    id: t.serial_id,
    uuid: t.id
  };
};

const getIdentityFilter = (id: string) => {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  return isUuid ? { id } : { serial_id: parseInt(id, 10) };
};

async function fingerprint(text: string): Promise<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

// --- ROUTES ---

// Health
app.get("/health", (c) => c.json({ status: "ok", version: "2.9.0-pro" }));

// Quotas — for each cap-bound endpoint, report current row count vs cap so
// the dashboard can show a tripwire banner before any silent ceiling bites.
// Anything over 0.8 utilization is "near_cap"; anything over 1.0 means data
// is being silently truncated and an immediate fix is required.
app.get("/health/quotas", async (c) => {
  // Caps the rest-api currently enforces. Aggregation endpoints (/sources,
  // /entity-types) and /constellation use SQL GROUP BY now and have no
  // intrinsic cap — they're absent here intentionally.
  const checks: Array<{
    name: string;
    table: string;
    cap: number;
    note: string;
    countQuery: () => Promise<{ count: number | null; error: string | null }>;
  }> = [
    {
      name: "entities (/entities default per page)",
      table: "entities",
      cap: 5000, // search_entities() max p_limit
      note: "Default /entities returns 200 rows; ?limit=N up to 5000. Past 5000 the modal needs server pagination.",
      countQuery: async () => {
        const { count, error } = await supabase
          .from("entities")
          .select("id", { count: "exact", head: true });
        return { count: count ?? null, error: error?.message ?? null };
      },
    },
    {
      name: "wiki_pages (/wiki-pages per page)",
      table: "wiki_pages",
      cap: 10000, // /wiki-pages max per_page
      note: "Single page caps at 10000. Pagination via ?page= for larger sets.",
      countQuery: async () => {
        const { count, error } = await supabase
          .from("wiki_pages")
          .select("id", { count: "exact", head: true });
        return { count: count ?? null, error: error?.message ?? null };
      },
    },
    {
      name: "search_entities (alias-aware search)",
      table: "entities",
      cap: 5000, // search_entities p_limit max
      note: "Single-call cap — typically narrowed by ?search= so the actual returned set is much smaller.",
      countQuery: async () => {
        const { count, error } = await supabase
          .from("entities")
          .select("id", { count: "exact", head: true });
        return { count: count ?? null, error: error?.message ?? null };
      },
    },
    {
      name: "thoughts (browse pagination)",
      table: "thoughts",
      cap: 30000, // Single-call per_page cap on /thoughts (enforced server-side).
      note: "Browse uses ?page=&per_page= with a 30000 per-call ceiling. Total row count grows indefinitely without truncation — the dashboard pages through any size. Aggregation endpoints (/stats type counts) use RPCs so they're never row-capped.",
      countQuery: async () => {
        // Report 0 so the quota banner never fires for /thoughts — total
        // thoughts is unbounded by design (paginated browse + RPC aggregations).
        return { count: 0, error: null };
      },
    },
    {
      name: "thought_entities (constellation source)",
      table: "thought_entities",
      cap: Number.POSITIVE_INFINITY, // RPC-backed — no cap
      note: "Aggregated via RPC GROUP BY in SQL. No row cap; reported for trend monitoring only.",
      countQuery: async () => {
        // thought_entities has a composite PK; count any non-null column.
        const { count, error } = await supabase
          .from("thought_entities")
          .select("thought_id", { count: "exact", head: true });
        return { count: count ?? null, error: error?.message ?? null };
      },
    },
    {
      name: "edges (max per entity)",
      table: "edges",
      cap: 5000, // Per-side cap of /entities/:id/edges
      note: "The truncation risk for /entities/:id/edges is per-entity, not total. We report the max edges connected to any single entity here so the warning fires only when a real entity is approaching the per-query cap (5000 per side).",
      countQuery: async () => {
        // Fetch from/to ids and compute the worst-case per-entity count.
        // For ~1000-edges-total brain this is fast; if the graph grows past
        // ~50k edges this should move to a Postgres RPC for efficiency.
        const { data, error } = await supabase
          .from("edges")
          .select("from_entity_id, to_entity_id");
        if (error || !data) return { count: null, error: error?.message ?? "edges fetch failed" };
        const counts = new Map<number, number>();
        for (const e of data) {
          counts.set(e.from_entity_id, (counts.get(e.from_entity_id) ?? 0) + 1);
          counts.set(e.to_entity_id, (counts.get(e.to_entity_id) ?? 0) + 1);
        }
        let maxPerEntity = 0;
        for (const v of counts.values()) if (v > maxPerEntity) maxPerEntity = v;
        return { count: maxPerEntity, error: null };
      },
    },
  ];

  const results = await Promise.all(
    checks.map(async (chk) => {
      const { count, error } = await chk.countQuery();
      const utilization =
        count !== null && Number.isFinite(chk.cap)
          ? count / chk.cap
          : null;
      return {
        name: chk.name,
        table: chk.table,
        current: count,
        cap: Number.isFinite(chk.cap) ? chk.cap : null,
        utilization,
        near_cap: utilization !== null && utilization >= 0.8,
        over_cap: utilization !== null && utilization >= 1.0,
        note: chk.note,
        error,
      };
    })
  );

  const anyNearCap = results.some((r) => r.near_cap);
  const anyOverCap = results.some((r) => r.over_cap);

  return c.json(
    { checks: results, near_cap: anyNearCap, over_cap: anyOverCap },
    200,
    corsHeaders
  );
});

// Stats — server-side aggregation via the thought_stats_summary RPC so
// the type breakdown stays correct as the brain grows past PostgREST's
// 1000-row response limit. Replaces the previous "fetch all rows +
// aggregate in JS" pattern, which silently truncated above 1000 rows.
app.get("/stats", async (c) => {
  const days = Number(c.req.query("days") ?? 30);
  const classification = c.req.query("classification");

  try {
    const { data, error } = await supabase.rpc("thought_stats_summary", {
      p_classification: classification || null,
    });
    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    const total = Number(row?.total ?? 0);
    const types = (row?.types as Record<string, number>) || {};

    return c.json({
      total_thoughts: total,
      window_days: days,
      types,
      top_topics: [],
    }, 200, corsHeaders);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500, corsHeaders);
  }
});

// Thoughts
app.get("/thoughts", async (c) => {
  const page = Number(c.req.query("page") ?? 1);
  // Cap per_page so a runaway client can't pull every row in one call. The
  // dashboard's default is 20, the audit views ask for up to a few hundred,
  // export/audit scripts may want everything — 30000 covers the brain at
  // its current ~4k post-Perplexity-import size with 7x headroom.
  const perPage = Math.min(30000, Math.max(1, Number(c.req.query("per_page") ?? 20)));

  const type = c.req.query("type");
  const classification = c.req.query("classification");
  const qualityScoreMax = c.req.query("quality_score_max");
  const importanceMin = c.req.query("importance_min");
  const status = c.req.query("status");
  const reviewStatus = c.req.query("review_status");
  const sourceType = c.req.query("source_type");

  let query = supabase
    .from("thoughts")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * perPage, page * perPage - 1);


  if (type) query = query.eq("type", type);
  if (qualityScoreMax) query = query.lt("quality_score", parseInt(qualityScoreMax, 10));
  if (importanceMin) query = query.gte("importance", parseInt(importanceMin, 10));
  if (status) query = query.in("status", status.split(",").map((s: string) => s.trim()));
  if (classification) {
    query = query.filter("metadata->>classification", "eq", classification);
  }
  if (reviewStatus) {
    query = query.filter("metadata->>review_status", "eq", reviewStatus);
  }
  if (sourceType) query = query.eq("source_type", sourceType);

  const { data, error, count } = await query;
  if (error) return c.json({ error: error.message }, 500);

  return c.json({
    data: (data || []).map(mapThought),
    total: count ?? 0,
    page,
    per_page: perPage
  });
});

// Search — semantic with text fallback
app.get("/search", async (c) => {
  const q = c.req.query("q");
  const mode = c.req.query("mode") ?? "semantic";
  const limit = Number(c.req.query("limit") ?? 20);

  const classification = c.req.query("classification");

  if (!q) return c.json({ error: "Query required" }, 400);

  try {
    if (mode === "semantic") {
      const embedding = await getEmbedding(q);
      if (embedding) {
        const rpcParams: Record<string, unknown> = {
          query_embedding: embedding,
          match_threshold: 0.15,
          match_count: limit,

        };
        if (classification) rpcParams.filter = { classification };
        const { data, error } = await supabase.rpc("match_thoughts", rpcParams);
        if (!error) {
          return c.json({
            results: (data || []).map(mapThought),
            count: data?.length || 0,
            total: data?.length || 0,
            mode: "semantic"
          }, 200, corsHeaders);
        }
        console.error("Semantic RPC failed, falling back to text:", error.message);
        // Fall through to text search
      }
      // Fall through to text search if embedding unavailable or RPC failed
    }

    // Text search fallback
    let query = supabase.from("thoughts").select("*").ilike("content", `%${q}%`).limit(limit);

    if (classification) query = query.filter("metadata->>classification", "eq", classification);

    const { data, error } = await query;
    if (error) throw error;
    return c.json({
      results: (data || []).map(mapThought),
      count: data?.length || 0,
      total: data?.length || 0,
      mode: "text"
    }, 200, corsHeaders);
  } catch (err) {
    const msg = err instanceof Error ? err.message
      : typeof (err as any)?.message === "string" ? (err as any).message
      : JSON.stringify(err);
    console.error("Search error:", msg);
    return c.json({ error: msg }, 500);
  }
});

// Action items — thoughts with non-empty metadata.action_items
app.get("/action-items", async (c) => {
  const classification = c.req.query("classification");
  const sinceHoursRaw = c.req.query("since_hours");
  const sinceHours = sinceHoursRaw ? Number(sinceHoursRaw) : 0;
  const limit = Number(c.req.query("limit") ?? 50);

  try {
    let q = supabase
      .from("thoughts")
      .select("serial_id, content, type, metadata, source_type, created_at, importance")
      .not("metadata->action_items", "is", null)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (sinceHours > 0) {
      const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
      q = q.gte("created_at", since);
    }
    if (classification) q = q.filter("metadata->>classification", "eq", classification);

    const { data, error } = await q;
    if (error) return c.json({ error: error.message }, 500, corsHeaders);

    const withActions = (data || []).filter((t: any) =>
      Array.isArray(t.metadata?.action_items) && t.metadata.action_items.length > 0
    );

    return c.json({ thoughts: withActions, total: withActions.length, since_hours: sinceHours }, 200, corsHeaders);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500, corsHeaders);
  }
});

// Duplicates
app.get("/duplicates", async (c) => {
  const threshold = Number(c.req.query("threshold") ?? 0.85);
  const limit = Number(c.req.query("limit") ?? 50);
  const classification = c.req.query("classification");

  try {
    const { data, error } = await supabase.rpc("brain_duplicates_find", {
      p_threshold: threshold,
      p_limit: limit,
      p_classification: classification || null
    });

    if (error) {
      console.error("Duplicates RPC error:", error.message);
      return c.json({ pairs: [], threshold, limit, error: "Deduplication temporarily unavailable" }, 200, corsHeaders);
    }
    return c.json({ pairs: data || [], threshold, limit }, 200, corsHeaders);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500, corsHeaders);
  }
});

// Single thought
app.get("/thought/:id", async (c) => {
  const id = c.req.param("id");
  const { data, error } = await supabase.from("thoughts").select("*").match(getIdentityFilter(id)).single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(mapThought(data));
});

// Update thought
app.put("/thought/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const filter = getIdentityFilter(id);
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.status !== undefined) {
    updates.status = body.status;
    updates.status_updated_at = new Date().toISOString();
  }
  if (body.type !== undefined) updates.type = body.type;
  if (body.importance !== undefined) updates.importance = body.importance;

  // Content edits need to flow through the same downstream pipeline as a fresh
  // capture: recompute the fingerprint, re-embed, archive the old version into
  // thought_versions, and force-requeue entity extraction. The DB trigger only
  // requeues when content_fingerprint changes — without an explicit recompute
  // here, the worker would skip the edited thought.
  let triggerRequeue = false;
  let updatedThoughtId: string | null = null;
  if (body.content !== undefined && typeof body.content === "string") {
    const newContent = body.content;
    updates.content = newContent;

    // Pull the current row so we can archive + know the old fingerprint
    const { data: existing } = await supabase
      .from("thoughts")
      .select("id, content, content_fingerprint, metadata, version")
      .match(filter)
      .single();

    if (existing) {
      updatedThoughtId = existing.id;
      const newFp = await fingerprint(newContent);
      if (newFp !== existing.content_fingerprint) {
        updates.content_fingerprint = newFp;
        triggerRequeue = true;
      }
      updates.version = (existing.version || 1) + 1;

      // Archive previous version (best-effort — table may not exist)
      try {
        await supabase.from("thought_versions").insert({
          thought_id: existing.id,
          version: existing.version || 1,
          content: existing.content,
          metadata: existing.metadata,
        });
      } catch {
        // ignore — table optional
      }
    }
  }

  if (body.classification) {
    updates.classification = body.classification;
    body.metadata = { ...(body.metadata || {}), classification: body.classification };
  }
  if (body.metadata) {
    const { data: existingMeta } = await supabase
      .from("thoughts")
      .select("metadata")
      .match(filter)
      .single();
    updates.metadata = {
      ...((existingMeta?.metadata as Record<string, unknown>) || {}),
      ...body.metadata,
    };
  }

  const { data, error } = await supabase
    .from("thoughts")
    .update(updates)
    .match(filter)
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);

  // Force-requeue extraction so the worker re-runs entity extraction + edge
  // graph + wiki regen on the edited content. Belt-and-braces: the trigger
  // SHOULD have done this when content_fingerprint changed, but the upsert
  // here also covers the case where the trigger's WHERE guard considered the
  // change a no-op (rare but possible after manual DB tinkering).
  if (triggerRequeue && updatedThoughtId) {
    await supabase.from("entity_extraction_queue").upsert({
      thought_id: updatedThoughtId,
      status: "pending",
      attempt_count: 0,
      last_error: null,
      queued_at: new Date().toISOString(),
      source_fingerprint: updates.content_fingerprint as string,
      source_updated_at: updates.updated_at as string,
    }, { onConflict: "thought_id" });

    // Re-embed in the background — don't block the PUT response
    getEmbedding(body.content as string)
      .then((emb) => {
        if (emb) {
          return supabase.from("thoughts").update({ embedding: emb }).match(filter);
        }
      })
      .catch(() => {});
  }

  return c.json({
    id: data.serial_id,
    action: "updated",
    requeued: triggerRequeue,
    message: "Saved",
  });
});

// Delete thought
app.delete("/thought/:id", async (c) => {
  const id = c.req.param("id");
  const { error } = await supabase.from("thoughts").delete().match(getIdentityFilter(id));
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ status: "deleted" });
});

// Resolve a `/thought/:id/reflection` path param (UUID or serial_id string)
// to the thought's canonical UUID, which is what reflections.thought_id FKs to.
async function resolveThoughtUuid(idParam: string): Promise<string | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idParam);
  if (isUuid) return idParam;
  const serial = parseInt(idParam, 10);
  if (Number.isNaN(serial)) return null;
  const { data } = await supabase.from("thoughts").select("id").eq("serial_id", serial).maybeSingle();
  return data?.id ?? null;
}

// Reflections — GET
app.get("/thought/:id/reflection", async (c) => {
  const uuid = await resolveThoughtUuid(c.req.param("id"));
  if (!uuid) return c.json({ reflections: [] });
  const { data, error } = await supabase
    .from("reflections")
    .select("*")
    .eq("thought_id", uuid)
    .order("created_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ reflections: data || [] });
});

// Reflections — POST
app.post("/thought/:id/reflection", async (c) => {
  const uuid = await resolveThoughtUuid(c.req.param("id"));
  if (!uuid) return c.json({ error: "thought not found" }, 404);
  const body = await c.req.json();
  // Accept both `reflection_type` (canonical, used by the dashboard composer)
  // and legacy `type` (older callers) — preferring the canonical name.
  const reflection_type = body.reflection_type ?? body.type ?? "general";
  const { data, error } = await supabase.from("reflections").insert({
    thought_id: uuid,
    reflection_type,
    trigger_context: body.trigger_context ?? "",
    conclusion: body.conclusion ?? "",
    options: Array.isArray(body.options) ? body.options : [],
    factors: Array.isArray(body.factors) ? body.factors : [],
    confidence: typeof body.confidence === "number" ? body.confidence : 1.0,
    metadata: body.metadata ?? {},
  }).select().single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ reflection: data }, 201, corsHeaders);
});

// Capture — quick single-thought ingest with dedup
app.post("/capture", async (c) => {
  const { content, source_type } = await c.req.json();
  if (!content?.trim()) return c.json({ error: "content is required" }, 400);

  const trimmed = content.trim();
  const fp = await fingerprint(trimmed);

  const { data: existing } = await supabase
    .from("thoughts")
    .select("serial_id, type")
    .eq("metadata->>content_fingerprint", fp)
    .maybeSingle();

  if (existing) {
    return c.json({
      thought_id: existing.serial_id,
      action: "duplicate",
      type: existing.type,
      content_fingerprint: fp,
      message: "Already in brain",
    }, 200, corsHeaders);
  }

  const { data: inserted, error } = await supabase
    .from("thoughts")
    .insert({
      content: trimmed,
      type: "observation",
      status: null,
      importance: 3,
      quality_score: 50,
      classification: "personal",
      source_type: source_type || "manual",
      content_fingerprint: fp,
      metadata: { content_fingerprint: fp },
    })
    .select("id, serial_id, type")
    .single();

  if (error) return c.json({ error: error.message }, 500);

  await supabase.from("entity_extraction_queue")
    .upsert({ thought_id: inserted.id }, { onConflict: "thought_id", ignoreDuplicates: true });

  getEmbedding(trimmed).then(emb => {
    if (emb) supabase.from("thoughts").update({ embedding: emb }).eq("id", inserted.id);
  });

  return c.json({
    thought_id: inserted.serial_id,
    action: "created",
    type: inserted.type,
    content_fingerprint: fp,
    message: "Thought captured",
  }, 201, corsHeaders);
});

// Capture-pending — ingest from Plaud without queueing for processing (waits for review)
app.post("/capture-pending", async (c) => {
  const { content, source_type, ollama_decision, update_target_id, original_content, type, classification, action_items } = await c.req.json();
  if (!content?.trim()) return c.json({ error: "content is required" }, 400);

  const trimmed = content.trim();
  const fp = await fingerprint(trimmed);

  const { data: existing } = await supabase
    .from("thoughts")
    .select("serial_id, type")
    .eq("metadata->>content_fingerprint", fp)
    .maybeSingle();

  if (existing) {
    return c.json({
      thought_id: existing.serial_id,
      action: "duplicate",
      message: "Already in brain",
    }, 200, corsHeaders);
  }

  const meta: Record<string, unknown> = {
    content_fingerprint: fp,
    review_status: "pending_review",
  };
  if (ollama_decision) meta.ollama_decision = ollama_decision;
  if (update_target_id != null) meta.update_target_id = update_target_id;
  if (original_content) meta.original_content = original_content;
  if (Array.isArray(action_items) && action_items.length > 0) {
    meta.action_items = action_items.filter((a: unknown) => typeof a === "string" && a.trim().length > 0);
  }

  const VALID_TYPES = ["task","idea","observation","reference","person_note","decision","lesson","meeting","journal","newsletter"];
  const resolvedType = (typeof type === "string" && VALID_TYPES.includes(type)) ? type : "observation";
  // Newsletter captures default to personal (professional reading, not work) —
  // anything else falls back to work unless the caller said otherwise.
  const classificationDefault = resolvedType === "newsletter" ? "personal" : "work";
  const resolvedClassification = (classification === "work" || classification === "personal") ? classification : classificationDefault;

  if (resolvedClassification) meta.classification = resolvedClassification;

  const { data: inserted, error } = await supabase
    .from("thoughts")
    .insert({
      content: trimmed,
      type: resolvedType,
      status: null,
      importance: 3,
      quality_score: 50,
      classification: resolvedClassification,
      source_type: source_type || "plaud",
      content_fingerprint: fp,
      metadata: meta,
    })
    .select("id, serial_id, type")
    .single();

  if (error) return c.json({ error: error.message }, 500);

  return c.json({
    thought_id: inserted.serial_id,
    action: "pending",
    message: "Thought queued for review",
  }, 201, corsHeaders);
});

// Review — approve a batch of pending thoughts
// For UPDATE decisions: applies merged content to the target thought + deletes pending
// For NEW decisions: queues the thought for entity extraction + clears review_status
app.post("/review/approve", async (c) => {
  const { ids } = await c.req.json();
  if (!Array.isArray(ids) || ids.length === 0) {
    return c.json({ error: "ids array is required" }, 400);
  }

  const results: Array<Record<string, unknown>> = [];

  for (const serialId of ids) {
    const { data: thought, error: fetchErr } = await supabase
      .from("thoughts")
      .select("*")
      .eq("serial_id", serialId)
      .maybeSingle();

    if (fetchErr || !thought) {
      results.push({ id: serialId, action: "error", message: "Not found" });
      continue;
    }

    const meta = (thought.metadata ?? {}) as Record<string, unknown>;
    const decision = meta.ollama_decision as string | undefined;
    const targetSerialId = meta.update_target_id as number | undefined;

    if (decision === "UPDATE" && targetSerialId) {
      // Apply merged content to the original thought, re-queue it, delete pending
      const { error: updateErr } = await supabase
        .from("thoughts")
        .update({ content: thought.content, updated_at: new Date().toISOString() })
        .eq("serial_id", targetSerialId);

      if (updateErr) {
        results.push({ id: serialId, action: "error", message: updateErr.message });
        continue;
      }

      const { data: targetRow } = await supabase
        .from("thoughts")
        .select("id")
        .eq("serial_id", targetSerialId)
        .maybeSingle();

      if (targetRow) {
        await supabase.from("entity_extraction_queue")
          .upsert({ thought_id: targetRow.id }, { onConflict: "thought_id", ignoreDuplicates: false });
        getEmbedding(thought.content).then(emb => {
          if (emb) supabase.from("thoughts").update({ embedding: emb }).eq("serial_id", targetSerialId);
        });
      }

      await supabase.from("thoughts").delete().eq("serial_id", serialId);
      results.push({ id: serialId, action: "update_applied", target_id: targetSerialId });

    } else {
      // Mark approved + queue for entity extraction + trigger embedding
      const cleanMeta: Record<string, unknown> = { ...meta };
      cleanMeta.review_status = "approved";
      delete cleanMeta.ollama_decision;
      delete cleanMeta.update_target_id;
      delete cleanMeta.original_content;

      await supabase.from("thoughts")
        .update({ metadata: cleanMeta })
        .eq("serial_id", serialId);

      await supabase.from("entity_extraction_queue")
        .upsert({ thought_id: thought.id }, { onConflict: "thought_id", ignoreDuplicates: true });

      getEmbedding(thought.content).then(emb => {
        if (emb) supabase.from("thoughts").update({ embedding: emb }).eq("id", thought.id);
      });

      results.push({ id: serialId, action: "approved" });
    }
  }

  return c.json({ results }, 200, corsHeaders);
});

// Ingestion jobs — list
app.get("/ingestion-jobs", async (c) => {
  const { data, error, count } = await supabase
    .from("ingestion_jobs")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ jobs: data || [], count: count ?? 0 }, 200, corsHeaders);
});

// Ingestion job — single
app.get("/ingestion-jobs/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const { data: job, error } = await supabase.from("ingestion_jobs").select("*").eq("id", id).maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!job) return c.json({ error: "Not found" }, 404);
  const { data: items } = await supabase.from("ingestion_items").select("*").eq("job_id", id).order("id");
  return c.json({ job, items: items || [] }, 200, corsHeaders);
});

// Ingest — extract and commit a block of text
app.post("/ingest", async (c) => {
  const { text, dry_run } = await c.req.json();
  if (!text?.trim()) return c.json({ error: "text is required" }, 400);

  const { data: job, error: jobErr } = await supabase
    .from("ingestion_jobs")
    .insert({ source_label: "manual", status: "pending" })
    .select().single();
  if (jobErr) return c.json({ error: jobErr.message }, 500);

  const extracted = await extractThoughts(text.trim());

  if (extracted.length > 0) {
    await supabase.from("ingestion_items").insert(
      extracted.map(item => ({
        job_id: job.id,
        content: item.content,
        type: item.type,
        fingerprint: "",
        action: "pending",
        status: "pending",
        metadata: {},
      }))
    );
  }

  await supabase.from("ingestion_jobs")
    .update({ status: "extracted", extracted_count: extracted.length })
    .eq("id", job.id);

  if (dry_run) {
    return c.json({ job_id: job.id, status: "dry_run_complete", extracted_count: extracted.length }, 201, corsHeaders);
  }

  const added = await executeJob(job.id);
  return c.json({ job_id: job.id, status: "complete", extracted_count: extracted.length, added_count: added }, 201, corsHeaders);
});

// Ingestion job — execute pending items
app.post("/ingestion-jobs/:id/execute", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const added = await executeJob(id);
  return c.json({ job_id: id, status: "complete", added_count: added }, 200, corsHeaders);
});

async function extractThoughts(text: string): Promise<Array<{ content: string; type: string }>> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (apiKey) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: `Extract distinct thoughts from the text. Return JSON: {"thoughts":[{"content":"...","type":"task|idea|observation|reference|meeting|decision|lesson"}]}. Max 20 thoughts.` },
            { role: "user", content: text },
          ],
        }),
      });
      if (r.ok) {
        const d = await r.json();
        const parsed = JSON.parse(d.choices[0].message.content);
        if (Array.isArray(parsed.thoughts) && parsed.thoughts.length > 0) return parsed.thoughts;
      }
    } catch { /* fall through to heuristic */ }
  }
  return text
    .split(/\n+/)
    .map((l: string) => l.replace(/^[\-\*•]\s*/, "").replace(/^\d+[.)]\s*/, "").trim())
    .filter((l: string) => l.length > 10)
    .slice(0, 20)
    .map((content: string) => ({ content, type: "observation" }));
}

async function executeJob(jobId: number): Promise<number> {
  const { data: items } = await supabase
    .from("ingestion_items").select("*").eq("job_id", jobId).eq("status", "pending");
  let added = 0;
  for (const item of items || []) {
    const fp = await fingerprint(item.content);
    const { data: dup } = await supabase.from("thoughts")
      .select("id").eq("metadata->>content_fingerprint", fp).maybeSingle();
    if (dup) {
      await supabase.from("ingestion_items").update({ action: "skip", status: "done", fingerprint: fp }).eq("id", item.id);
      continue;
    }
    const { data: ins } = await supabase.from("thoughts").insert({
      content: item.content, type: item.type || "observation",
      importance: 3, quality_score: 50, classification: "personal",
      content_fingerprint: fp,
      metadata: { content_fingerprint: fp, job_id: jobId },
    }).select("id, serial_id").single();
    if (ins) {
      await supabase.from("entity_extraction_queue")
        .upsert({ thought_id: ins.id }, { onConflict: "thought_id", ignoreDuplicates: true });
      getEmbedding(item.content).then(emb => {
        if (emb) supabase.from("thoughts").update({ embedding: emb }).eq("id", ins.id);
      });
      await supabase.from("ingestion_items")
        .update({ action: "add", status: "done", fingerprint: fp }).eq("id", item.id);
      added++;
    }
  }
  await supabase.from("ingestion_jobs")
    .update({ status: "complete", added_count: added, completed_at: new Date().toISOString() })
    .eq("id", jobId);
  return added;
}

// Wiki pages — list (no content field), includes entity aliases for search
// Wiki pages — list. Explicit pagination so we don't silently rely on
// PostgREST's db-default-rows (1000) ceiling. Returns the page slice + total
// count so the dashboard can show "N of M" and trigger fetch-more.
//   ?page=1          (1-based)
//   ?per_page=N      (default 5000, max 10000 — covers any realistic brain
//                     in one round-trip; bump only if needed)
app.get("/wiki-pages", async (c) => {
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const perPageParam = Number(c.req.query("per_page"));
  const perPage = Math.min(
    10000,
    Math.max(1, Number.isFinite(perPageParam) && perPageParam > 0 ? perPageParam : 5000)
  );
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;

  const { data, error, count } = await supabase
    .from("wiki_pages")
    .select(
      "id, slug, type, entity_id, title, generated_at, thought_count, manually_edited, metadata, entities(aliases)",
      { count: "exact" }
    )
    .order("type", { ascending: true })
    .order("title", { ascending: true })
    .range(from, to);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  const pages = (data || []).map((p: Record<string, unknown>) => {
    const ent = p.entities as { aliases?: string[] } | null;
    return { ...p, aliases: ent?.aliases ?? [], entities: undefined };
  });
  return c.json({
    data: pages,
    total: count ?? pages.length,
    page,
    per_page: perPage,
  }, 200, corsHeaders);
});

// Entities — list / search. Backed by search_entities() RPC so the search
// term matches canonical_name OR any alias in SQL. Default returns 200 rows
// (enough for the merge picker's initial render); when the user types a
// search term, the RPC narrows server-side and returns up to `limit` matches.
//   ?search=eu      — match canonical_name or any alias
//   ?no_wiki=true   — only entities without a wiki page
//   ?limit=N        — cap returned rows (default 200, max 5000)
app.get("/entities", async (c) => {
  const noWiki = c.req.query("no_wiki") === "true";
  const search = c.req.query("search") || "";
  const limitParam = Number(c.req.query("limit"));
  const limit = Math.min(
    5000,
    Math.max(20, Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 200)
  );

  const { data, error } = await supabase.rpc("search_entities", {
    p_search: search || null,
    p_no_wiki: noWiki,
    p_limit: limit,
  });
  if (error) return c.json({ error: error.message }, 500, corsHeaders);

  return c.json({ entities: data ?? [] }, 200, corsHeaders);
});

// Entities — add or remove an alias
app.patch("/entities/:id/aliases", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const alias = typeof body.alias === "string" ? body.alias.trim() : "";
  if (!alias) return c.json({ error: "alias (string) is required" }, 400, corsHeaders);

  const { data: entity, error: fetchErr } = await supabase
    .from("entities")
    .select("aliases")
    .eq("id", id)
    .single();
  if (fetchErr || !entity) return c.json({ error: "Entity not found" }, 404, corsHeaders);

  const current: string[] = entity.aliases ?? [];

  let updated: string[];
  let absorbed: { id: number; canonical_name: string }[] = [];
  let resplitQueued = 0;

  if (body.action === "remove" || body.action === "remove_and_resplit") {
    updated = current.filter((a: string) => a !== alias);
    // remove_and_resplit: undo a bad auto-absorb. Re-queue every thought
    // currently linked to this entity for re-extraction, so the worker can
    // re-derive entity bindings from content. Thoughts that mention the
    // removed alias name will get a fresh entity created (since the alias is
    // gone, no match exists), splitting the merged data back apart.
    if (body.action === "remove_and_resplit") {
      const { data: links } = await supabase
        .from("thought_entities")
        .select("thought_id")
        .eq("entity_id", id);
      const thoughtIds = Array.from(
        new Set((links ?? []).map((l: { thought_id: string }) => l.thought_id))
      );
      if (thoughtIds.length > 0) {
        const nowIso = new Date().toISOString();
        const rows = thoughtIds.map((thought_id) => ({
          thought_id,
          status: "pending",
          attempt_count: 0,
          last_error: null,
          queued_at: nowIso,
        }));
        await supabase
          .from("entity_extraction_queue")
          .upsert(rows, { onConflict: "thought_id" });
        resplitQueued = rows.length;
      }
      // Mark wiki page stale so the regen picks it up first.
      await supabase
        .from("wiki_pages")
        .update({ generated_at: null })
        .eq("entity_id", id);
    }
  } else {
    // Auto-absorb runs whether or not the alias is already in the list. Why:
    // a duplicate may have been created AFTER the alias was added, so the
    // alias being there doesn't guarantee absorption already happened.
    // Loose normalization (lowercase, hyphen↔space, trim) catches "EU-locked
    // Gemini" matching alias "EU Locked Gemini".
    absorbed = await absorbDuplicatesByName(id, alias);

    // Pull aliases from absorbed rows so they survive into the surviving entity
    const extraAliases = absorbed.flatMap((d) => d.aliases ?? []);
    const merged = new Set([...current, alias, ...extraAliases]);
    updated = Array.from(merged);
  }

  const { error: updateErr } = await supabase
    .from("entities")
    .update({ aliases: updated, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (updateErr) return c.json({ error: updateErr.message }, 500, corsHeaders);
  return c.json({
    aliases: updated,
    absorbed: absorbed.map((a) => ({ id: a.id, canonical_name: a.canonical_name })),
    resplit_queued: resplitQueued,
  }, 200, corsHeaders);
});

// Loose normalization used for alias-driven duplicate detection. Stricter than
// `normalized_name` (which keeps hyphens) — collapses any of [-_ ] runs to a
// single space so "EU-locked Gemini" and "EU Locked Gemini" match.
function looseNormalize(s: string): string {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[\s\-_]+/g, " ")
    .replace(/[.,;!?]+$/, "");
}

interface AbsorbedEntity {
  id: number;
  canonical_name: string;
  aliases: string[];
}

// Find any other entity whose canonical_name OR any of its aliases looses-
// matches the given name, and absorb each one into `survivorId`. Returns the
// list of absorbed entities so the caller can report them.
async function absorbDuplicatesByName(
  survivorId: number,
  matchName: string
): Promise<AbsorbedEntity[]> {
  const target = looseNormalize(matchName);
  if (!target) return [];

  // Pull a candidate set: any entity whose canonical_name OR alias contains the
  // first significant word of the match (cheap pre-filter via ilike), then
  // verify with full loose normalization in JS.
  const word = target.split(" ").reduce((longest, w) =>
    w.length > longest.length ? w : longest, ""
  );
  if (!word) return [];

  const { data: candidates } = await supabase
    .from("entities")
    .select("id, canonical_name, aliases, entity_type")
    .neq("id", survivorId)
    .or(`canonical_name.ilike.%${word}%,aliases.cs.{${word}}`)
    .limit(50);

  const matches: AbsorbedEntity[] = [];
  for (const c of candidates || []) {
    if (looseNormalize(c.canonical_name) === target) {
      matches.push({ id: c.id, canonical_name: c.canonical_name, aliases: c.aliases ?? [] });
      continue;
    }
    if ((c.aliases ?? []).some((a: string) => looseNormalize(a) === target)) {
      matches.push({ id: c.id, canonical_name: c.canonical_name, aliases: c.aliases ?? [] });
    }
  }

  // Absorb each match into the survivor. Mirror the logic from PATCH
  // /entities/:id absorbDuplicate(): move thought_entities, dedupe edges, drop
  // wiki page + entity row.
  for (const dupe of matches) {
    await supabase
      .from("thought_entities")
      .update({ entity_id: survivorId })
      .eq("entity_id", dupe.id);

    const { data: fromEdges } = await supabase
      .from("edges")
      .select("id, to_entity_id, relation")
      .eq("from_entity_id", dupe.id);
    for (const edge of fromEdges || []) {
      const { data: dup } = await supabase
        .from("edges")
        .select("id")
        .eq("from_entity_id", survivorId)
        .eq("to_entity_id", edge.to_entity_id)
        .eq("relation", edge.relation)
        .maybeSingle();
      if (!dup) {
        await supabase.from("edges").update({ from_entity_id: survivorId }).eq("id", edge.id);
      } else {
        await supabase.from("edges").delete().eq("id", edge.id);
      }
    }

    const { data: toEdges } = await supabase
      .from("edges")
      .select("id, from_entity_id, relation")
      .eq("to_entity_id", dupe.id);
    for (const edge of toEdges || []) {
      const { data: dup } = await supabase
        .from("edges")
        .select("id")
        .eq("from_entity_id", edge.from_entity_id)
        .eq("to_entity_id", survivorId)
        .eq("relation", edge.relation)
        .maybeSingle();
      if (!dup) {
        await supabase.from("edges").update({ to_entity_id: survivorId }).eq("id", edge.id);
      } else {
        await supabase.from("edges").delete().eq("id", edge.id);
      }
    }

    await supabase.from("wiki_pages").delete().eq("entity_id", dupe.id);
    await supabase.from("entities").delete().eq("id", dupe.id);
  }

  // Trigger downstream refresh on the survivor:
  //   1. Re-queue ONE of its thoughts for entity extraction so the
  //      thought_entity_edges trigger refreshes provenance / edge support.
  //   2. Mark the survivor's wiki page stale (generated_at = NULL) so the
  //      next compile picks it up first. The wiki compiler always
  //      regenerates everything but this lets a partial-regen script
  //      filter to "needs_regen" pages and act fast.
  if (matches.length > 0) {
    const { data: link } = await supabase
      .from("thought_entities")
      .select("thought_id")
      .eq("entity_id", survivorId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (link?.thought_id) {
      await supabase.from("entity_extraction_queue").upsert(
        {
          thought_id: link.thought_id,
          status: "pending",
          attempt_count: 0,
          last_error: null,
          queued_at: new Date().toISOString(),
        },
        { onConflict: "thought_id" }
      );
    }
    await supabase
      .from("wiki_pages")
      .update({ generated_at: null })
      .eq("entity_id", survivorId);
  }

  return matches;
}

// Entities — rename and/or reclassify (slug preserved to keep existing links)
app.patch("/entities/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const newName = typeof body.canonical_name === "string" ? body.canonical_name.trim() : null;
  const newType = typeof body.entity_type === "string" ? body.entity_type.trim() : null;

  if (!newName && !newType) {
    return c.json({ error: "canonical_name or entity_type is required" }, 400, corsHeaders);
  }

  const VALID_TYPES = ["person", "organization", "org", "project", "tool", "place", "topic", "entity", "newsletter"];
  if (newType && !VALID_TYPES.includes(newType)) {
    return c.json({ error: `Invalid entity_type. Must be one of: ${VALID_TYPES.join(", ")}` }, 400, corsHeaders);
  }

  // Before applying name or type changes, check for an invisible duplicate entity
  // (same entity_type + normalized_name, no wiki page) and silently absorb it.
  // This prevents unique-constraint failures when the target name/type already exists
  // in the DB but is not visible in the UI.
  async function absorbDuplicate(targetType: string, targetNormalizedName: string) {
    const { data: dupe } = await supabase
      .from("entities")
      .select("id")
      .eq("entity_type", targetType)
      .eq("normalized_name", targetNormalizedName)
      .neq("id", id)
      .maybeSingle();
    if (!dupe) return;
    await supabase.from("thought_entities").update({ entity_id: id }).eq("entity_id", dupe.id);
    const { data: fromEdges } = await supabase.from("edges").select("id, to_entity_id, relation").eq("from_entity_id", dupe.id);
    for (const edge of fromEdges || []) {
      const { data: dup } = await supabase.from("edges").select("id")
        .eq("from_entity_id", id).eq("to_entity_id", edge.to_entity_id).eq("relation", edge.relation).maybeSingle();
      if (!dup) await supabase.from("edges").update({ from_entity_id: id }).eq("id", edge.id);
      else await supabase.from("edges").delete().eq("id", edge.id);
    }
    const { data: toEdges } = await supabase.from("edges").select("id, from_entity_id, relation").eq("to_entity_id", dupe.id);
    for (const edge of toEdges || []) {
      const { data: dup } = await supabase.from("edges").select("id")
        .eq("from_entity_id", edge.from_entity_id).eq("to_entity_id", id).eq("relation", edge.relation).maybeSingle();
      if (!dup) await supabase.from("edges").update({ to_entity_id: id }).eq("id", edge.id);
      else await supabase.from("edges").delete().eq("id", edge.id);
    }
    await supabase.from("wiki_pages").delete().eq("entity_id", dupe.id);
    await supabase.from("entities").delete().eq("id", dupe.id);
  }

  const { data: current } = await supabase
    .from("entities").select("entity_type, normalized_name").eq("id", id).maybeSingle();

  if (current) {
    const effectiveType = newType || current.entity_type;
    const effectiveName = newName
      ? newName.toLowerCase().trim().replace(/\s+/g, " ")
      : current.normalized_name;
    await absorbDuplicate(effectiveType, effectiveName);
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (newName) {
    updates.canonical_name = newName;
    updates.normalized_name = newName.toLowerCase().trim().replace(/\s+/g, " ");
  }
  if (newType) updates.entity_type = newType;

  const { error } = await supabase.from("entities").update(updates).eq("id", id);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);

  // Keep wiki page title and metadata in sync
  if (newName || newType) {
    const { data: wikiPage } = await supabase
      .from("wiki_pages").select("id, title, metadata").eq("entity_id", id).maybeSingle();
    if (wikiPage) {
      const wikiUpdate: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (newName) wikiUpdate.title = newName;
      if (newType) wikiUpdate.metadata = { ...(wikiPage.metadata as object ?? {}), entity_type: newType };
      await supabase.from("wiki_pages").update(wikiUpdate).eq("entity_id", id);
    }
  }

  return c.json({ id, ...(newName ? { canonical_name: newName } : {}), ...(newType ? { entity_type: newType } : {}) }, 200, corsHeaders);
});

// Entities — delete (wiki_pages deleted explicitly; thought_entities + edges cascade)
// Adds (entity_type, normalized_name) to entity_blocklist so the local worker
// will not recreate this entity from thoughts that mention it. Aliases on other
// entities still resolve before the blocklist check, so merges/aliases survive.
app.delete("/entities/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || isNaN(id)) return c.json({ error: "Valid entity id required" }, 400, corsHeaders);

  const { data: entity } = await supabase
    .from("entities").select("entity_type, normalized_name").eq("id", id).maybeSingle();

  if (entity?.entity_type && entity?.normalized_name) {
    await supabase.from("entity_blocklist")
      .upsert({
        entity_type: entity.entity_type,
        normalized_name: entity.normalized_name,
        reason: "deleted",
        blocked_at: new Date().toISOString(),
      }, { onConflict: "entity_type,normalized_name" });
  }

  // wiki_pages FK is SET NULL so it won't cascade — delete it first
  await supabase.from("wiki_pages").delete().eq("entity_id", id);

  const { error } = await supabase.from("entities").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);

  return c.json({ deleted: true, id }, 200, corsHeaders);
});

// Entity blocklist — list all blocked names (deleted/merged sources)
app.get("/entity-blocklist", async (c) => {
  const { data, error } = await supabase
    .from("entity_blocklist")
    .select("entity_type, normalized_name, reason, blocked_at")
    .order("blocked_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ entries: data || [] }, 200, corsHeaders);
});

// Entity blocklist — unblock so the worker can re-extract this name. Use this
// if a delete was a mistake or the name now refers to a genuinely new entity.
app.delete("/entity-blocklist", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const entity_type = typeof body.entity_type === "string" ? body.entity_type.trim() : "";
  const normalized_name = typeof body.normalized_name === "string" ? body.normalized_name.trim().toLowerCase() : "";
  if (!entity_type || !normalized_name) {
    return c.json({ error: "entity_type and normalized_name (string) required" }, 400, corsHeaders);
  }
  const { error } = await supabase
    .from("entity_blocklist")
    .delete()
    .eq("entity_type", entity_type)
    .eq("normalized_name", normalized_name);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ unblocked: true, entity_type, normalized_name }, 200, corsHeaders);
});

// Distinct entity_type values currently in the entities table, with a count
// and a stable color per type. Used by the dashboard + wiki constellation to
// generate filter chips dynamically — adding a new entity_type lights up a
// new chip everywhere automatically. Backed by entity_types_summary() RPC so
// counting is GROUP BY in SQL — no row cap regardless of brain size.
app.get("/entity-types", async (c) => {
  const { data, error } = await supabase.rpc("entity_types_summary");
  if (error) return c.json({ error: error.message }, 500, corsHeaders);

  const counts = new Map<string, number>();
  for (const row of (data ?? []) as { entity_type: string; count: number | string }[]) {
    counts.set(row.entity_type, Number(row.count));
  }

  // Seed palette for the historical types so existing screens don't reshuffle
  // colors. New types fall back to a deterministic hash-of-name hue.
  const seedPalette: Record<string, string> = {
    person: "#9d83ff",
    organization: "#ff9650",
    org: "#ff9650",
    project: "#6ca6ff",
    tool: "#50c8c8",
    place: "#ffd870",
    topic: "#b8a6ff",
    entity: "#a8b8d0",
  };

  function hashedHue(name: string): number {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
  }

  const types = Array.from(counts.entries())
    .map(([entity_type, count]) => {
      // Plural label to match the dashboard legend conventions
      const label =
        entity_type === "person"
          ? "people"
          : entity_type === "organization" || entity_type === "org"
          ? "orgs"
          : `${entity_type}s`;
      const color = seedPalette[entity_type]
        ?? `oklch(72% 0.14 ${hashedHue(entity_type)})`;
      return { entity_type, label, color, count };
    })
    .sort((a, b) => b.count - a.count);

  return c.json({ types }, 200, corsHeaders);
});

// Distinct source_type values from the thoughts table with counts. Backed by
// the sources_summary() Postgres RPC so the heavy lifting is GROUP BY in SQL
// (returns ~10 rows). No row cap to worry about as the brain grows.
app.get("/sources", async (c) => {
  const { data, error } = await supabase.rpc("sources_summary");
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  const sources = (data ?? []).map((r: { source_type: string; count: number | string }) => ({
    source_type: r.source_type,
    count: Number(r.count),
  }));
  return c.json({ sources }, 200, corsHeaders);
});

// Constellation — top N entities by mention count, plus co-occurrence edges
// (number of thoughts mentioning both endpoints) for the dashboard hero graph.
// Days defaults to 90 to keep the graph current; pass 0 for all-time.
//
// focus_id: when set, switches selection mode to "neighbours of this entity"
//   — the entity itself + every entity it co-occurs with (weight >=
//   min_weight), capped at limit. Lets the wiki re-centre the constellation
//   on the currently-viewed entity without being trapped inside the global
//   top-N.
//
// focus_ids: comma-separated list of entity IDs. When passed, returns the
//   UNION of every focus's neighbourhood — used by wiki search when a query
//   like "zoom" matches multiple entities (Zoom + Zoom Contact Centre + Zoom
//   Virtual Agents) and the user wants all of them shown together.
//
// excluded_types: comma-separated entity_types to drop server-side. Honours
//   the dashboard / wiki type-filter chips so toggled-off types don't eat
//   slots in the top-N.
app.get("/constellation", async (c) => {
  // Cap at 200 — well above the UI's 100 option, leaves room for future
  // expansion. The Postgres RPCs underneath have no row cap; this is just
  // a sanity ceiling against runaway client requests.
  // Cap at 5000 — the wiki view sends limit=2000 to effectively get every
  // entity (~650 in the brain). Old cap of 200 was the actual bug behind
  // "showing 200 of 200 entities" on the dashboard hero: the wiki bumped
  // its requested limit but the server silently clamped to 200.
  const limit = Math.min(5000, Math.max(5, Number(c.req.query("limit")) || 30));
  const days = c.req.query("days") === undefined ? 90 : Number(c.req.query("days"));
  const minWeight = Math.max(1, Number(c.req.query("min_weight")) || 2);
  const classification = c.req.query("classification") || null;
  const focusIdRaw = c.req.query("focus_id");
  const focusIdsRaw = c.req.query("focus_ids") || "";
  const focusId = focusIdRaw ? Number(focusIdRaw) : null;
  const focusIdsList = focusIdsRaw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const excludedTypesRaw = c.req.query("excluded_types") || "";
  const excludedTypes = excludedTypesRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const excludedTypesArg = excludedTypes.length > 0 ? excludedTypes : null;

  // Three RPC paths depending on how the caller wants to scope the graph:
  // - focus_ids[]      → constellation_focus_neighbors_multi (union of N hoods)
  // - focus_id (single) → constellation_focus_neighbors
  // - neither           → constellation_top_entities (default top-N)
  const useMulti = focusIdsList.length > 0;
  const useSingle = !useMulti && focusId !== null && !isNaN(focusId);
  const { data: topData, error: topErr } = useMulti
    ? await supabase.rpc("constellation_focus_neighbors_multi", {
        p_focus_ids: focusIdsList,
        p_days: days,
        p_limit: limit,
        p_classification: classification,
        p_min_weight: 1,
        p_excluded_types: excludedTypesArg,
      })
    : useSingle
      ? await supabase.rpc("constellation_focus_neighbors", {
          p_focus_id: focusId,
          p_days: days,
          p_limit: limit,
          p_classification: classification,
          p_min_weight: 1,
          p_excluded_types: excludedTypesArg,
        })
      : await supabase.rpc("constellation_top_entities", {
          p_days: days,
          p_limit: limit,
          p_classification: classification,
          p_excluded_types: excludedTypesArg,
        });
  if (topErr) return c.json({ error: topErr.message }, 500, corsHeaders);

  type TopRow = { entity_id: number; canonical_name: string; entity_type: string; mentions: number | string };
  const top = (topData ?? []) as TopRow[];
  const entityIds = top.map((r) => r.entity_id);

  let edgesRaw: { source: number; target: number; weight: number | string }[] = [];
  if (entityIds.length > 0) {
    const { data: edgeData, error: edgeErr } = await supabase.rpc(
      "constellation_co_occurrence",
      {
        p_entity_ids: entityIds,
        p_days: days,
        p_classification: classification,
        p_min_weight: minWeight,
      }
    );
    if (edgeErr) return c.json({ error: edgeErr.message }, 500, corsHeaders);
    edgesRaw = (edgeData ?? []) as typeof edgesRaw;
  }

  // Resolve wiki slugs for the top entities so the dashboard can deep-link
  // each node directly into the wiki page.
  const slugMap = new Map<number, string>();
  if (entityIds.length > 0) {
    const { data: wikiRows } = await supabase
      .from("wiki_pages")
      .select("entity_id, slug")
      .in("entity_id", entityIds);
    for (const row of wikiRows || []) {
      if (row.entity_id) slugMap.set(row.entity_id, row.slug);
    }
  }

  const nodes = top.map((r) => ({
    id: r.entity_id,
    label: r.canonical_name,
    type: r.entity_type,
    mentions: Number(r.mentions),
    slug: slugMap.get(r.entity_id) ?? null,
  }));
  const edges = edgesRaw.map((e) => ({
    source: e.source,
    target: e.target,
    weight: Number(e.weight),
  }));

  // Strongest cluster — the heaviest edge
  const strongest = edges[0]
    ? {
        source: nodes.find((n) => n.id === edges[0].source)?.label ?? `#${edges[0].source}`,
        target: nodes.find((n) => n.id === edges[0].target)?.label ?? `#${edges[0].target}`,
        weight: edges[0].weight,
      }
    : null;

  return c.json({ nodes, edges, strongest, days }, 200, corsHeaders);
});

// ────────────────────────────────────────────────────────────────────────────
// Edges — read, delete (with auto-blocklist), and edge_blocklist management
// ────────────────────────────────────────────────────────────────────────────

// Mirrors the worker's SYMMETRIC_RELATIONS set in scripts/local-brain-worker.js.
// Symmetric relations are stored with from_entity_id < to_entity_id so a single
// row blocks/represents both directions. Keep these in sync.
const SYMMETRIC_RELATIONS = new Set([
  "co_occurs_with", "related_to", "collaborates_with", "integrates_with", "alternative_to",
]);
function normalizeEdgeKey(fromId: number, toId: number, relation: string): { from: number; to: number } {
  if (SYMMETRIC_RELATIONS.has(relation) && fromId > toId) return { from: toId, to: fromId };
  return { from: fromId, to: toId };
}

// List all edges touching an entity, with the other entity's name/type joined.
// Powers the dashboard's Edit Relationships panel.
app.get("/entities/:id/edges", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || isNaN(id)) return c.json({ error: "Valid entity id required" }, 400, corsHeaders);

  // Explicit per-side cap so we don't rely on PostgREST's default. The most
  // connected entity today has ~170 edges; 5000 leaves ~30x headroom for
  // graph growth without ever silently truncating.
  const PER_SIDE_LIMIT = 5000;
  const [outRes, inRes] = await Promise.all([
    supabase.from("edges")
      .select("id, from_entity_id, to_entity_id, relation, support_count, confidence, updated_at")
      .eq("from_entity_id", id)
      .limit(PER_SIDE_LIMIT),
    supabase.from("edges")
      .select("id, from_entity_id, to_entity_id, relation, support_count, confidence, updated_at")
      .eq("to_entity_id", id)
      .limit(PER_SIDE_LIMIT),
  ]);
  if (outRes.error) return c.json({ error: outRes.error.message }, 500, corsHeaders);
  if (inRes.error) return c.json({ error: inRes.error.message }, 500, corsHeaders);

  // De-dup symmetric edges (where this entity is on both sides via different orderings is impossible,
  // but the same edge could appear in both queries if both endpoints are this entity — guarded by the
  // edge constraint upstream)
  const seen = new Set<number>();
  const all = [...(outRes.data || []), ...(inRes.data || [])].filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  const otherIds = Array.from(new Set(all.flatMap((e) => [e.from_entity_id, e.to_entity_id]).filter((x) => x !== id)));
  const nameMap = new Map<number, { canonical_name: string; entity_type: string }>();
  const slugMap = new Map<number, string>();
  if (otherIds.length > 0) {
    const [{ data: ents }, { data: pages }] = await Promise.all([
      supabase
        .from("entities")
        .select("id, canonical_name, entity_type")
        .in("id", otherIds),
      supabase
        .from("wiki_pages")
        .select("entity_id, slug")
        .in("entity_id", otherIds),
    ]);
    for (const e of ents || []) nameMap.set(e.id, { canonical_name: e.canonical_name, entity_type: e.entity_type });
    for (const p of pages || []) {
      if (p.entity_id) slugMap.set(p.entity_id, p.slug);
    }
  }

  const edges = all.map((e) => {
    const otherId = e.from_entity_id === id ? e.to_entity_id : e.from_entity_id;
    const direction = e.from_entity_id === id ? "out" : "in";
    const other = nameMap.get(otherId) || { canonical_name: `#${otherId}`, entity_type: "unknown" };
    return {
      edge_id: e.id,
      id: e.id,
      from_entity_id: e.from_entity_id,
      to_entity_id: e.to_entity_id,
      relation: e.relation,
      support_count: e.support_count,
      confidence: e.confidence,
      direction,
      other_id: otherId,
      other_name: other.canonical_name,
      other_type: other.entity_type,
      other_slug: slugMap.get(otherId) ?? null,
      // Backwards-compat: keep the nested shape used by the existing edit panel
      other: { id: otherId, canonical_name: other.canonical_name, entity_type: other.entity_type },
      symmetric: SYMMETRIC_RELATIONS.has(e.relation),
    };
  });

  edges.sort((a, b) => (b.support_count ?? 0) - (a.support_count ?? 0));
  return c.json({ edges }, 200, corsHeaders);
});

// Thoughts that mention this entity (via thought_entities). Used by the
// constellation quick-edit modal to give a user one-click access to the
// source thoughts so they can be edited / deleted directly — after a
// thought edit + worker re-extraction, a stale entity often disappears
// because the new content no longer mentions it.
//
// Returns the top N most recent thoughts as { serial_id, content_preview,
// type, classification, created_at }. Defaults to 20; ?limit=N up to 200.
app.get("/entities/:id/thoughts", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || isNaN(id)) return c.json({ error: "Valid entity id required" }, 400, corsHeaders);
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 20));

  const { data: links, error: linksErr } = await supabase
    .from("thought_entities")
    .select("thought_id")
    .eq("entity_id", id);
  if (linksErr) return c.json({ error: linksErr.message }, 500, corsHeaders);
  const thoughtIds = Array.from(new Set((links ?? []).map((l: { thought_id: string }) => l.thought_id)));
  if (thoughtIds.length === 0) return c.json({ thoughts: [], total: 0 }, 200, corsHeaders);

  const { data: thoughts, error: thoughtsErr } = await supabase
    .from("thoughts")
    .select("id, serial_id, content, type, classification, source_type, created_at")
    .in("id", thoughtIds)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (thoughtsErr) return c.json({ error: thoughtsErr.message }, 500, corsHeaders);

  const rows = (thoughts ?? []).map((t: { id: string; serial_id: number; content: string; type: string; classification: string; source_type: string; created_at: string }) => ({
    serial_id: t.serial_id,
    content_preview: (t.content || "").slice(0, 200),
    type: t.type,
    classification: t.classification,
    source_type: t.source_type,
    created_at: t.created_at,
  }));
  return c.json({ thoughts: rows, total: thoughtIds.length }, 200, corsHeaders);
});

// Reflections attached to any thought that links to this entity. Used by the
// wiki page to surface lessons / decisions / retrospectives / hypotheses
// alongside the entity itself, so they don't get marooned on the single
// source thought.
app.get("/entities/:id/reflections", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || isNaN(id)) return c.json({ error: "Valid entity id required" }, 400, corsHeaders);

  // 1) Find all thought UUIDs linked to this entity
  const { data: links, error: linksErr } = await supabase
    .from("thought_entities")
    .select("thought_id")
    .eq("entity_id", id);
  if (linksErr) return c.json({ error: linksErr.message }, 500, corsHeaders);
  const thoughtIds = Array.from(new Set((links ?? []).map((l: { thought_id: string }) => l.thought_id)));
  if (thoughtIds.length === 0) return c.json({ reflections: [], by_type: {} }, 200, corsHeaders);

  // 2) Fetch reflections for those thoughts
  const { data: reflections, error: reflErr } = await supabase
    .from("reflections")
    .select("*")
    .in("thought_id", thoughtIds)
    .order("created_at", { ascending: false });
  if (reflErr) return c.json({ error: reflErr.message }, 500, corsHeaders);

  // 3) Map UUIDs back to serial_ids + a short content preview so the
  //    dashboard can render deep-links and context without a follow-up call.
  const { data: thoughts } = await supabase
    .from("thoughts")
    .select("id, serial_id, content")
    .in("id", thoughtIds);
  const thoughtMeta = new Map<string, { serial_id: number; preview: string }>();
  for (const t of thoughts ?? []) {
    thoughtMeta.set(t.id, {
      serial_id: t.serial_id,
      preview: String(t.content ?? "").replace(/\s+/g, " ").slice(0, 160),
    });
  }

  const enriched = (reflections ?? []).map((r: Record<string, unknown>) => ({
    ...r,
    source_thought_serial: thoughtMeta.get(r.thought_id as string)?.serial_id ?? null,
    source_thought_preview: thoughtMeta.get(r.thought_id as string)?.preview ?? "",
  }));

  // 4) Group by reflection_type for the dashboard's grouped rendering
  const byType: Record<string, typeof enriched> = {};
  for (const r of enriched) {
    const t = String(r.reflection_type ?? "general");
    (byType[t] ??= []).push(r);
  }

  return c.json({ reflections: enriched, by_type: byType }, 200, corsHeaders);
});

// Delete an edge AND add it to edge_blocklist so the worker won't recreate it.
// This is the "✕ remove" action from the Edit Relationships panel.
// Body: { from_entity_id, to_entity_id, relation }
app.delete("/edges", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const fromIdRaw = Number(body.from_entity_id);
  const toIdRaw = Number(body.to_entity_id);
  const relation = typeof body.relation === "string" ? body.relation.trim() : "";
  if (!fromIdRaw || !toIdRaw || !relation || isNaN(fromIdRaw) || isNaN(toIdRaw)) {
    return c.json({ error: "from_entity_id, to_entity_id, relation required" }, 400, corsHeaders);
  }
  const { from, to } = normalizeEdgeKey(fromIdRaw, toIdRaw, relation);

  await supabase.from("edge_blocklist").upsert({
    from_entity_id: from,
    to_entity_id: to,
    relation,
    reason: "user_removed",
    blocked_at: new Date().toISOString(),
  }, { onConflict: "from_entity_id,to_entity_id,relation" });

  // Layer 2: clear provenance rows. The trigger on thought_entity_edges DELETE
  // will recompute support_count to 0 and delete the edges row (unless an
  // endpoint is pinned, in which case the edges row is kept at support=0 —
  // that's intentional, but the explicit delete below ensures it's gone for
  // user-removed edges since the user clearly doesn't want it.
  await supabase.from("thought_entity_edges").delete()
    .eq("from_entity_id", from)
    .eq("to_entity_id", to)
    .eq("relation", relation);

  const { error } = await supabase.from("edges").delete()
    .eq("from_entity_id", from)
    .eq("to_entity_id", to)
    .eq("relation", relation);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);

  // Re-queue one thought from each affected entity so the local worker spawns
  // wiki regeneration. Without this, the article markdown stays stale — the
  // edges table is live and accurate, but the cached wiki content still shows
  // the deleted relation until something triggers a recompile.
  for (const entityId of [from, to]) {
    const { data: link } = await supabase
      .from("thought_entities")
      .select("thought_id")
      .eq("entity_id", entityId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (link?.thought_id) {
      await supabase.from("entity_extraction_queue").upsert({
        thought_id: link.thought_id,
        status: "pending",
        attempt_count: 0,
        last_error: null,
        queued_at: new Date().toISOString(),
      }, { onConflict: "thought_id" });
    }
  }

  return c.json({ deleted: true, blocklisted: true, from_entity_id: from, to_entity_id: to, relation, requeued: true }, 200, corsHeaders);
});

// Recent edge_blocklist entries touching this entity. Used by the Edges
// modal to detect a "panic delete" session — a burst of removals in a
// short window — and offer a one-click undo. Defaults to 5 minutes which
// catches a single-session click-storm without sweeping up legitimate
// older edits.
app.get("/entities/:id/recent-blocks", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || isNaN(id)) return c.json({ error: "Valid entity id required" }, 400, corsHeaders);
  const minutes = Math.max(1, Math.min(720, Number(c.req.query("minutes")) || 5));
  const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();

  const { data, error } = await supabase
    .from("edge_blocklist")
    .select("from_entity_id, to_entity_id, relation, reason, blocked_at")
    .gte("blocked_at", cutoff)
    .or(`from_entity_id.eq.${id},to_entity_id.eq.${id}`)
    .order("blocked_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500, corsHeaders);

  // Resolve other-entity names so the UI can render readable previews.
  const otherIds = Array.from(
    new Set((data || []).map((r) => (r.from_entity_id === id ? r.to_entity_id : r.from_entity_id)))
  );
  const nameMap = new Map<number, string>();
  if (otherIds.length > 0) {
    const { data: ents } = await supabase
      .from("entities")
      .select("id, canonical_name")
      .in("id", otherIds);
    for (const e of ents || []) nameMap.set(e.id, e.canonical_name);
  }
  const entries = (data || []).map((r) => ({
    ...r,
    other_name: nameMap.get(r.from_entity_id === id ? r.to_entity_id : r.from_entity_id) ??
      `#${r.from_entity_id === id ? r.to_entity_id : r.from_entity_id}`,
  }));
  return c.json({ entries, count: entries.length, minutes }, 200, corsHeaders);
});

// Undo recent blocklist deletions on an entity. Deletes the blocklist rows
// touching this entity within the last `minutes`, then re-queues every
// thought linked to this entity so the worker re-extracts the previously-
// deleted relationships. Round-trip is ~30-60s after the worker picks it
// up. Used by the Edges modal's "Undo last session" button.
app.post("/entities/:id/undo-recent-blocks", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || isNaN(id)) return c.json({ error: "Valid entity id required" }, 400, corsHeaders);
  const minutes = Math.max(1, Math.min(720, Number(c.req.query("minutes")) || 5));
  const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();

  // Step 1: find the recent blocklist entries touching this entity
  const { data: doomed, error: findErr } = await supabase
    .from("edge_blocklist")
    .select("from_entity_id, to_entity_id, relation")
    .gte("blocked_at", cutoff)
    .or(`from_entity_id.eq.${id},to_entity_id.eq.${id}`);
  if (findErr) return c.json({ error: findErr.message }, 500, corsHeaders);
  if (!doomed || doomed.length === 0) {
    return c.json({ ok: true, restored: 0, requeued: 0, message: "Nothing to undo in this window." }, 200, corsHeaders);
  }

  // Step 2: delete the blocklist entries one at a time (composite key)
  let removed = 0;
  for (const b of doomed) {
    const { error } = await supabase
      .from("edge_blocklist")
      .delete()
      .eq("from_entity_id", b.from_entity_id)
      .eq("to_entity_id", b.to_entity_id)
      .eq("relation", b.relation);
    if (error) return c.json({ error: error.message, partial_removed: removed }, 500, corsHeaders);
    removed++;
  }

  // Step 3: re-queue every thought linked to this entity so the worker
  // re-extracts the relationships that were just unblocked. We can't be
  // surgical about which specific thoughts produced which edges, so we
  // re-queue them all and let the worker rebuild.
  const { data: links } = await supabase
    .from("thought_entities")
    .select("thought_id")
    .eq("entity_id", id);
  const thoughtIds = Array.from(new Set((links || []).map((l) => l.thought_id)));
  let requeued = 0;
  for (let i = 0; i < thoughtIds.length; i += 100) {
    const batch = thoughtIds.slice(i, i + 100);
    const { error: qErr } = await supabase.from("entity_extraction_queue").upsert(
      batch.map((tid) => ({
        thought_id: tid,
        status: "pending",
        started_at: null,
        processed_at: null,
        last_error: null,
        queued_at: new Date().toISOString(),
      })),
      { onConflict: "thought_id" }
    );
    if (qErr) return c.json({ error: qErr.message, partial_requeued: requeued, restored: removed }, 500, corsHeaders);
    requeued += batch.length;
  }

  return c.json({
    ok: true,
    restored: removed,
    requeued,
    minutes,
    message: `Cleared ${removed} blocklist entries and re-queued ${requeued} thoughts. Worker will rebuild edges in ~30-60s once it picks up the queue.`,
  }, 200, corsHeaders);
});

// List all blocked edges with entity names joined for display.
app.get("/edge-blocklist", async (c) => {
  const { data, error } = await supabase
    .from("edge_blocklist")
    .select("from_entity_id, to_entity_id, relation, reason, blocked_at")
    .order("blocked_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500, corsHeaders);

  const ids = Array.from(new Set((data || []).flatMap((r: any) => [r.from_entity_id, r.to_entity_id])));
  const nameMap = new Map<number, string>();
  if (ids.length > 0) {
    const { data: ents } = await supabase.from("entities").select("id, canonical_name").in("id", ids);
    for (const e of ents || []) nameMap.set(e.id, e.canonical_name);
  }
  const entries = (data || []).map((r: any) => ({
    ...r,
    from_name: nameMap.get(r.from_entity_id) ?? `#${r.from_entity_id}`,
    to_name: nameMap.get(r.to_entity_id) ?? `#${r.to_entity_id}`,
  }));
  return c.json({ entries }, 200, corsHeaders);
});

// Unblock an edge so the worker can recreate it from extraction.
// Body: { from_entity_id, to_entity_id, relation }
app.delete("/edge-blocklist", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const fromIdRaw = Number(body.from_entity_id);
  const toIdRaw = Number(body.to_entity_id);
  const relation = typeof body.relation === "string" ? body.relation.trim() : "";
  if (!fromIdRaw || !toIdRaw || !relation || isNaN(fromIdRaw) || isNaN(toIdRaw)) {
    return c.json({ error: "from_entity_id, to_entity_id, relation required" }, 400, corsHeaders);
  }
  const { from, to } = normalizeEdgeKey(fromIdRaw, toIdRaw, relation);
  const { error } = await supabase.from("edge_blocklist").delete()
    .eq("from_entity_id", from)
    .eq("to_entity_id", to)
    .eq("relation", relation);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ unblocked: true, from_entity_id: from, to_entity_id: to, relation }, 200, corsHeaders);
});

// Wiki pages — update curator notes only (never overwritten by auto-regeneration)
app.patch("/wiki-pages/:slug/notes", async (c) => {
  const slug = c.req.param("slug");
  const body = await c.req.json();
  if (typeof body.notes !== "string") {
    return c.json({ error: "notes (string) is required" }, 400, corsHeaders);
  }
  const { data, error } = await supabase
    .from("wiki_pages")
    .update({ notes: body.notes || null, updated_at: new Date().toISOString() })
    .eq("slug", slug)
    .select("id, slug")
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  if (!data) return c.json({ error: "Not found" }, 404, corsHeaders);
  return c.json({ slug: data.slug, action: "notes_updated" }, 200, corsHeaders);
});

// Wiki pages — single page with full content
app.get("/wiki-pages/:slug", async (c) => {
  const slug = c.req.param("slug");
  const { data, error } = await supabase
    .from("wiki_pages")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  if (!data) return c.json({ error: "Not found" }, 404, corsHeaders);
  return c.json(data, 200, corsHeaders);
});

// Wiki pages — update content (sets manually_edited=true)
app.put("/wiki-pages/:slug", async (c) => {
  const slug = c.req.param("slug");
  const body = await c.req.json();
  if (typeof body.content !== "string" || !body.content.trim()) {
    return c.json({ error: "content (string) is required" }, 400, corsHeaders);
  }
  const { data, error } = await supabase
    .from("wiki_pages")
    .update({
      content: body.content,
      manually_edited: true,
      updated_at: new Date().toISOString(),
    })
    .eq("slug", slug)
    .select("id, slug")
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  if (!data) return c.json({ error: "Not found" }, 404, corsHeaders);
  return c.json({ slug: data.slug, action: "updated", message: "Saved" }, 200, corsHeaders);
});

// On-demand wiki regen. Doesn't actually run the wiki compiler from inside
// the Edge Function (the compiler is a local Node script using Ollama) —
// instead it forces one of the entity's thoughts back through the entity-
// extraction queue. The worker adds the entity_id to its dirtyEntityIds set
// during extraction and regenerates the wiki when the queue drains. Round
// trip is typically 30-60s depending on worker load. Useful for fixing one-
// off LLM glitches (e.g. token loops, stale content) without restarting
// anything.
app.post("/wiki-pages/:slug/regen", async (c) => {
  const slug = c.req.param("slug");

  const { data: page, error: pageErr } = await supabase
    .from("wiki_pages")
    .select("id, slug, entity_id")
    .eq("slug", slug)
    .maybeSingle();
  if (pageErr) return c.json({ error: pageErr.message }, 500, corsHeaders);
  if (!page) return c.json({ error: "Wiki page not found" }, 404, corsHeaders);
  if (!page.entity_id) {
    return c.json(
      { error: "Wiki page has no linked entity (legacy topic page) — cannot regen via worker" },
      400,
      corsHeaders
    );
  }

  // Pick the most recent thought linked to this entity so the re-extraction
  // gets meaningful content. Any thought works — the worker only needs to
  // see the entity_id flow through extraction to mark it dirty.
  const { data: link, error: linkErr } = await supabase
    .from("thought_entities")
    .select("thought_id, thoughts(id, created_at)")
    .eq("entity_id", page.entity_id)
    .order("thoughts(created_at)", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (linkErr) return c.json({ error: linkErr.message }, 500, corsHeaders);
  if (!link?.thought_id) {
    return c.json(
      { error: "Entity has no linked thoughts to re-extract — wiki will stay as-is" },
      400,
      corsHeaders
    );
  }

  // Upsert the queue row to pending. Force-upsert because the row may
  // already exist in 'complete' state and a plain update would change
  // nothing if the worker filters by status.
  const { error: queueErr } = await supabase
    .from("entity_extraction_queue")
    .upsert(
      {
        thought_id: link.thought_id,
        status: "pending",
        last_error: null,
        started_at: null,
        processed_at: null,
        queued_at: new Date().toISOString(),
      },
      { onConflict: "thought_id" }
    );
  if (queueErr) return c.json({ error: queueErr.message }, 500, corsHeaders);

  return c.json(
    {
      ok: true,
      slug,
      entity_id: page.entity_id,
      thought_id: link.thought_id,
      message: "Queued for regeneration. The local worker will pick this up on its next poll; the wiki article typically refreshes within 30-60 seconds.",
    },
    200,
    corsHeaders
  );
});

// Entity merge — reassigns thought_entities + edges to target, then deletes source
app.post("/entities/:id/merge", async (c) => {
  const sourceId = Number(c.req.param("id"));
  const body = await c.req.json();
  const targetId = Number(body.target_id);
  if (!targetId || isNaN(targetId) || targetId === sourceId) {
    return c.json({ error: "Valid target_id (different from source) required" }, 400, corsHeaders);
  }

  const { data: source } = await supabase
    .from("entities").select("canonical_name, aliases, entity_type, normalized_name").eq("id", sourceId).maybeSingle();
  if (!source) return c.json({ error: "Source entity not found" }, 404, corsHeaders);

  const { data: target } = await supabase
    .from("entities").select("canonical_name, aliases").eq("id", targetId).maybeSingle();
  if (!target) return c.json({ error: `Target entity not found (id=${targetId}). It may have been previously deleted — refresh the wiki and try again.` }, 404, corsHeaders);

  // Re-assign thought_entities
  await supabase.from("thought_entities").update({ entity_id: targetId }).eq("entity_id", sourceId);

  // Re-assign edges (as source) — drop duplicates
  const { data: srcEdges } = await supabase.from("edges")
    .select("id, to_entity_id, relation").eq("from_entity_id", sourceId);
  for (const edge of srcEdges || []) {
    const { data: dup } = await supabase.from("edges").select("id")
      .eq("from_entity_id", targetId).eq("to_entity_id", edge.to_entity_id)
      .eq("relation", edge.relation).maybeSingle();
    if (dup) {
      await supabase.from("edges").delete().eq("id", edge.id);
    } else {
      await supabase.from("edges").update({ from_entity_id: targetId }).eq("id", edge.id);
    }
  }

  // Re-assign edges (as target) — drop duplicates
  const { data: tgtEdges } = await supabase.from("edges")
    .select("id, from_entity_id, relation").eq("to_entity_id", sourceId);
  for (const edge of tgtEdges || []) {
    const { data: dup } = await supabase.from("edges").select("id")
      .eq("from_entity_id", edge.from_entity_id).eq("to_entity_id", targetId)
      .eq("relation", edge.relation).maybeSingle();
    if (dup) {
      await supabase.from("edges").delete().eq("id", edge.id);
    } else {
      await supabase.from("edges").update({ to_entity_id: targetId }).eq("id", edge.id);
    }
  }

  // Merge aliases — add source canonical_name + aliases into target
  const srcAliases: string[] = Array.isArray(source.aliases) ? source.aliases : [];
  const tgtAliases: string[] = Array.isArray(target.aliases) ? target.aliases : [];
  const combined = Array.from(new Set([...tgtAliases, ...srcAliases, source.canonical_name]));
  await supabase.from("entities")
    .update({ aliases: combined, updated_at: new Date().toISOString() })
    .eq("id", targetId);

  // Block the source name from being re-extracted as a new entity. Aliases on
  // the target now include the source's canonical_name, so when the worker
  // sees that name in a thought, the alias check resolves to the target BEFORE
  // the blocklist is consulted — merges still link correctly.
  if (source.entity_type && source.normalized_name) {
    await supabase.from("entity_blocklist")
      .upsert({
        entity_type: source.entity_type,
        normalized_name: source.normalized_name,
        reason: "merged",
        blocked_at: new Date().toISOString(),
      }, { onConflict: "entity_type,normalized_name" });
  }

  // Delete source wiki page + entity
  await supabase.from("wiki_pages").delete().eq("entity_id", sourceId);
  await supabase.from("entities").delete().eq("id", sourceId);

  return c.json({ merged: true, source_id: sourceId, target_id: targetId }, 200, corsHeaders);
});

// Double Mount — handles both /rest-api/... and /...
const api = new Hono();
api.route("/rest-api", app);
api.route("/", app);

Deno.serve(api.fetch);
