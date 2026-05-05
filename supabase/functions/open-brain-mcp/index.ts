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
    version: "1.3.0",
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
        "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea. Respects Work/Personal context. Returns source so you can see where each memory came from.",
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

        const results = filtered.map((t: any, i: number) => {
          const m = t.metadata || {};
          const label = m.classification ? `[${m.classification.toUpperCase()}] ` : "";
          const src = t.source_type ? ` (${t.source_type})` : "";
          const score = typeof t.similarity === "number" ? `\nSimilarity: ${(t.similarity * 100).toFixed(0)}%` : "\nMatch: text";
          return `${i + 1}. ${label}#${t.serial_id || t.id}${src}\n${t.content}${score}`;
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
      description: "Save a new thought to the brain. IMPORTANT: Each capture must be ONE atomic idea — aim for 300–500 words of rich context per thought. If you have a transcript, meeting notes, or multiple unrelated ideas, call this tool MULTIPLE TIMES, once per distinct idea. Do NOT save giant blocks of text covering multiple topics as a single thought — splitting them ensures 10x better search quality. You MUST declare your own client name in 'source' — use the actual name of the AI or tool calling this (e.g., 'claude', 'chatgpt', 'perplexity', 'copilot', 'n8n'). Never use another client's name.",
      inputSchema: {
        content: z.string().describe("One atomic thought — around 300–500 words of context. One topic only; use multiple captures for multiple ideas."),
        classification: z.enum(["work", "personal"]).optional().describe("Work or Personal context"),
        type: z.string().optional().describe("e.g. task, idea, reference"),
        source: z.string().optional().describe("REQUIRED: Your actual client name. If you are Claude, pass 'claude'. If ChatGPT, pass 'chatgpt'. If Perplexity, pass 'perplexity'. Use YOUR name — not any other tool's name."),
      },
    },
    async ({ content, classification, type, source }) => {
      try {
        const [embedding, extracted] = await Promise.all([getEmbedding(content), extractMetadata(content)]);

        const finalSource = source ? `mcp-${source}` : "mcp";
        const metadata = { ...extracted, source: finalSource, classification };

        const { data: upsertResult, error: upsertError } = await supabase.rpc("upsert_thought", {
          p_content: content.trim(),
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
      description: "Update content and optionally move context. Archives old version. Use the serial number shown in search results (e.g. '132'), not a UUID.",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        id: z.string().describe("UUID or Serial ID (as string)"),
        content: z.string(),
        classification: z.enum(["work", "personal"]).optional(),
      },
    },
    async ({ id, content, classification }) => {
      try {
        const filter = /^[0-9a-f]{8}-/.test(id) ? { id } : { serial_id: parseInt(id, 10) };
        const { data: current } = await supabase.from("thoughts").select("*").match(filter).single();
        if (!current) return { content: [{ type: "text", text: "Not found" }], isError: true };

        // Archive
        await supabase.from("thought_versions").insert({
          thought_id: current.id,
          version: current.version || 1,
          content: current.content,
          metadata: current.metadata,
        });

        const embedding = await getEmbedding(content);
        const metadata = { ...(current.metadata || {}), classification: classification || current.metadata?.classification };

        const updatePayload: Record<string, unknown> = {
          content,
          metadata,
          version: (current.version || 1) + 1,
          updated_at: new Date().toISOString()
        };
        if (embedding) updatePayload.embedding = embedding;

        const { error } = await supabase.from("thoughts").update(updatePayload).match(filter);

        if (error) return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
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
      description: "Save an AI-generated realization or reflection about a specific thought.",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        thought_id: z.string().describe("The ID of the thought to reflect on"),
        reflection: z.string().describe("The insight or realization to save"),
      },
    },
    async ({ thought_id, reflection }) => {
      const filter = /^[0-9a-f]{8}-/.test(thought_id) ? { id: thought_id } : { serial_id: parseInt(thought_id, 10) };
      const { data: thought } = await supabase.from("thoughts").select("id").match(filter).single();
      if (!thought) return { content: [{ type: "text", text: "Thought not found" }], isError: true };

      const { error } = await supabase.from("reflections").insert({
        thought_id: thought.id,
        content: reflection,
      });
      if (error) return { content: [{ type: "text", text: error.message }], isError: true };
      return { content: [{ type: "text", text: "Reflection saved." }] };
    }
  );

  // Tool 10: Fieldy Review — list recent Fieldy-captured memories for daily review
  server.registerTool(
    "fieldy_review",
    {
      title: "Fieldy Review",
      description: "Fetch recent memories captured by Fieldy (source: mcp-fieldy-auto or mcp-fieldy-pending) for daily review. Returns serial ID, content, classification, and timestamp so a reviewer can check for errors, wrong attribution, or missing context.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        since_hours: z.number().optional().default(24).describe("How many hours back to look (default 24)"),
        limit: z.number().optional().default(50),
      },
    },
    async ({ since_hours, limit }) => {
      try {
        const since = new Date(Date.now() - since_hours * 60 * 60 * 1000).toISOString();

        const { data, error } = await supabase
          .from("thoughts")
          .select("serial_id, content, metadata, source_type, created_at")
          .in("source_type", ["mcp-fieldy-auto", "mcp-fieldy-pending"])
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(limit);

        if (error) return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        if (!data?.length) return { content: [{ type: "text", text: `No Fieldy memories found in the last ${since_hours} hours.` }] };

        const results = data.map((t: any) => {
          const m = t.metadata || {};
          const label = m.classification ? `[${m.classification.toUpperCase()}] ` : "";
          const src = t.source_type === "mcp-fieldy-pending" ? " ⚠️ PENDING" : "";
          return `#${t.serial_id} ${label}(${t.created_at.split("T")[0]}) ${t.source_type}${src}\n${t.content}`;
        });

        return { content: [{ type: "text", text: `${data.length} Fieldy memories from the last ${since_hours}h:\n\n${results.join("\n\n")}` }] };
      } catch (err: unknown) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
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
      version: "1.3.0",
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
