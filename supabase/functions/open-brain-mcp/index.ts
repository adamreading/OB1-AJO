import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const CITATION_BASE_URL =
  Deno.env.get("OPEN_BRAIN_CITATION_BASE_URL") || "https://openbrain.local/thoughts";

function thoughtTitle(content: string, createdAt?: string): string {
  const firstLine = content.replace(/\s+/g, " ").trim().slice(0, 80);
  const datePrefix = createdAt ? new Date(createdAt).toLocaleDateString() : "Open Brain";
  return firstLine ? `${datePrefix} - ${firstLine}` : `${datePrefix} thought`;
}

function thoughtUrl(serialId: number | string): string {
  return `${CITATION_BASE_URL.replace(/\/$/, "")}/${serialId}`;
}

// 16-char SHA-256 prefix of normalized content. MUST match the format used
// by the rest-api capture path so the entity-extraction trigger sees an
// edited thought as having a different fingerprint and re-queues it.
async function fingerprint(text: string): Promise<string> {
  const normalized = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

async function getEmbedding(text: string): Promise<number[] | null> {
  if (!OPENROUTER_API_KEY) return null;
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    console.warn(`OpenRouter embeddings failed: ${r.status} ${msg}`);
    return null;
  }
  const d = await r.json();
  return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  if (!OPENROUTER_API_KEY) {
    return { topics: ["uncategorized"], type: "observation" };
  }
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    console.warn(`OpenRouter metadata extraction failed: ${r.status} ${msg}`);
    return { topics: ["uncategorized"], type: "observation" };
  }
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

function distillHeuristic(text: string): Array<{ content: string; type: string }> {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^[\-\*\u2022]\s*/, "").replace(/^\d+[.)]\s*/, "").trim())
    .filter((line) => line.length > 10)
    .slice(0, 20)
    .map((content) => ({ content, type: "observation" }));
}

