/**
 * Applaud → Open Brain webhook receiver.
 *
 * For each transcript_ready event:
 *  1. Skip if no ---ENTRY--- blocks (not our custom template)
 *  2. Skip if this recording ID was already processed
 *  3. For each entry, search the brain for similar existing thoughts
 *  4. Ask Ollama: SKIP | NEW | UPDATE:<serial_id>
 *  5. Act accordingly — update merges old + new via Ollama synthesis
 *
 * Run alongside the brain worker:
 *   node --env-file=.env scripts/plaud-webhook.js
 *
 * Applaud webhook URL: http://127.0.0.1:4001/webhook
 */

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PLAUD_WEBHOOK_PORT || 4001);
const SUPABASE_URL = process.env.SUPABASE_URL;
const BRAIN_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const OLLAMA_BASE = (process.env.OLLAMA_URL || "http://localhost:11434/api").replace(/\/+$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:30b";

const API_BASE = `${SUPABASE_URL}/functions/v1/rest-api`;

// Local file to track processed recording IDs — avoids re-ingesting on Applaud restart
const STATE_FILE = path.join(__dirname, ".plaud-processed.json");

if (!SUPABASE_URL || !BRAIN_KEY) {
  console.error("[plaud-webhook] Missing SUPABASE_URL or SUPABASE_KEY in environment.");
  process.exit(1);
}

// --- State (processed recording IDs) ---

function loadProcessed() {
  try {
    return new Set(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
  } catch {
    return new Set();
  }
}

function saveProcessed(set) {
  fs.writeFileSync(STATE_FILE, JSON.stringify([...set]), "utf8");
}

const processed = loadProcessed();

// --- HTTP helpers ---

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_BASE}${path}`);
    const payload = body ? JSON.stringify(body) : null;
    const isHttps = url.protocol === "https:";
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        "Content-Type": "application/json",
        "x-brain-key": BRAIN_KEY,
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };
    const req = (isHttps ? https : http).request(options, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function ollamaGenerate(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false });
    const url = new URL(`${OLLAMA_BASE}/generate`);
    const isHttps = url.protocol === "https:";
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = (isHttps ? https : http).request(options, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.response?.trim() ?? "");
        } catch { reject(new Error("Ollama response parse failed")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// --- Brain operations ---

async function searchThoughts(query) {
  const encoded = encodeURIComponent(query.slice(0, 500));
  const res = await apiCall("GET", `/search?q=${encoded}&limit=5`);
  return res.body?.results ?? [];
}

async function getThought(id) {
  const res = await apiCall("GET", `/thought/${id}`);
  return res.body;
}

async function capturePending(content, decision, updateTargetId, originalContent, type, classification) {
  const body = { content, source_type: "plaud", ollama_decision: decision };
  if (updateTargetId != null) body.update_target_id = updateTargetId;
  if (originalContent != null) body.original_content = originalContent;
  if (type) body.type = type;
  if (classification) body.classification = classification;
  return apiCall("POST", "/capture-pending", body);
}

// --- Ollama decisions ---

async function decideAction(newEntry, similarThoughts) {
  if (similarThoughts.length === 0) return "NEW";

  const candidatesSummary = similarThoughts
    .slice(0, 3)
    .map((t, i) => `[${i + 1}] ID:${t.id} (similarity: ${t.similarity != null ? t.similarity.toFixed(2) : "n/a"})\n${String(t.content).slice(0, 400)}`)
    .join("\n\n");

  const prompt = `/no_think
You are deciding how to handle a new knowledge entry being added to a personal brain system.

NEW ENTRY:
${newEntry.slice(0, 600)}

SIMILAR EXISTING THOUGHTS:
${candidatesSummary}

Respond with EXACTLY ONE of these options on a single line — nothing else:
- SKIP  (the new entry is essentially a duplicate — same information, no new value)
- UPDATE:<id>  (the new entry updates or refines one specific existing thought — replace its ID number, e.g. UPDATE:42)
- NEW  (this is genuinely new information that should be captured as its own thought)

Your decision:`;

  const response = await ollamaGenerate(prompt);
  const line = response.split("\n")[0]?.trim() ?? "NEW";

  if (line === "SKIP") return "SKIP";
  if (line === "NEW") return "NEW";
  const updateMatch = line.match(/^UPDATE:(\d+)$/i);
  if (updateMatch) return `UPDATE:${updateMatch[1]}`;

  console.log(`[plaud-webhook] Unexpected Ollama decision "${line}" — defaulting to NEW`);
  return "NEW";
}

async function synthesizeUpdate(existingContent, newContent) {
  const prompt = `/no_think
Merge these two related thoughts into a single updated thought for a personal knowledge base.
Preserve all important information from both. Write in the same direct, factual style.
Target length: 150–250 words.

EXISTING THOUGHT:
${existingContent.slice(0, 800)}

NEW INFORMATION:
${newContent.slice(0, 600)}

Merged thought:`;

  return ollamaGenerate(prompt);
}

// --- Entry parsing ---

function parseEntries(summaryMarkdown) {
  if (!summaryMarkdown) return [];

  const blocks = summaryMarkdown.split("---ENTRY---");
  if (blocks.length < 2) return []; // Not our template — skip entirely

  const entries = [];
  for (const block of blocks.slice(1)) {
    const endIdx = block.indexOf("---END---");
    const entryText = (endIdx >= 0 ? block.slice(0, endIdx) : block).trim();
    if (!entryText) continue;

    const lines = entryText.split("\n");
    let bodyStart = -1;
    let actionsStart = -1;
    let entryType = null;
    let entryClassification = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.startsWith("TYPE:") && bodyStart === -1) {
        const val = line.slice(5).trim().toLowerCase();
        if (val) entryType = val;
      }
      if (line.startsWith("CONTEXT:") && bodyStart === -1) {
        const val = line.slice(8).trim().toLowerCase();
        if (val === "work" || val === "personal") entryClassification = val;
        bodyStart = i + 1;
      }
      if (line.startsWith("ACTIONS:")) { actionsStart = i; break; }
    }

    if (bodyStart < 0) continue;

    const bodyLines = lines.slice(bodyStart, actionsStart >= 0 ? actionsStart : undefined);
    const body = bodyLines.join("\n").trim();
    if (!body) continue;

    const actions = [];
    if (actionsStart >= 0) {
      for (const line of lines.slice(actionsStart + 1)) {
        const t = (line ?? "").trim();
        if (t.startsWith("-")) {
          const text = t.slice(1).trim();
          if (text) actions.push(text);
        }
      }
    }

    let content = body;
    if (actions.length > 0) {
      content += "\n\nAction items:\n" + actions.map((a) => `- ${a}`).join("\n");
    }

    entries.push({ content, type: entryType, classification: entryClassification });
  }

  return entries;
}

// --- Main processing ---

async function processRecording(payload) {
  const recordingId = payload.recording?.id;
  const filename = payload.recording?.filename ?? "unknown";

  if (recordingId && processed.has(recordingId)) {
    console.log(`[plaud-webhook] Already processed: ${filename} — skipping`);
    return;
  }

  const summaryMarkdown = payload.content?.summary_markdown;
  if (!summaryMarkdown) {
    console.log(`[plaud-webhook] No summary for: ${filename}`);
    return;
  }

  const entries = parseEntries(summaryMarkdown);
  if (entries.length === 0) {
    console.log(`[plaud-webhook] No ENTRY blocks in: ${filename} — not our template, skipping`);
    return;
  }

  console.log(`[plaud-webhook] Processing ${entries.length} entries from: ${filename}`);

  for (let i = 0; i < entries.length; i++) {
    const { content: entry, type: entryType, classification: entryClassification } = entries[i];
    const label = `entry ${i + 1}/${entries.length}`;

    try {
      const similar = await searchThoughts(entry);
      const decision = await decideAction(entry, similar);

      if (decision === "SKIP") {
        console.log(`[plaud-webhook] ${label}: SKIP (duplicate detected)`);

      } else if (decision.startsWith("UPDATE:")) {
        const targetId = parseInt(decision.slice(7), 10);
        const existing = await getThought(targetId);
        if (!existing?.content) {
          // Target not found — fall back to NEW pending
          console.log(`[plaud-webhook] ${label}: UPDATE:${targetId} — thought not found, queuing as NEW pending`);
          const r = await capturePending(entry, "NEW", null, null, entryType, entryClassification);
          console.log(`[plaud-webhook] ${label}: NEW (fallback) — ${r.body?.action ?? r.status}`);
        } else {
          // Synthesize now while Ollama is available; store merged content in pending thought
          // The original is untouched until the user approves in the Review panel
          const merged = await synthesizeUpdate(existing.content, entry);
          const r = await capturePending(merged, "UPDATE", targetId, existing.content, entryType, entryClassification);
          console.log(`[plaud-webhook] ${label}: UPDATE:${targetId} pending review — ${r.body?.action ?? r.status}`);
        }

      } else {
        const r = await capturePending(entry, "NEW", null, null, entryType, entryClassification);
        console.log(`[plaud-webhook] ${label}: NEW pending review — ${r.body?.action ?? r.status}`);
      }
    } catch (err) {
      console.error(`[plaud-webhook] ${label}: error —`, err.message);
    }
  }

  if (recordingId) {
    processed.add(recordingId);
    saveProcessed(processed);
  }
}

// --- HTTP server ---

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", processed: processed.size }));
    return;
  }

  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404);
    res.end();
    return;
  }

  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", async () => {
    // Respond to Applaud immediately — processing is async
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: true }));

    let payload;
    try { payload = JSON.parse(raw); }
    catch { console.error("[plaud-webhook] Failed to parse payload"); return; }

    if (payload.event !== "transcript_ready") {
      console.log(`[plaud-webhook] Ignoring event: ${payload.event}`);
      return;
    }

    processRecording(payload).catch((err) =>
      console.error("[plaud-webhook] processRecording error:", err.message)
    );
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[plaud-webhook] Listening on http://127.0.0.1:${PORT}/webhook`);
  console.log(`[plaud-webhook] Ollama model: ${OLLAMA_MODEL}`);
  console.log(`[plaud-webhook] Processed recordings loaded: ${processed.size}`);
});
