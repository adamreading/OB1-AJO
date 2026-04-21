import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function getEmbedding(text: string): Promise<number[]> {
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
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
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
    throw new Error(`OpenRouter metadata extraction failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

function createServer(): McpServer {
  const server = new McpServer({
    name: "open-brain",
    version: "1.2.0",
  });

  // Tool 1: Semantic Search
  server.registerTool(
    "search_thoughts",
    {
      title: "Search Thoughts",
      description:
        "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
      inputSchema: {
        query: z.string().describe("What to search for"),
        limit: z.number().optional().default(10),
        threshold: z.number().optional().default(0.5),
      },
    },
    async ({ query, limit, threshold }) => {
      try {
        const qEmb = await getEmbedding(query);
        const { data, error } = await supabase.rpc("match_thoughts", {
          query_embedding: qEmb,
          match_threshold: threshold,
          match_count: limit,
          filter: {},
        });

        if (error) {
          return {
            content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
            isError: true,
          };
        }

        if (!data || data.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
          };
        }

        const results = data.map(
          (
            t: {
              id: string;
              content: string;
              metadata: Record<string, unknown>;
              similarity: number;
              created_at: string;
            },
            i: number
          ) => {
            const m = t.metadata || {};
            const parts = [
              `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
              `ID: ${t.id}`,
              `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
              `Type: ${m.type || "unknown"}`,
            ];
            if (Array.isArray(m.topics) && m.topics.length)
              parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
            if (Array.isArray(m.people) && m.people.length)
              parts.push(`People: ${(m.people as string[]).join(", ")}`);
            if (Array.isArray(m.action_items) && m.action_items.length)
              parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
            parts.push(`\n${t.content}`);
            return parts.join("\n");
          }
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${data.length} thought(s):\n\n${results.join("\n\n")}`,
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 2: List Recent
  server.registerTool(
    "list_thoughts",
    {
      title: "List Recent Thoughts",
      description:
        "List recently captured thoughts with optional filters by type, topic, person, or time range.",
      inputSchema: {
        limit: z.number().optional().default(10),
        type: z.string().optional().describe("Filter by type: observation, task, idea, reference, person_note"),
        topic: z.string().optional().describe("Filter by topic tag"),
        person: z.string().optional().describe("Filter by person mentioned"),
        days: z.number().optional().describe("Only thoughts from the last N days"),
      },
    },
    async ({ limit, type, topic, person, days }) => {
      try {
        let q = supabase
          .from("thoughts")
          .select("id, content, metadata, created_at")
          .order("created_at", { ascending: false })
          .limit(limit);

        if (type) q = q.contains("metadata", { type });
        if (topic) q = q.contains("metadata", { topics: [topic] });
        if (person) q = q.contains("metadata", { people: [person] });
        if (days) {
          const since = new Date();
          since.setDate(since.getDate() - days);
          q = q.gte("created_at", since.toISOString());
        }

        const { data, error } = await q;

        if (error) {
          return {
            content: [{ type: "text" as const, text: `Error: ${error.message}` }],
            isError: true,
          };
        }

        if (!data || !data.length) {
          return { content: [{ type: "text" as const, text: "No thoughts found." }] };
        }

        const results = data.map(
          (
            t: { id: string; content: string; metadata: Record<string, unknown>; created_at: string },
            i: number
          ) => {
            const m = t.metadata || {};
            const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
            return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ID: ${t.id}\n   ${t.content}`;
          }
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `${data.length} recent thought(s):\n\n${results.join("\n\n")}`,
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 3: Stats
  server.registerTool(
    "thought_stats",
    {
      title: "Thought Statistics",
      description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
      inputSchema: {},
    },
    async () => {
      try {
        const { count } = await supabase
          .from("thoughts")
          .select("*", { count: "exact", head: true });

        const { data } = await supabase
          .from("thoughts")
          .select("metadata, created_at")
          .order("created_at", { ascending: false });

        const types: Record<string, number> = {};
        const topics: Record<string, number> = {};
        const people: Record<string, number> = {};

        for (const r of data || []) {
          const m = (r.metadata || {}) as Record<string, unknown>;
          if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
          if (Array.isArray(m.topics))
            for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
          if (Array.isArray(m.people))
            for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
        }

        const sort = (o: Record<string, number>): [string, number][] =>
          Object.entries(o)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        const lines: string[] = [
          `Total thoughts: ${count}`,
          `Date range: ${
            data?.length
              ? new Date(data[data.length - 1].created_at).toLocaleDateString() +
                " → " +
                new Date(data[0].created_at).toLocaleDateString()
              : "N/A"
          }`,
          "",
          "Types:",
          ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
        ];

        if (Object.keys(topics).length) {
          lines.push("", "Top topics:");
          for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
        }

        if (Object.keys(people).length) {
          lines.push("", "People mentioned:");
          for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 4: Capture Thought (Version-aware with RPC deduplication)
  server.registerTool(
    "capture_thought",
    {
      title: "Capture Thought",
      description:
        "Save a new thought. Automatically extracts metadata and generates an embedding. Prevents duplicates using semantic fingerprinting.",
      inputSchema: {
        content: z.string().describe("The thought to capture"),
        type: z.string().optional().describe("Override auto-extracted type"),
        topics: z.array(z.string()).optional().describe("Override auto-extracted topics"),
      },
    },
    async ({ content, type, topics }) => {
      try {
        const [embedding, extracted] = await Promise.all([
          getEmbedding(content),
          extractMetadata(content),
        ]);

        const metadata = { ...extracted, source: "mcp" } as Record<string, unknown>;
        if (type) metadata.type = type;
        if (topics) metadata.topics = topics;

        const { data: upsertResult, error: upsertError } = await supabase.rpc("upsert_thought", {
          p_content: content,
          p_payload: { metadata },
        });

        if (upsertError) {
          return {
            content: [{ type: "text" as const, text: `Failed to capture: ${upsertError.message}` }],
            isError: true,
          };
        }

        const thoughtId = upsertResult?.id;
        const { error: embError } = await supabase
          .from("thoughts")
          .update({ embedding })
          .eq("id", thoughtId);

        if (embError) {
          return {
            content: [{ type: "text" as const, text: `Failed to save embedding: ${embError.message}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Captured as ${metadata.type || "thought"} (ID: ${thoughtId})` }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 5: Update Thought (with archiving)
  server.registerTool(
    "update_thought",
    {
      title: "Update Thought",
      description:
        "Update an existing thought's content. Archives the previous version before updating.",
      inputSchema: {
        id: z.string().describe("UUID of the thought to update"),
        content: z.string().describe("New content for the thought"),
      },
    },
    async ({ id, content }) => {
      try {
        const { data: current, error: fetchErr } = await supabase
          .from("thoughts")
          .select("id, content, embedding, metadata, version, created_at")
          .eq("id", id)
          .single();

        if (fetchErr || !current) {
          return {
            content: [{ type: "text" as const, text: `Thought not found: ${fetchErr?.message || "no matching ID"}` }],
            isError: true,
          };
        }

        // Archive version
        const { error: archiveErr } = await supabase.from("thought_versions").insert({
          thought_id: current.id,
          version: current.version,
          content: current.content,
          embedding: current.embedding,
          metadata: current.metadata,
          created_at: current.created_at,
        });

        if (archiveErr) {
          return {
            content: [{ type: "text" as const, text: `Failed to archive version: ${archiveErr.message}` }],
            isError: true,
          };
        }

        const [embedding, extracted] = await Promise.all([
          getEmbedding(content),
          extractMetadata(content),
        ]);

        const newVersion = (current.version || 1) + 1;
        const { error: updateErr } = await supabase
          .from("thoughts")
          .update({
            content,
            embedding,
            metadata: { ...extracted, source: "mcp-update" },
            version: newVersion,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);

        if (updateErr) {
          return {
            content: [{ type: "text" as const, text: `Failed to update: ${updateErr.message}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Updated to version ${newVersion}. Previous version archived.` }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 6: Delete Thought
  server.registerTool(
    "delete_thought",
    {
      title: "Delete Thought",
      description: "Permanently delete a thought.",
      inputSchema: {
        id: z.string().describe("UUID of the thought to delete"),
      },
    },
    async ({ id }) => {
      try {
        const { error: deleteErr } = await supabase
          .from("thoughts")
          .delete()
          .eq("id", id);

        if (deleteErr) {
          return {
            content: [{ type: "text" as const, text: `Failed to delete: ${deleteErr.message}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Deleted thought ${id}` }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id",
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
      version: "1.2.0",
      capabilities: { tools: true, resources: false, prompts: false }
    }, 200, corsHeaders);
  }

  // 3. POST and Others: Pass directly to transport
  // Note: We only patch the Accept header if it's completely missing
  if (!c.req.header("accept")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore
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