function createServer(): McpServer {
  const server = new McpServer({
    name: "open-brain",
    version: "1.5.2",
  });

  // ChatGPT compatibility aliases — restricted ChatGPT connectors look for exact `search` / `fetch` shapes
  server.registerTool(
    "search",
    {
      title: "Search Open Brain",
      description: "Search Open Brain memories by meaning. Read-only compatibility tool for ChatGPT.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().describe("The search query to run against Open Brain thoughts"),
      },
    },
    async ({ query }) => {
      try {
        const qEmb = await getEmbedding(query);
        if (!qEmb) return { content: [{ type: "text" as const, text: "Embedding unavailable." }], isError: true };
        const { data, error } = await supabase.rpc("match_thoughts", {
          query_embedding: qEmb,
          match_threshold: 0.5,
          match_count: 10,
        });
        if (error) return { content: [{ type: "text" as const, text: `Search error: ${error.message}` }], isError: true };
        const results = ((data || []) as any[]).map((t) => ({
          id: String(t.serial_id || t.id),
          title: thoughtTitle(t.content, t.created_at),
          url: thoughtUrl(t.serial_id || t.id),
        }));
        return { content: [{ type: "text" as const, text: JSON.stringify({ results }) }] };
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch Open Brain Thought",
      description: "Fetch one Open Brain thought by serial ID after using search. Read-only compatibility tool for ChatGPT.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        id: z.string().describe("The thought serial ID returned by the search tool"),
      },
    },
    async ({ id }) => {
      try {
        const filter = /^\d+$/.test(id) ? { serial_id: parseInt(id, 10) } : { id };
        const { data, error } = await supabase
          .from("thoughts")
          .select("serial_id, id, content, metadata, created_at, updated_at")
          .match(filter)
          .single();
        if (error) return { content: [{ type: "text" as const, text: `Fetch error: ${error.message}` }], isError: true };
        const t = data as any;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              id: String(t.serial_id),
              title: thoughtTitle(t.content, t.created_at),
              text: t.content,
              url: thoughtUrl(t.serial_id),
              metadata: { ...t.metadata, created_at: t.created_at, updated_at: t.updated_at },
            }),
          }],
        };
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // Tool 1: Semantic Search
  server.registerTool(
    "search_thoughts",
    {
      title: "Search Thoughts",
      description:
        "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea. Respects Work/Personal context. Returns source so you can see where each memory came from. Each result includes any reflections attached to that thought (lessons, decisions, hypotheses, retrospectives) — read them and surface relevant ones to the user, especially lesson_trace and decision_trace when similar situations arise.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().describe("What to search for"),
        classification: z.enum(["work", "personal"]).optional().describe("Filter by 'work' or 'personal' context (Strict: hiding nulls if set)"),
        limit: z.number().optional().default(10),
        threshold: z.number().optional().default(0.15),
        source: z.string().optional().describe("Filter by source e.g. 'mcp-fieldy-auto', 'mcp-chatgpt', 'mcp-n8n'"),
      },
    },
    async ({ query, classification, limit, threshold, source }) => {
      try {
        const qEmb = await getEmbedding(query.toLowerCase());
        let data: any[] | null = null;
        let error: any = null;

        if (qEmb) {
          const filterObj: Record<string, unknown> = {};
          if (classification) filterObj.classification = classification;

          const rpcParams: Record<string, unknown> = {
            query_embedding: qEmb,
            match_threshold: threshold,
            match_count: limit,
          };
          if (Object.keys(filterObj).length > 0) rpcParams.filter = filterObj;

          const result = await supabase.rpc("match_thoughts", rpcParams);
          data = result.data;
          error = result.error;
        } else {
          let textQuery = supabase
            .from("thoughts")
            .select("serial_id, id, content, metadata, source_type, created_at")
            .ilike("content", `%${query}%`)
            .order("created_at", { ascending: false })
            .limit(limit);
          if (classification) textQuery = textQuery.filter("metadata->>classification", "eq", classification);
          if (source) textQuery = textQuery.eq("source_type", source);
          const result = await textQuery;
          data = (result.data || []).map((t: any) => ({ ...t, similarity: null }));
          error = result.error;
        }

        if (error) return { content: [{ type: "text", text: `Search error: ${error.message}` }], isError: true };

        if (!data || data.length === 0) {
          return { content: [{ type: "text", text: `No ${classification || ""} thoughts found matching "${query}".` }] };
        }

        // Apply source filter post-query if specified (match_thoughts doesn't support it natively)
        const filtered = source
          ? data.filter((t: any) => t.source_type === source || t.metadata?.source === source)
          : data;

        if (filtered.length === 0) {
          return { content: [{ type: "text", text: `No thoughts found matching "${query}" from source "${source}".` }] };
        }

        // Bundle any reflections attached to these thoughts so AI callers
        // get the *reasoning behind* a thought (lessons, decisions,
        // hypotheses, retrospectives) inline with each search hit — no
        // need for a separate tool call.
        const uuids = filtered.map((t: any) => t.id).filter(Boolean);
        const refByThought = new Map<string, any[]>();
        if (uuids.length > 0) {
          const { data: refRows } = await supabase
            .from("reflections")
            .select("thought_id, reflection_type, conclusion, trigger_context, confidence, created_at")
            .in("thought_id", uuids)
            .order("created_at", { ascending: false });
          for (const r of refRows ?? []) {
            const arr = refByThought.get(r.thought_id) ?? [];
            arr.push(r);
            refByThought.set(r.thought_id, arr);
          }
        }

        const results = filtered.map((t: any, i: number) => {
          const m = t.metadata || {};
          const label = m.classification ? `[${m.classification.toUpperCase()}] ` : "";
          const src = t.source_type ? ` (${t.source_type})` : "";
          const score = typeof t.similarity === "number" ? `\nSimilarity: ${(t.similarity * 100).toFixed(0)}%` : "\nMatch: text";
          let reflectionsBlock = "";
          const refs = refByThought.get(t.id) ?? [];
          if (refs.length > 0) {
            const lines = refs.slice(0, 5).map((r: any) => {
              const concl = String(r.conclusion ?? "").replace(/\s+/g, " ").slice(0, 140);
              const conf = typeof r.confidence === "number" ? ` (conf ${r.confidence.toFixed(2)})` : "";
              return `   [${r.reflection_type ?? "general"}] ${concl}${conf}`;
            });
            const more = refs.length > 5 ? `\n   …and ${refs.length - 5} more` : "";
            reflectionsBlock = `\n↪ Reflections (${refs.length}):\n${lines.join("\n")}${more}`;
          }
          return `${i + 1}. ${label}#${t.serial_id || t.id}${src}\n${t.content}${score}${reflectionsBlock}`;
        });

        return { content: [{ type: "text", text: `Found ${filtered.length} results:\n\n${results.join("\n\n")}` }] };
      } catch (err: unknown) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // Tool 2: List Recent
  server.registerTool(
    "list_thoughts",
    {
      title: "List Recent Thoughts",
      description: "List recently captured thoughts. Supports filtering by context, type, and source. Always shows source so you know where each memory came from.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        limit: z.number().optional().default(10),
        classification: z.enum(["work", "personal"]).optional().describe("Filter: 'work' or 'personal'"),
        type: z.string().optional().describe("e.g. task, idea, reference"),
        source: z.string().optional().describe("Filter by source e.g. 'mcp-fieldy-auto', 'mcp-chatgpt', 'mcp-n8n'"),
        since_hours: z.number().optional().describe("Only return thoughts created in the last N hours e.g. 24"),
      },
    },
    async ({ limit, classification, type, source, since_hours }) => {
      try {
        let q = supabase
          .from("thoughts")
          .select("serial_id, id, content, metadata, source_type, created_at")
          .order("created_at", { ascending: false })
          .limit(limit);

        if (classification) {
          q = q.filter("metadata->>classification", "eq", classification);
        }
        if (type) q = q.eq("type", type);
        if (source) q = q.eq("source_type", source);
        if (since_hours) {
          const since = new Date(Date.now() - since_hours * 60 * 60 * 1000).toISOString();
          q = q.gte("created_at", since);
        }

        const { data, error } = await q;
        if (error) return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        if (!data?.length) return { content: [{ type: "text", text: "No thoughts found." }] };

        const results = data.map((t: any) => {
          const m = t.metadata || {};
          const label = m.classification ? `[${m.classification.toUpperCase()}] ` : "";
          const src = t.source_type ? ` (${t.source_type})` : "";
          return `#${t.serial_id} ${label}(${t.created_at.split("T")[0]})${src}\n${t.content}`;
        });

        return { content: [{ type: "text", text: results.join("\n\n") }] };
      } catch (err: unknown) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // Tool 3: Stats
  server.registerTool(
    "thought_stats",
    {
      title: "Thought Statistics",
      description: "Get summary stats. Can be filtered by context.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        classification: z.enum(["work", "personal"]).optional(),
      },
    },
    async ({ classification }) => {
      try {
        const { data, error } = await supabase.rpc("brain_stats_aggregate", {
          p_since_days: 30,
          p_classification: classification || null
        });
        if (error) return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };

        const res = [
          `Total thoughts: ${data.total}`,
          `Top topics: ${(data.top_topics || []).map((t:any) => t.topic).join(", ")}`,
          `Classification: ${classification || "All"}`
        ];
        return { content: [{ type: "text", text: res.join("\n") }] };
      } catch (err: unknown) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // Tool 4: Capture Thought
  server.registerTool(
    "capture_thought",
    {
      title: "Capture Thought",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false },
      description: "Save a new thought to the brain. IMPORTANT: Each capture must be ONE atomic idea — aim for 300–500 words of rich context per thought. If you have a transcript, meeting notes, or multiple unrelated ideas, call this tool MULTIPLE TIMES, once per distinct idea. Do NOT save giant blocks of text covering multiple topics as a single thought — splitting them ensures 10x better search quality. You MUST declare your own client name in 'source' — use the actual name of the AI or tool calling this (e.g., 'claude', 'chatgpt', 'perplexity', 'copilot', 'n8n'). Never use another client's name. Set auto_review=true ONLY for unattended / scheduled batch imports where a human has not personally signed off on this individual capture — those land in the dashboard Review queue instead of going straight into the brain.",
      inputSchema: {
        content: z.string().describe("One atomic thought — around 300–500 words of context. One topic only; use multiple captures for multiple ideas."),
        classification: z.enum(["work", "personal"]).optional().describe("Work or Personal context"),
        type: z.string().optional().describe("e.g. task, idea, reference"),
        source: z.string().optional().describe("REQUIRED: Your actual client name. If you are Claude, pass 'claude'. If ChatGPT, pass 'chatgpt'. If Perplexity, pass 'perplexity'. Use YOUR name — not any other tool's name."),
        auto_review: z.boolean().optional().describe("If true, this capture is treated as a machine-proposed thought (e.g. a scheduled Plaud transcript processor) and routed into the dashboard Review queue for manual approval. Defaults to false — meaning a human is signing off on this capture in real time."),
      },
    },
    async ({ content, classification, type, source, auto_review }) => {
      try {
        const finalSource = source ? `mcp-${source}` : "mcp";
        const trimmed = content.trim();

        // Auto-review path: no embedding, no extraction queue, lands in
        // metadata.review_status='pending_review' and surfaces in /review.
        if (auto_review) {
          const fp = await fingerprint(trimmed);

          const { data: existing } = await supabase
            .from("thoughts")
            .select("serial_id")
            .eq("metadata->>content_fingerprint", fp)
            .maybeSingle();
          if (existing) {
            return { content: [{ type: "text", text: `Already in brain: #${existing.serial_id} (skipped)` }] };
          }

          const VALID_TYPES = ["task","idea","observation","reference","person_note","decision","lesson","meeting","journal","newsletter"];
          const resolvedType = (typeof type === "string" && VALID_TYPES.includes(type)) ? type : "observation";
          // Newsletter captures default to personal (professional reading, not work) —
          // anything else falls back to work unless the caller said otherwise.
          const classificationDefault = resolvedType === "newsletter" ? "personal" : "work";
          const resolvedClassification = (classification === "work" || classification === "personal") ? classification : classificationDefault;

          const meta: Record<string, unknown> = {
            content_fingerprint: fp,
            review_status: "pending_review",
            ollama_decision: "NEW",
            source: finalSource,
            classification: resolvedClassification,
          };

          const { data: inserted, error } = await supabase
            .from("thoughts")
            .insert({
              content: trimmed,
              type: resolvedType,
              status: null,
              importance: 3,
              quality_score: 50,
              classification: resolvedClassification,
              source_type: "plaud",
              content_fingerprint: fp,
              metadata: meta,
            })
            .select("serial_id")
            .single();

          if (error) return { content: [{ type: "text", text: `Failed: ${error.message}` }], isError: true };

          return { content: [{ type: "text", text: `Queued for review: #${inserted.serial_id} (pending manual approval in dashboard)` }] };
        }

        // Default path: human-attended capture — go straight into the brain.
        const [embedding, extracted] = await Promise.all([getEmbedding(trimmed), extractMetadata(trimmed)]);

        const metadata = { ...extracted, source: finalSource, classification };

        const { data: upsertResult, error: upsertError } = await supabase.rpc("upsert_thought", {
          p_content: trimmed,
          p_payload: {
            metadata,
            type: type || (metadata.type as string),
            importance: 3,
            source_type: finalSource
          },
        });

        if (upsertError) return { content: [{ type: "text", text: `Failed: ${upsertError.message}` }], isError: true };

        if (embedding) await supabase.from("thoughts").update({ embedding }).eq("id", upsertResult.id);

        return { content: [{ type: "text", text: `Captured: #${upsertResult.serial_id} [${classification?.toUpperCase() || "UNCATEGORIZED"}]` }] };
      } catch (err: unknown) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // Tool 5: Update Thought
  server.registerTool(
    "update_thought",
    {
      title: "Update Thought",
      description: "Update content and optionally move context. Archives old version. Use the serial number shown in search results (e.g. '132'), not a UUID. Set auto_review=true ONLY for unattended / scheduled batch imports — instead of overwriting the target thought immediately, a pending UPDATE-decision row is created in the dashboard Review queue, where you can compare the original vs proposed content before approving.",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        id: z.string().describe("UUID or Serial ID (as string)"),
        content: z.string(),
        classification: z.enum(["work", "personal"]).optional(),
        type: z.string().optional().describe("Optional thought type override (e.g. 'newsletter'). If omitted, the target's existing type is preserved."),
        auto_review: z.boolean().optional().describe("If true, do NOT overwrite the target thought. Instead, create a pending UPDATE-decision row in the dashboard Review queue (the target's original content is captured for side-by-side comparison). Defaults to false — meaning a human is signing off on this update in real time."),
        source: z.string().optional().describe("Optional client name for provenance when auto_review=true (e.g. 'cowork-scheduler'). Stored in metadata.source as 'mcp-<name>'."),
      },
    },
    async ({ id, content, classification, type, auto_review, source }) => {
      try {
        const filter = /^[0-9a-f]{8}-/.test(id) ? { id } : { serial_id: parseInt(id, 10) };
        const { data: current } = await supabase.from("thoughts").select("*").match(filter).single();
        if (!current) return { content: [{ type: "text", text: "Not found" }], isError: true };

        // Auto-review path: don't touch the target. Insert a new pending
        // thought with the proposed merged content, an UPDATE decision,
        // and the target's current content captured for comparison.
        if (auto_review) {
          const trimmed = content.trim();
          const fp = await fingerprint(trimmed);

          const VALID_TYPES = ["task","idea","observation","reference","person_note","decision","lesson","meeting","journal","newsletter"];
          const resolvedType = (typeof type === "string" && VALID_TYPES.includes(type)) ? type : (current.type || "observation");
          // Newsletter updates default to personal; otherwise keep target's existing classification (or work).
          const currentClass = current.classification || (current.metadata as Record<string, unknown> | null)?.classification;
          const classificationDefault = resolvedType === "newsletter" ? "personal" : (currentClass || "work");
          const resolvedClassification = (classification === "work" || classification === "personal") ? classification : classificationDefault;

          const meta: Record<string, unknown> = {
            content_fingerprint: fp,
            review_status: "pending_review",
            ollama_decision: "UPDATE",
            update_target_id: current.serial_id,
            original_content: current.content,
            source: source ? `mcp-${source}` : "mcp",
            classification: resolvedClassification,
          };

          const { data: inserted, error: insertErr } = await supabase
            .from("thoughts")
            .insert({
              content: trimmed,
              type: resolvedType,
              status: null,
              importance: 3,
              quality_score: 50,
              classification: resolvedClassification,
              source_type: "plaud",
              content_fingerprint: fp,
              metadata: meta,
            })
            .select("serial_id")
            .single();

          if (insertErr) return { content: [{ type: "text", text: `Failed: ${insertErr.message}` }], isError: true };

          return { content: [{ type: "text", text: `Update proposed: #${inserted.serial_id} → #${current.serial_id} (pending manual approval in dashboard)` }] };
        }

        // Default path: human-attended update — overwrite the target in place.
        // Archive
        await supabase.from("thought_versions").insert({
          thought_id: current.id,
          version: current.version || 1,
          content: current.content,
          metadata: current.metadata,
        });

        const embedding = await getEmbedding(content);
        const metadata = { ...(current.metadata || {}), classification: classification || current.metadata?.classification };

        // Recompute content_fingerprint so the entity-extraction trigger
        // notices the edit and the worker re-runs entity/wiki extraction.
        const newFp = await fingerprint(content);
        const fingerprintChanged = newFp !== current.content_fingerprint;

        const updatePayload: Record<string, unknown> = {
          content,
          metadata,
          version: (current.version || 1) + 1,
          updated_at: new Date().toISOString(),
        };
        if (fingerprintChanged) updatePayload.content_fingerprint = newFp;
        if (embedding) updatePayload.embedding = embedding;

        const { error } = await supabase.from("thoughts").update(updatePayload).match(filter);

        if (error) return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };

        // Force-requeue extraction explicitly (belt + braces alongside the
        // DB trigger). Worker picks up status='pending' rows and re-extracts.
        if (fingerprintChanged) {
          await supabase.from("entity_extraction_queue").upsert({
            thought_id: current.id,
            status: "pending",
            attempt_count: 0,
            last_error: null,
            queued_at: new Date().toISOString(),
            source_fingerprint: newFp,
            source_updated_at: updatePayload.updated_at as string,
          }, { onConflict: "thought_id" });
        }

        return { content: [{ type: "text", text: "Updated successfully." }] };
      } catch (err: unknown) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // Tool 6: Distill Transcript
  server.registerTool(
    "distill_transcript",
    {
      title: "Distill Transcript",
      description: "Analyze a long transcript or text block and break it down into separate, atomic thoughts for capture. Returns suggestions; use capture_thought to save them.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        text: z.string().describe("The raw text to split"),
        classification: z.enum(["work", "personal"]).optional().describe("Assign context to all distilled thoughts"),
      },
    },
    async ({ text, classification }) => {
      try {
        if (!OPENROUTER_API_KEY) {
          const thoughts = distillHeuristic(text);
          const res = thoughts.map((t:any, i:number) => `${i+1}. [${t.type.toUpperCase()}] ${t.content}`);
          return { content: [{ type: "text", text: `Distilled ${thoughts.length} thoughts:\n\n${res.join("\n\n")}\n\nPlease review and use capture_thought to save any you want to keep.` }] };
        }

        const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "openai/gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: "Break the provided transcript into separate atomic thoughts. Return JSON with 'thoughts' array where each item has 'content' and 'type' (task, idea, reference, observation). Ensure each thought is standalone and self-contained." },
              { role: "user", content: text }
            ]
          })
        });
        const d = await r.json();
        const thoughts = JSON.parse(d.choices[0].message.content).thoughts;
        const res = thoughts.map((t:any, i:number) => `${i+1}. [${t.type.toUpperCase()}] ${t.content}`);
        return { content: [{ type: "text", text: `Distilled ${thoughts.length} thoughts:\n\n${res.join("\n\n")}\n\nPlease review and use capture_thought to save any you want to keep.` }] };
      } catch (err) {
        const thoughts = distillHeuristic(text);
        const res = thoughts.map((t:any, i:number) => `${i+1}. [${t.type.toUpperCase()}] ${t.content}`);
        return { content: [{ type: "text", text: `Distilled ${thoughts.length} thoughts using local fallback:\n\n${res.join("\n\n")}\n\nPlease review and use capture_thought to save any you want to keep.` }] };
      }
    }
  );

  // Tool 7: Delete Thought
  server.registerTool(
    "delete_thought",
    {
      title: "Delete Thought",
      description: "Permanently delete a thought by UUID or Serial ID.",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: {
        id: z.string().describe("UUID or Serial ID"),
      },
    },
    async ({ id }) => {
      try {
        const filter = /^[0-9a-f]{8}-/.test(id) ? { id } : { serial_id: parseInt(id, 10) };
        const { error } = await supabase.from("thoughts").delete().match(filter);
        if (error) return { content: [{ type: "text", text: error.message }], isError: true };
        return { content: [{ type: "text", text: `Deleted thought ${id}` }] };
      } catch (err: unknown) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // Tool 8: Find Duplicates
  server.registerTool(
    "find_duplicates",
    {
      title: "Find Duplicates",
      description: "Identify semantically similar thoughts that might be duplicates.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        classification: z.enum(["work", "personal"]).optional(),
        threshold: z.number().optional().default(0.85),
      },
    },
    async ({ classification, threshold }) => {
      const { data, error } = await supabase.rpc("brain_duplicates_find", {
        p_threshold: threshold,
        p_classification: classification || null
      });
      if (error) return { content: [{ type: "text", text: error.message }], isError: true };
      const res = (data || []).map((p: any) => `* Duplicate pair (${(p.similarity * 100).toFixed(0)}% match):\n  A: #${p.thought_a_serial} "${p.content_a.substring(0, 50)}..."\n  B: #${p.thought_b_serial} "${p.content_b.substring(0, 50)}..."`);
      return { content: [{ type: "text", text: res.length ? res.join("\n\n") : "No duplicates found." }] };
    }
  );

  // Tool 9: Add Reflection
  server.registerTool(
    "add_reflection",
    {
      title: "Add Reflection",
      description: "Attach a structured reflection to a thought — the *reasoning behind* a decision, lesson, retrospective, or hypothesis. Reflection types: decision_trace (you chose X over Y because…), lesson_trace (what this taught you), retrospective (looking back at a project / period), hypothesis (something you predicted, with what would confirm or refute it), or general (anything else). Free-text 'reflection' is the conclusion; pass reflection_type for structured surfacing in the dashboard.",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        thought_id: z.string().describe("UUID or Serial ID (as string) of the thought to reflect on"),
        reflection: z.string().describe("The conclusion — the realization, lesson, or decision being captured"),
        reflection_type: z.enum(["decision_trace", "lesson_trace", "retrospective", "hypothesis", "general"]).optional().default("general"),
        trigger_context: z.string().optional().describe("Optional — what prompted this reflection (e.g. 'reviewing Q1 outcomes', 'after the migration failed')"),
        confidence: z.number().min(0).max(1).optional().default(1.0).describe("How confident you are in this reflection, 0.0–1.0. Default 1.0."),
      },
    },
    async ({ thought_id, reflection, reflection_type, trigger_context, confidence }) => {
      const filter = /^[0-9a-f]{8}-/.test(thought_id) ? { id: thought_id } : { serial_id: parseInt(thought_id, 10) };
      const { data: thought } = await supabase.from("thoughts").select("id, serial_id").match(filter).single();
      if (!thought) return { content: [{ type: "text", text: "Thought not found" }], isError: true };

      const { error } = await supabase.from("reflections").insert({
        thought_id: thought.id,
        reflection_type: reflection_type ?? "general",
        conclusion: reflection,
        trigger_context: trigger_context ?? "",
        confidence: typeof confidence === "number" ? confidence : 1.0,
      });
      if (error) return { content: [{ type: "text", text: `Failed: ${error.message}` }], isError: true };
      return { content: [{ type: "text", text: `Reflection (${reflection_type ?? "general"}) saved on thought #${thought.serial_id}.` }] };
    }
  );

  // Tool 10: Capture Review — list recent auto-captured memories for daily review (source-agnostic, replaces fieldy_review)
  server.registerTool(
    "capture_review",
    {
      title: "Capture Review",
      description: "Fetch recently auto-captured memories for daily review. By default shows all known auto-capture sources (Fieldy, Plaud). Pass a specific source to focus on one device. Returns serial ID, content, classification, and timestamp so you can check for errors, wrong attribution, or missing context.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        since_hours: z.number().optional().default(24).describe("How many hours back to look (default 24)"),
        limit: z.number().optional().default(50),
        source: z.string().optional().describe("Filter to a specific source e.g. 'mcp-plaud', 'mcp-fieldy-auto'. Omit to see all auto-capture sources."),
      },
    },
    async ({ since_hours, limit, source }) => {
      const AUTO_CAPTURE_SOURCES = ["mcp-fieldy-auto", "mcp-fieldy-pending", "mcp-plaud"];
      try {
        const since = new Date(Date.now() - since_hours * 60 * 60 * 1000).toISOString();

        let q = supabase
          .from("thoughts")
          .select("serial_id, content, metadata, source_type, created_at")
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(limit);

        if (source) {
          q = q.eq("source_type", source);
        } else {
          q = q.in("source_type", AUTO_CAPTURE_SOURCES);
        }

        const { data, error } = await q;
        if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };

        const sourceLabel = source || "auto-capture";
        if (!data?.length) return { content: [{ type: "text" as const, text: `No ${sourceLabel} memories found in the last ${since_hours} hours.` }] };

        const results = data.map((t: any) => {
          const m = t.metadata || {};
          const label = m.classification ? `[${m.classification.toUpperCase()}] ` : "";
          const isPending = t.source_type === "mcp-fieldy-pending" ? " ⚠️ PENDING" : "";
          return `#${t.serial_id} ${label}(${t.created_at.split("T")[0]}) ${t.source_type}${isPending}\n${t.content}`;
        });

        return { content: [{ type: "text" as const, text: `${data.length} auto-captured memories from the last ${since_hours}h:\n\n${results.join("\n\n")}` }] };
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // Tool 11: Search Wiki
  server.registerTool(
    "search_wiki",
    {
      title: "Search Wiki",
      description: "Search the entity wiki by name. Returns matching pages with slug, type, and thought count. Use the slug with read_wiki_page to get the full article.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().describe("Entity name or topic to search for"),
        limit: z.number().optional().default(10),
      },
    },
    async ({ query, limit }) => {
      try {
        const { data, error } = await supabase
          .from("wiki_pages")
          .select("slug, title, type, entity_id, thought_count, metadata, entities(aliases)")
          .ilike("title", `%${query}%`)
          .order("thought_count", { ascending: false })
          .limit(limit);

        if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };

        // Also search aliases for any pages not already matched
        const matchedSlugs = new Set((data || []).map((p: any) => p.slug));
        const { data: allPages } = await supabase
          .from("wiki_pages")
          .select("slug, title, type, entity_id, thought_count, metadata, entities(aliases)")
          .order("thought_count", { ascending: false });

        const aliasMatches = (allPages || []).filter((p: any) => {
          if (matchedSlugs.has(p.slug)) return false;
          const aliases: string[] = (p.entities as any)?.aliases ?? [];
          return aliases.some((a: string) => a.toLowerCase().includes(query.toLowerCase()));
        }).slice(0, limit - (data || []).length);

        const results = [...(data || []), ...aliasMatches].map((p: any) => {
          const entityType = (p.metadata?.entity_type as string) ?? p.type;
          const aliases: string[] = (p.entities as any)?.aliases ?? [];
          const aliasNote = aliases.length ? ` (also: ${aliases.join(", ")})` : "";
          return `slug: ${p.slug}\ntitle: ${p.title}${aliasNote}\ntype: ${entityType}\nthoughts: ${p.thought_count}`;
        });

        if (!results.length) return { content: [{ type: "text" as const, text: `No wiki pages found matching "${query}".` }] };
        return { content: [{ type: "text" as const, text: `Found ${results.length} wiki page(s):\n\n${results.join("\n\n")}` }] };
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // Tool 12: Read Wiki Page
  server.registerTool(
    "read_wiki_page",
    {
      title: "Read Wiki Page",
      description: "Read the full content of a wiki article by slug. Returns the article, curator notes, and lists of linked entities and cited thought IDs so you can navigate or look up references.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        slug: z.string().describe("The wiki page slug (from search_wiki results)"),
      },
    },
    async ({ slug }) => {
      try {
        const { data, error } = await supabase
          .from("wiki_pages")
          .select("slug, title, type, entity_id, thought_count, metadata, content, notes, generated_at")
          .eq("slug", slug)
          .maybeSingle();

        if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
        if (!data) return { content: [{ type: "text" as const, text: `No wiki page found with slug "${slug}".` }], isError: true };

        const p = data as any;

        // Extract cited thought serial IDs from [#NNN] or [NNN] patterns
        const citedIds: number[] = [];
        const citationRegex = /\[#?(\d+)\]/g;
        let m;
        while ((m = citationRegex.exec(p.content)) !== null) {
          const n = parseInt(m[1], 10);
          if (!citedIds.includes(n)) citedIds.push(n);
        }

        // Extract linked entity slugs from /wiki?slug=X patterns
        const linkedSlugs: string[] = [];
        const linkRegex = /\/wiki\?slug=([a-z0-9-]+)/g;
        while ((m = linkRegex.exec(p.content)) !== null) {
          if (!linkedSlugs.includes(m[1])) linkedSlugs.push(m[1]);
        }

        // Resolve linked slugs to titles
        let linkedEntities: { slug: string; title: string }[] = [];
        if (linkedSlugs.length) {
          const { data: linked } = await supabase
            .from("wiki_pages")
            .select("slug, title")
            .in("slug", linkedSlugs);
          linkedEntities = (linked || []) as { slug: string; title: string }[];
        }

        const entityType = (p.metadata?.entity_type as string) ?? p.type;
        const header = [
          `# ${p.title}`,
          `type: ${entityType} | thoughts: ${p.thought_count} | generated: ${p.generated_at?.slice(0, 10)}`,
          citedIds.length ? `cited_thought_ids: [${citedIds.join(", ")}]  ← use fetch tool to read any of these` : "",
          linkedEntities.length ? `linked_entities:\n${linkedEntities.map(e => `  - ${e.title} (slug: ${e.slug})`).join("\n")}` : "",
          p.notes ? `\n> Curator note: ${p.notes}` : "",
          "",
        ].filter(Boolean).join("\n");

        return { content: [{ type: "text" as const, text: `${header}\n${p.content}` }] };
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // Tool 13: Get Entity Connections
  server.registerTool(
    "get_entity_connections",
    {
      title: "Get Entity Connections",
      description: "Get all entities connected to a wiki entity via the knowledge graph edges. Shows relation type, direction, and confidence. Use slugs to navigate to connected wiki pages with read_wiki_page.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        slug: z.string().describe("The wiki page slug of the entity to get connections for"),
      },
    },
    async ({ slug }) => {
      try {
        const { data: page, error: pageErr } = await supabase
          .from("wiki_pages")
          .select("entity_id, title")
          .eq("slug", slug)
          .maybeSingle();

        if (pageErr) return { content: [{ type: "text" as const, text: `Error: ${pageErr.message}` }], isError: true };
        if (!page || !(page as any).entity_id) return { content: [{ type: "text" as const, text: `No entity found for slug "${slug}".` }] };

        const entityId = (page as any).entity_id as number;

        const { data: edges, error: edgeErr } = await supabase
          .from("edges")
          .select("from_entity_id, to_entity_id, relation, confidence, support_count")
          .or(`from_entity_id.eq.${entityId},to_entity_id.eq.${entityId}`)
          .order("support_count", { ascending: false });

        if (edgeErr) return { content: [{ type: "text" as const, text: `Error: ${edgeErr.message}` }], isError: true };
        if (!edges?.length) return { content: [{ type: "text" as const, text: `No connections found for "${(page as any).title}".` }] };

        // Collect connected entity IDs and resolve their wiki pages in one query
        const connectedIds = [...new Set(edges.map((e: any) =>
          e.from_entity_id === entityId ? e.to_entity_id : e.from_entity_id
        ))];

        const { data: connectedPages } = await supabase
          .from("wiki_pages")
          .select("slug, title, entity_id")
          .in("entity_id", connectedIds);

        const pageByEntityId = new Map((connectedPages || []).map((p: any) => [p.entity_id, p]));

        const lines = edges.map((e: any) => {
          const otherId = e.from_entity_id === entityId ? e.to_entity_id : e.from_entity_id;
          const direction = e.from_entity_id === entityId ? "→" : "←";
          const other = pageByEntityId.get(otherId) as any;
          const otherLabel = other ? `${other.title} (slug: ${other.slug})` : `entity #${otherId} (no wiki page)`;
          const conf = e.confidence ? ` [${(e.confidence * 100).toFixed(0)}%]` : "";
          return `${direction} ${e.relation}${conf} × ${e.support_count}: ${otherLabel}`;
        });

        return { content: [{ type: "text" as const, text: `Connections for "${(page as any).title}":\n\n${lines.join("\n")}` }] };
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // Tool 14: Get Context Brief — structured session-start briefing for any AI client
  server.registerTool(
    "get_context_brief",
    {
      title: "Get Context Brief",
      description: "Generate a structured briefing for starting a new session. Returns active Kanban items, recent captures, entities mentioned recently, open action items, and recently updated wiki pages. Call this at the start of any session to get shared context without copy-pasting between AI clients.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        scope: z.enum(["work", "personal", "all"]).optional().default("all").describe("Filter by context scope"),
        hours: z.number().optional().default(48).describe("How many hours back to look for recent activity"),
      },
    },
    async ({ scope, hours }) => {
      try {
        const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
        const classification = scope === "all" ? undefined : scope;

        // Active/planning Kanban items
        let kanbanQ = supabase
          .from("thoughts")
          .select("serial_id, content, type, status, metadata, importance")
          .in("status", ["active", "planning"])
          .in("type", ["task", "idea"])
          .order("importance", { ascending: false })
          .limit(15);
        if (classification) kanbanQ = kanbanQ.filter("metadata->>classification", "eq", classification);

        // Recent captures
        let recentQ = supabase
          .from("thoughts")
          .select("serial_id, id, content, metadata, source_type, created_at")
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(8);
        if (classification) recentQ = recentQ.filter("metadata->>classification", "eq", classification);

        // Open action items
        let actionQ = supabase
          .from("thoughts")
          .select("serial_id, content, metadata, created_at")
          .gte("created_at", since)
          .not("metadata->action_items", "is", null)
          .order("created_at", { ascending: false })
          .limit(20);
        if (classification) actionQ = actionQ.filter("metadata->>classification", "eq", classification);

        const [kanbanRes, recentRes, actionRes, wikiRes] = await Promise.all([
          kanbanQ,
          recentQ,
          actionQ,
          supabase.from("wiki_pages").select("slug, title, type, thought_count, generated_at").order("generated_at", { ascending: false }).limit(4),
        ]);

        // Entity mentions from recent thoughts (two-step: IDs then join)
        const recentUuids = (recentRes.data || []).map((t: any) => t.id).filter(Boolean);
        const mentionMap = new Map<number, { name: string; type: string; count: number }>();
        if (recentUuids.length) {
          const { data: mentions } = await supabase
            .from("thought_entities")
            .select("entity_id, entities(canonical_name, entity_type)")
            .in("thought_id", recentUuids);
          for (const m of mentions || []) {
            const e = (m as any).entities;
            if (!e) continue;
            const existing = mentionMap.get((m as any).entity_id) ?? { name: e.canonical_name, type: e.entity_type, count: 0 };
            mentionMap.set((m as any).entity_id, { ...existing, count: existing.count + 1 });
          }
        }
        const topEntities = [...mentionMap.values()].sort((a, b) => b.count - a.count).slice(0, 6);

        // Action items extraction
        const allActions: { item: string; thoughtId: number; date: string }[] = [];
        for (const t of actionRes.data || []) {
          const items = (t as any).metadata?.action_items;
          if (Array.isArray(items) && items.length) {
            items.forEach((item: string) => allActions.push({ item, thoughtId: (t as any).serial_id, date: (t as any).created_at.slice(0, 10) }));
          }
        }

        const lines: string[] = [`## Context Brief — ${scope === "all" ? "All" : scope.charAt(0).toUpperCase() + scope.slice(1)} | Last ${hours}h\n`];

        lines.push("### Active & In-Planning");
        const kanbanItems = kanbanRes.data || [];
        if (kanbanItems.length) {
          const byStatus: Record<string, any[]> = { active: [], planning: [] };
          kanbanItems.forEach((t: any) => { if (t.status in byStatus) byStatus[t.status].push(t); });
          if (byStatus.active.length) {
            lines.push("**Active:**");
            byStatus.active.forEach((t: any) => lines.push(`  - #${t.serial_id} [${t.type}] ${t.content.slice(0, 100)}`));
          }
          if (byStatus.planning.length) {
            lines.push("**Planning:**");
            byStatus.planning.forEach((t: any) => lines.push(`  - #${t.serial_id} [${t.type}] ${t.content.slice(0, 100)}`));
          }
        } else {
          lines.push("  (no active or planning items)");
        }

        lines.push(`\n### Recent Captures (last ${hours}h)`);
        if (recentRes.data?.length) {
          recentRes.data.forEach((t: any) => {
            const label = t.metadata?.classification ? `[${t.metadata.classification.toUpperCase()}] ` : "";
            const src = t.source_type ? ` (${t.source_type})` : "";
            lines.push(`  #${t.serial_id} ${label}${t.created_at.slice(0, 10)}${src}: ${t.content.slice(0, 100)}`);
          });
        } else {
          lines.push("  (nothing captured in this window)");
        }

        if (topEntities.length) {
          lines.push(`\n### Entities Mentioned (last ${hours}h)`);
          topEntities.forEach(e => lines.push(`  - ${e.name} [${e.type}] × ${e.count}`));
        }

        if (allActions.length) {
          lines.push("\n### Open Action Items");
          allActions.slice(0, 10).forEach(a => lines.push(`  - ${a.item} (from #${a.thoughtId}, ${a.date})`));
          if (allActions.length > 10) lines.push(`  … and ${allActions.length - 10} more`);
        }

        if (wikiRes.data?.length) {
          lines.push("\n### Recently Updated Wiki");
          wikiRes.data.forEach((p: any) => lines.push(`  - ${p.title} [${p.type}] — ${p.thought_count} thoughts (slug: ${p.slug})`));
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // Tool 15: Resume — low-friction "where was I?" for mid-session context recovery
  server.registerTool(
    "resume",
    {
      title: "Resume — Where Was I?",
      description: "Quick context recovery for returning to work after an interruption. Shows the last 6 captures, active Kanban items, open action items from the last 24 hours, and what entity you were most focused on. Use any time you've lost your thread.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => {
      try {
        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        const [lastRes, kanbanRes, actionRes] = await Promise.all([
          supabase.from("thoughts")
            .select("serial_id, id, content, metadata, source_type, created_at")
            .order("created_at", { ascending: false })
            .limit(6),
          supabase.from("thoughts")
            .select("serial_id, content, type, status, metadata, importance")
            .in("status", ["active", "planning"])
            .in("type", ["task", "idea"])
            .order("importance", { ascending: false })
            .limit(10),
          supabase.from("thoughts")
            .select("serial_id, metadata, created_at")
            .gte("created_at", since24h)
            .not("metadata->action_items", "is", null)
            .order("created_at", { ascending: false })
            .limit(15),
        ]);

        // Top entity from last 6 thoughts
        const recentIds = (lastRes.data || []).map((t: any) => t.id).filter(Boolean);
        let topEntityLabel = "";
        if (recentIds.length) {
          const { data: mentions } = await supabase
            .from("thought_entities")
            .select("entity_id, entities(canonical_name)")
            .in("thought_id", recentIds);
          const counts = new Map<number, { name: string; count: number }>();
          for (const m of mentions || []) {
            const name = (m as any).entities?.canonical_name;
            if (!name) continue;
            const existing = counts.get((m as any).entity_id) ?? { name, count: 0 };
            counts.set((m as any).entity_id, { ...existing, count: existing.count + 1 });
          }
          const top = [...counts.values()].sort((a, b) => b.count - a.count)[0];
          if (top) topEntityLabel = `${top.name} (×${top.count})`;
        }

        const lines: string[] = ["## Resume — Where Were You?\n"];

        lines.push("### Last 6 Captures");
        if (lastRes.data?.length) {
          lastRes.data.forEach((t: any) => {
            const label = t.metadata?.classification ? `[${t.metadata.classification.toUpperCase()}] ` : "";
            const src = t.source_type ? ` (${t.source_type})` : "";
            lines.push(`  #${t.serial_id} ${label}${t.created_at.slice(0, 10)}${src}: ${t.content.slice(0, 120)}`);
          });
        } else {
          lines.push("  (no recent captures)");
        }

        lines.push("\n### Active & Planning");
        if (kanbanRes.data?.length) {
          kanbanRes.data.forEach((t: any) => lines.push(`  [${t.status.toUpperCase()}] #${t.serial_id} ${t.content.slice(0, 100)}`));
        } else {
          lines.push("  (nothing active or in planning)");
        }

        const actions: string[] = [];
        for (const t of actionRes.data || []) {
          const items = (t as any).metadata?.action_items;
          if (Array.isArray(items)) items.forEach((i: string) => actions.push(`  - ${i} (from #${(t as any).serial_id})`));
        }
        if (actions.length) {
          lines.push("\n### Open Action Items (last 24h)");
          actions.slice(0, 8).forEach(a => lines.push(a));
          if (actions.length > 8) lines.push(`  … and ${actions.length - 8} more`);
        }

        if (topEntityLabel) lines.push(`\n### Recent Entity Focus\n  ${topEntityLabel}`);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // Tool 16: List Action Items — surface all extracted action items from thought metadata
  server.registerTool(
    "list_action_items",
    {
      title: "List Action Items",
      description: "Surface all action items automatically extracted from thought metadata. These are pulled from every capture — meetings, transcripts, notes. Use this to see what tasks and follow-ups have accumulated across your brain without having to remember to check.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        classification: z.enum(["work", "personal"]).optional().describe("Filter by work or personal context"),
        since_hours: z.number().optional().default(168).describe("How many hours back to look (default 168 = 1 week)"),
        limit: z.number().optional().default(30),
      },
    },
    async ({ classification, since_hours, limit }) => {
      try {
        const since = new Date(Date.now() - since_hours * 60 * 60 * 1000).toISOString();

        let q = supabase
          .from("thoughts")
          .select("serial_id, content, metadata, source_type, created_at")
          .gte("created_at", since)
          .not("metadata->action_items", "is", null)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (classification) q = q.filter("metadata->>classification", "eq", classification);

        const { data, error } = await q;
        if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };

        const withActions = (data || []).filter((t: any) =>
          Array.isArray(t.metadata?.action_items) && t.metadata.action_items.length > 0
        );

        if (!withActions.length) {
          return { content: [{ type: "text" as const, text: `No action items found in the last ${since_hours}h.` }] };
        }

        const lines: string[] = [`## Action Items — last ${since_hours}h${classification ? ` [${classification.toUpperCase()}]` : ""}\n`];
        withActions.forEach((t: any) => {
          const label = t.metadata?.classification ? `[${t.metadata.classification.toUpperCase()}] ` : "";
          const src = t.source_type ? ` (${t.source_type})` : "";
          lines.push(`**#${t.serial_id}** ${label}${t.created_at.slice(0, 10)}${src}`);
          lines.push(`  > ${t.content.slice(0, 80)}…`);
          t.metadata.action_items.forEach((item: string) => lines.push(`  - [ ] ${item}`));
          lines.push("");
        });

        const total = withActions.reduce((n: number, t: any) => n + t.metadata.action_items.length, 0);
        lines.push(`_${total} action items from ${withActions.length} thoughts_`);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  return server;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

const app = new Hono();

// CORS preflight
app.options("*", (c) => c.text("ok", 200, corsHeaders));

// OAuth discovery routes — mcp-remote probes these before falling back to key auth.
// Must be registered before app.all("*") so they return 404 (not 401).
app.get("/.well-known/oauth-authorization-server", (c) =>
  c.json({ error: "not_supported" }, 404, corsHeaders)
);
app.post("/oauth/register", (c) =>
  c.json({ error: "not_supported" }, 404, corsHeaders)
);

app.all("*", async (c) => {
  // 1. Auth check
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401, corsHeaders);
  }

  // 2. GET: Health Check or SSE Initiation
  if (c.req.method === "GET") {
    if (c.req.header("accept")?.includes("text/event-stream")) {
      const server = createServer();
      const transport = new StreamableHTTPTransport();
      await server.connect(transport);
      return transport.handleRequest(c);
    }
    return c.json({
      status: "ok",
      name: "open-brain",
      version: "1.4.0",
      capabilities: { tools: true, resources: false, prompts: false }
    }, 200, corsHeaders);
  }

  // 3. MCP Request Handling
  const headers = new Headers(c.req.raw.headers);
  const currentAccept = headers.get("accept") || "";

  if (!currentAccept.includes("application/json") || !currentAccept.includes("text/event-stream")) {
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore - Duplex is required for streaming bodies in Deno
      duplex: "half",
    });
    const newContext = { ...c, req: { ...c.req, raw: patched } };
    const server = createServer();
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    return transport.handleRequest(newContext as any);
  }

  const server = createServer();
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
