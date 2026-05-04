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

// Stats
app.get("/stats", async (c) => {
  const days = Number(c.req.query("days") ?? 30);

  const classification = c.req.query("classification");

  try {
    let query = supabase
      .from("thoughts")
      .select("type, metadata", { count: "exact" });


    if (classification) {
      query = query.filter("metadata->>classification", "eq", classification);
    }

    const { data, count, error } = await query;
    if (error) throw error;

    const typeMap: Record<string, number> = {};
    (data || []).forEach(t => {
      const type = t.type || "thought";
      typeMap[type] = (typeMap[type] || 0) + 1;
    });

    return c.json({
      total_thoughts: count ?? 0,
      window_days: days,
      types: typeMap,
      top_topics: []
    }, 200, corsHeaders);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500, corsHeaders);
  }
});

// Thoughts
app.get("/thoughts", async (c) => {
  const page = Number(c.req.query("page") ?? 1);
  const perPage = Number(c.req.query("per_page") ?? 20);

  const type = c.req.query("type");
  const classification = c.req.query("classification");
  const qualityScoreMax = c.req.query("quality_score_max");
  const importanceMin = c.req.query("importance_min");
  const status = c.req.query("status");

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
  const updates: any = { updated_at: new Date().toISOString() };
  if (body.status !== undefined) {
    updates.status = body.status;
    updates.status_updated_at = new Date().toISOString();
  }
  if (body.type !== undefined) updates.type = body.type;
  if (body.importance !== undefined) updates.importance = body.importance;
  if (body.content) updates.content = body.content;
  if (body.classification) {
    updates.classification = body.classification;
    body.metadata = { ...(body.metadata || {}), classification: body.classification };
  }
  if (body.metadata) {
    const { data: existing } = await supabase.from("thoughts").select("metadata").match(filter).single();
    updates.metadata = { ...(existing?.metadata || {}), ...body.metadata };
  }

  const { data, error } = await supabase.from("thoughts").update(updates).match(filter).select().single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ id: data.serial_id, action: "updated", message: "Saved" });
});

// Delete thought
app.delete("/thought/:id", async (c) => {
  const id = c.req.param("id");
  const { error } = await supabase.from("thoughts").delete().match(getIdentityFilter(id));
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ status: "deleted" });
});

// Reflections — GET
app.get("/thought/:id/reflection", async (c) => {
  const id = c.req.param("id");
  const { data, error } = await supabase.from("reflections").select("*").eq("thought_id", id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ reflections: data || [] });
});

// Reflections — POST
app.post("/thought/:id/reflection", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { data, error } = await supabase.from("reflections").insert({
    thought_id: id,
    type: body.type ?? "general",
    trigger_context: body.trigger_context ?? "",
    conclusion: body.conclusion ?? "",
    options: body.options ?? [],
    factors: body.factors ?? [],
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
app.get("/wiki-pages", async (c) => {
  const { data, error } = await supabase
    .from("wiki_pages")
    .select("id, slug, type, entity_id, title, generated_at, thought_count, manually_edited, metadata, entities(aliases)")
    .order("type", { ascending: true })
    .order("title", { ascending: true });
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  const pages = (data || []).map((p: Record<string, unknown>) => {
    const ent = p.entities as { aliases?: string[] } | null;
    return { ...p, aliases: ent?.aliases ?? [], entities: undefined };
  });
  return c.json({ data: pages }, 200, corsHeaders);
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
  if (body.action === "remove") {
    updated = current.filter((a: string) => a !== alias);
  } else {
    if (current.includes(alias)) return c.json({ aliases: current }, 200, corsHeaders);
    updated = [...current, alias];
  }

  const { error: updateErr } = await supabase
    .from("entities")
    .update({ aliases: updated, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (updateErr) return c.json({ error: updateErr.message }, 500, corsHeaders);
  return c.json({ aliases: updated }, 200, corsHeaders);
});

// Entities — rename and/or reclassify (slug preserved to keep existing links)
app.patch("/entities/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const newName = typeof body.canonical_name === "string" ? body.canonical_name.trim() : null;
  const newType = typeof body.entity_type === "string" ? body.entity_type.trim() : null;

  if (!newName && !newType) {
    return c.json({ error: "canonical_name or entity_type is required" }, 400, corsHeaders);
  }

  const VALID_TYPES = ["person", "organization", "org", "project", "tool", "place", "topic", "entity"];
  if (newType && !VALID_TYPES.includes(newType)) {
    return c.json({ error: `Invalid entity_type. Must be one of: ${VALID_TYPES.join(", ")}` }, 400, corsHeaders);
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (newName) {
    updates.canonical_name = newName;
    updates.normalized_name = newName.toLowerCase().trim().replace(/\s+/g, " ");
  }
  if (newType) updates.entity_type = newType;

  const { error } = await supabase.from("entities").update(updates).eq("id", id);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);

  // Keep wiki page title in sync when renamed (slug unchanged)
  if (newName) {
    await supabase.from("wiki_pages")
      .update({ title: newName, updated_at: new Date().toISOString() })
      .eq("entity_id", id);
  }

  return c.json({ id, ...(newName ? { canonical_name: newName } : {}), ...(newType ? { entity_type: newType } : {}) }, 200, corsHeaders);
});

// Entities — delete (wiki_pages deleted explicitly; thought_entities + edges cascade)
app.delete("/entities/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || isNaN(id)) return c.json({ error: "Valid entity id required" }, 400, corsHeaders);

  // wiki_pages FK is SET NULL so it won't cascade — delete it first
  await supabase.from("wiki_pages").delete().eq("entity_id", id);

  const { error } = await supabase.from("entities").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);

  return c.json({ deleted: true, id }, 200, corsHeaders);
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

// Entity merge — reassigns thought_entities + edges to target, then deletes source
app.post("/entities/:id/merge", async (c) => {
  const sourceId = Number(c.req.param("id"));
  const body = await c.req.json();
  const targetId = Number(body.target_id);
  if (!targetId || isNaN(targetId) || targetId === sourceId) {
    return c.json({ error: "Valid target_id (different from source) required" }, 400, corsHeaders);
  }

  const { data: source, error: srcErr } = await supabase
    .from("entities").select("canonical_name, aliases").eq("id", sourceId).single();
  if (srcErr || !source) return c.json({ error: "Source entity not found" }, 404, corsHeaders);

  const { data: target, error: tgtErr } = await supabase
    .from("entities").select("canonical_name, aliases").eq("id", targetId).single();
  if (tgtErr || !target) return c.json({ error: "Target entity not found" }, 404, corsHeaders);

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
