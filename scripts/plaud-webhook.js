/**
 * Applaud → Open Brain webhook receiver (curator edition).
 *
 * For each transcript_ready event whose summary_markdown contains
 * ---ENTRY--- blocks (i.e. the user applied the "Open Brain Ready Thought
 * Extractor" template in Plaud):
 *
 *   1. Skip the bundle entirely if no ENTRY blocks are present.
 *   2. Skip if recording.id is already in processor_prompt/cursor.json.
 *   3. Apply entity_corrections.json to the raw markdown before parsing
 *      (lowercase whole-word; flag_only matches tracked for later open-q).
 *   4. Parse each ENTRY block: TYPE / CONTEXT / ENTITIES / SEARCH_HINTS /
 *      body / ACTIONS.
 *   5. For each entry: ask OB (REST /wiki-pages, /search) what already
 *      exists for these entities / hints. Hand Qwen3 the entry + candidate
 *      thoughts and let it decide IGNORE / UPDATE / CAPTURE.
 *   6. Write via REST /capture-pending with the right ollama_decision so
 *      Adam triages in the dashboard /review queue.
 *   7. After processing all entries, scan processor_prompt/OPEN_QUESTIONS.md
 *      for Status: answered entries and apply each via /capture-pending
 *      UPDATE, then mark the entry resolved.
 *   8. Append a run_log entry to processor_prompt/cursor.json.
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
const { createClient } = require("@supabase/supabase-js");

const PORT = Number(process.env.PLAUD_WEBHOOK_PORT || 4001);
const SUPABASE_URL = process.env.SUPABASE_URL;
const BRAIN_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, BRAIN_KEY);
const OLLAMA_BASE = (process.env.OLLAMA_URL || "http://localhost:11434/api").replace(/\/+$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:30b";

const API_BASE = `${SUPABASE_URL}/functions/v1/rest-api`;

const REPO_ROOT = path.resolve(__dirname, "..");
const PROCESSOR_DIR = path.join(REPO_ROOT, "processor_prompt");
const CURSOR_PATH = path.join(PROCESSOR_DIR, "cursor.json");
const CORRECTIONS_PATH = path.join(PROCESSOR_DIR, "entity_corrections.json");
const QUESTIONS_PATH = path.join(PROCESSOR_DIR, "OPEN_QUESTIONS.md");
const CURATOR_PROMPT_PATH = path.join(__dirname, "plaud-curator-prompt.md");

if (!SUPABASE_URL || !BRAIN_KEY) {
  console.error("[plaud-webhook] Missing SUPABASE_URL or SUPABASE_KEY in environment.");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────
// State files
// ─────────────────────────────────────────────────────────────────────

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return fallback; }
}

function writeJsonAtomic(filePath, obj) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function readCursor() {
  return readJson(CURSOR_PATH, {
    _meta: { purpose: "Plaud→OB processor state", schema_version: 2 },
    processed_file_ids: [],
    skip_rules: { min_duration_ms: 60000, title_skip_keywords: [], required_blessing_tab_name: "Open Brain Ready Thought Extractor" },
    run_log: [],
  });
}

function persistCursor(cursor) { writeJsonAtomic(CURSOR_PATH, cursor); }

// Hot-reload corrections + curator prompt between requests
let correctionsCache = null;
let correctionsMtime = 0;
function loadCorrections() {
  try {
    const stat = fs.statSync(CORRECTIONS_PATH);
    if (stat.mtimeMs !== correctionsMtime || correctionsCache == null) {
      correctionsCache = JSON.parse(fs.readFileSync(CORRECTIONS_PATH, "utf8")).corrections || [];
      correctionsMtime = stat.mtimeMs;
    }
  } catch { correctionsCache = []; }
  return correctionsCache;
}

let curatorPromptCache = null;
let curatorPromptMtime = 0;
function loadCuratorPrompt() {
  try {
    const stat = fs.statSync(CURATOR_PROMPT_PATH);
    if (stat.mtimeMs !== curatorPromptMtime || curatorPromptCache == null) {
      const raw = fs.readFileSync(CURATOR_PROMPT_PATH, "utf8");
      // Extract the fenced ``` block — the prompt body lives inside it
      const fence = raw.match(/```\s*\n([\s\S]*?)\n```/);
      curatorPromptCache = fence ? fence[1] : raw;
      curatorPromptMtime = stat.mtimeMs;
    }
  } catch (err) {
    console.error("[plaud-webhook] Failed to load curator prompt:", err.message);
    curatorPromptCache = null;
  }
  return curatorPromptCache;
}

// ─────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────

function apiCall(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_BASE}${urlPath}`);
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
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = (isHttps ? https : http).request(options, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { const parsed = JSON.parse(data); resolve(parsed.response?.trim() ?? ""); }
        catch { reject(new Error("Ollama response parse failed")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────
// Brain operations
// ─────────────────────────────────────────────────────────────────────

async function searchThoughts(query, classification) {
  const params = new URLSearchParams({ q: query.slice(0, 500), limit: "10" });
  if (classification) params.set("classification", classification);
  const res = await apiCall("GET", `/search?${params.toString()}`);
  return res.body?.results ?? [];
}

async function lookupWikiPage(slug) {
  const res = await apiCall("GET", `/wiki-pages/${encodeURIComponent(slug)}`);
  if (res.status >= 200 && res.status < 300 && res.body && !res.body.error) return res.body;
  return null;
}

async function getThought(id) {
  const res = await apiCall("GET", `/thought/${id}`);
  return res.body;
}

async function capturePending({ content, decision, updateTargetId, originalContent, type, classification, actionItems, meetingId, meetingTitle, meetingPosition, meetingTotal }) {
  const body = { content, source_type: "plaud", ollama_decision: decision };
  if (updateTargetId != null) body.update_target_id = updateTargetId;
  if (originalContent != null) body.original_content = originalContent;
  if (type) body.type = type;
  if (classification) body.classification = classification;
  if (Array.isArray(actionItems) && actionItems.length > 0) body.action_items = actionItems;
  if (meetingId) body.meeting_id = meetingId;
  if (meetingTitle) body.meeting_title = meetingTitle;
  if (Number.isFinite(meetingPosition)) body.meeting_position = meetingPosition;
  if (Number.isFinite(meetingTotal)) body.meeting_total = meetingTotal;
  return apiCall("POST", "/capture-pending", body);
}

// Find all in-flight pending UPDATEs that target any of the candidate
// serial_ids. Returns a Map<target_serial_id, { serial_id, uuid, content,
// amend_count }>. Used by the curator to amend instead of duplicate-insert
// when a previous Plaud entry already proposed an update to the same target.
async function findPendingUpdatesForTargets(targetSerialIds) {
  const map = new Map();
  if (!targetSerialIds.length) return map;
  const ids = targetSerialIds.map(String);
  const { data, error } = await supabase
    .from("thoughts")
    .select("id, serial_id, content, metadata")
    .eq("source_type", "plaud")
    .filter("metadata->>review_status", "eq", "pending_review")
    .filter("metadata->>ollama_decision", "eq", "UPDATE")
    .filter("metadata->>update_target_id", "in", `(${ids.join(",")})`);
  if (error) {
    console.error("[plaud-webhook] findPendingUpdatesForTargets failed:", error.message);
    return map;
  }
  for (const row of data ?? []) {
    const target = Number(row.metadata?.update_target_id);
    if (!Number.isFinite(target)) continue;
    map.set(target, {
      uuid: row.id,
      serial_id: row.serial_id,
      content: row.content,
      amend_count: Number(row.metadata?.amend_count ?? 0),
    });
  }
  return map;
}

// Either UPDATE an existing pending UPDATE row for this target, OR insert
// a fresh pending row via /capture-pending. Single entry point for both
// the first proposal and the Nth amendment within a session — keeps the
// review queue at one row per target instead of N near-duplicates.
async function writeOrAmendPendingUpdate({
  targetSerialId,
  newContent,
  originalContent,
  type,
  classification,
  actionItems,
  existingPending,
  meetingId,
  meetingTitle,
  meetingPosition,
  meetingTotal,
}) {
  if (existingPending) {
    const nextAmendCount = (existingPending.amend_count ?? 0) + 1;
    // Read latest metadata so we don't drop unrelated fields.
    const { data: cur } = await supabase
      .from("thoughts")
      .select("metadata")
      .eq("id", existingPending.uuid)
      .single();
    const meta = { ...(cur?.metadata ?? {}) };
    meta.amend_count = nextAmendCount;
    meta.last_amended_at = new Date().toISOString();
    if (Array.isArray(actionItems) && actionItems.length > 0) {
      const prior = Array.isArray(meta.action_items) ? meta.action_items : [];
      // Dedupe by string equality
      const merged = Array.from(new Set([...prior, ...actionItems]));
      meta.action_items = merged;
    }
    const updatePayload = {
      content: newContent,
      metadata: meta,
      updated_at: new Date().toISOString(),
    };
    if (type) updatePayload.type = type;
    if (classification) updatePayload.classification = classification;
    const { data, error } = await supabase
      .from("thoughts")
      .update(updatePayload)
      .eq("id", existingPending.uuid)
      .select("serial_id")
      .single();
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true, amended: true, amend_count: nextAmendCount, serial_id: data.serial_id };
  }

  const r = await capturePending({
    content: newContent,
    decision: "UPDATE",
    updateTargetId: targetSerialId,
    originalContent,
    type,
    classification,
    actionItems,
    meetingId,
    meetingTitle,
    meetingPosition,
    meetingTotal,
  });
  if (r.status >= 200 && r.status < 300) {
    return { ok: true, amended: false, amend_count: 0, serial_id: r.body?.thought_id, status: r.status };
  }
  return { ok: false, error: `capture-pending status ${r.status}` };
}

// Recovery operation for the pre-fix duplicate-pending state. Pull all
// pending UPDATE rows for a target, merge their bodies via Qwen3 into a
// single canonical merged_content, write that to the oldest row, delete
// the rest. Returns a small summary.
async function consolidatePendingUpdatesForTarget(targetSerialId) {
  if (!Number.isFinite(targetSerialId)) return { ok: false, error: "invalid target serial_id" };
  const { data: rows, error } = await supabase
    .from("thoughts")
    .select("id, serial_id, content, metadata, created_at, type, classification")
    .eq("source_type", "plaud")
    .filter("metadata->>review_status", "eq", "pending_review")
    .filter("metadata->>ollama_decision", "eq", "UPDATE")
    .filter("metadata->>update_target_id", "eq", String(targetSerialId))
    .order("created_at", { ascending: true });
  if (error) return { ok: false, error: error.message };
  if (!rows || rows.length === 0) return { ok: true, found: 0, note: "no pending updates for this target" };
  if (rows.length === 1) return { ok: true, found: 1, note: "single pending row already — nothing to consolidate" };

  // Pull the target's original content for context
  const { data: target } = await supabase
    .from("thoughts")
    .select("content")
    .eq("serial_id", targetSerialId)
    .maybeSingle();
  const originalBody = String(target?.content ?? rows[0].metadata?.original_content ?? "");

  // Ask Qwen3 to merge the N pending bodies into one canonical body that
  // supersedes all of them. Lay them out in chronological order so the
  // model knows which dated sections came from which proposal.
  const proposals = rows
    .map((r, i) => `--- PROPOSAL ${i + 1} (pending #${r.serial_id}, created ${String(r.created_at).slice(0, 19)}) ---\n${String(r.content ?? "").trim()}`)
    .join("\n\n");

  const prompt = `/no_think
You are merging ${rows.length} parallel proposed updates to the SAME target thought into one canonical merged body. Each proposal was produced independently by the same curator over a short window and each proposal already contains the target's original body PLUS one or more dated sections this proposal wants to add.

ORIGINAL TARGET BODY (current state of thought #${targetSerialId}):
${originalBody.slice(0, 2000)}

PROPOSED UPDATES (chronological):
${proposals}

Produce a single canonical merged body that supersedes ALL the proposals. Rules:
- Start with the original target body intact (the lead-in paragraph(s) before any dated section).
- Then list dated sections in chronological order (oldest first), one per unique date.
- For each date, consolidate the content from every proposal that touched that date — deduplicate, keep all distinct facts, preserve numbers/names/decisions verbatim.
- Do not invent content. Do not drop content that appears in any proposal.
- Output ONLY the merged body text, nothing else — no preamble, no JSON, no fences.`;

  const merged = (await ollamaGenerate(prompt)).trim();
  if (!merged || merged.length < 100) {
    return { ok: false, error: "merge LLM returned empty or too-short content" };
  }

  // Keep the oldest row, update its content + bump amend_count, delete the rest
  const survivor = rows[0];
  const toDelete = rows.slice(1).map((r) => r.id);
  const survivorMeta = { ...(survivor.metadata ?? {}) };
  survivorMeta.amend_count = (Number(survivorMeta.amend_count) || 0) + rows.length - 1;
  survivorMeta.last_amended_at = new Date().toISOString();
  survivorMeta.consolidated_from = rows.slice(1).map((r) => r.serial_id);

  const { error: updErr } = await supabase
    .from("thoughts")
    .update({ content: merged, metadata: survivorMeta, updated_at: new Date().toISOString() })
    .eq("id", survivor.id);
  if (updErr) return { ok: false, error: `survivor update failed: ${updErr.message}` };

  if (toDelete.length > 0) {
    const { error: delErr } = await supabase.from("thoughts").delete().in("id", toDelete);
    if (delErr) return { ok: false, error: `delete duplicates failed: ${delErr.message}` };
  }

  return {
    ok: true,
    found: rows.length,
    consolidated_into: survivor.serial_id,
    deleted: rows.slice(1).map((r) => r.serial_id),
    merged_length: merged.length,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Slug derivation (matches wiki convention used by generate-wiki.mjs)
// ─────────────────────────────────────────────────────────────────────

function slugify(name, entityType) {
  const base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${entityType}-${base}`;
}

// We don't know the entity_type up front for ENTITIES from Plaud, so try
// the common types in priority order. First slug that resolves wins.
const ENTITY_TYPE_PROBE_ORDER = ["person", "organization", "project", "tool", "topic", "place"];

async function findWikiAnchor(name) {
  for (const t of ENTITY_TYPE_PROBE_ORDER) {
    const slug = slugify(name, t);
    const page = await lookupWikiPage(slug);
    if (page) return { slug, type: t, title: page.title || name };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Entity corrections
// ─────────────────────────────────────────────────────────────────────

function applyCorrections(text) {
  const corrections = loadCorrections();
  let out = text;
  const flagsTriggered = [];
  for (const rule of corrections) {
    const wrong = rule.wrong;
    if (!wrong) continue;
    const re = rule.regex
      ? new RegExp(wrong, "gi")
      : new RegExp(`\\b${wrong.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    if (!re.test(out)) continue;
    if (rule.flag_only) {
      flagsTriggered.push({ wrong, canonical: rule.canonical, context: rule.context });
      continue;
    }
    out = out.replace(re, rule.canonical);
  }
  return { text: out, flagsTriggered };
}

// ─────────────────────────────────────────────────────────────────────
// MEETING header parser — the Plaud template emits one line per
// recording of the shape:
//   MEETING: YYYY-MM-DD | participant1, participant2 | topic in <=60 chars
// The date or participants block can be empty; the line is optional.
// Returns { date, participants, topic } with whatever parts were present.
// ─────────────────────────────────────────────────────────────────────

function parseMeetingHeader(summaryMarkdown) {
  if (!summaryMarkdown) return null;
  // Look only in the prefix BEFORE the first ENTRY block.
  const cutoff = summaryMarkdown.indexOf("---ENTRY---");
  const region = cutoff >= 0 ? summaryMarkdown.slice(0, cutoff) : summaryMarkdown.slice(0, 1000);
  const match = region.match(/^MEETING:\s*(.+)$/im);
  if (!match) return null;
  const parts = match[1].split("|").map((s) => s.trim());
  const [datePart, peoplePart, topicPart] = [parts[0] || "", parts[1] || "", parts[2] || ""];
  const date = /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : null;
  const participants = peoplePart ? peoplePart.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const topic = topicPart ? topicPart.slice(0, 80) : null;
  if (!date && participants.length === 0 && !topic) return null;
  return { date, participants, topic };
}

// ─────────────────────────────────────────────────────────────────────
// ENTRY block parser — extended with ENTITIES + SEARCH_HINTS
// ─────────────────────────────────────────────────────────────────────

function parseEntries(summaryMarkdown) {
  if (!summaryMarkdown) return [];
  const blocks = summaryMarkdown.split("---ENTRY---");
  if (blocks.length < 2) return []; // Not our template
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
    let entryEntities = [];
    let entrySearchHints = [];
    let sawHeaderLine = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.startsWith("TYPE:")) {
        const val = line.slice(5).trim().toLowerCase();
        if (val) entryType = val;
        sawHeaderLine = true;
        continue;
      }
      if (line.startsWith("CONTEXT:")) {
        const val = line.slice(8).trim().toLowerCase();
        if (val === "work" || val === "personal") entryClassification = val;
        sawHeaderLine = true;
        continue;
      }
      if (line.startsWith("ENTITIES:")) {
        const val = line.slice(9).trim();
        if (val) entryEntities = val.split(",").map((s) => s.trim()).filter(Boolean);
        sawHeaderLine = true;
        continue;
      }
      if (line.startsWith("SEARCH_HINTS:")) {
        const val = line.slice(13).trim();
        if (val) entrySearchHints = val.split("|").map((s) => s.trim()).filter(Boolean);
        sawHeaderLine = true;
        continue;
      }
      if (line.startsWith("ACTIONS:")) {
        actionsStart = i;
        break;
      }
      // First non-header non-blank line marks the start of the body
      if (sawHeaderLine && bodyStart === -1 && line.trim().length > 0) {
        bodyStart = i;
      }
    }

    if (bodyStart < 0) continue;

    const bodyLines = lines.slice(bodyStart, actionsStart >= 0 ? actionsStart : undefined);
    // Strip Plaud's template-instruction leak. GPT-5.5 sometimes emits the
    // full "[Body: 150–250 words. Write as a direct, factual capture. ... No padding.]"
    // placeholder block verbatim before the actual prose. Other times it just
    // leaves the "Body:" label. Strip both shapes; anything else is left alone.
    const body = bodyLines.join("\n").trim()
      .replace(/^\s*\[Body:[\s\S]*?No padding\.\]\s*\n+/i, "")
      .replace(/^body:\s*/i, "");
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

    entries.push({
      content: body,
      action_items: actions,
      type: entryType,
      classification: entryClassification,
      entities: entryEntities,
      search_hints: entrySearchHints,
    });
  }
  return entries;
}

// ─────────────────────────────────────────────────────────────────────
// Curator decision
// ─────────────────────────────────────────────────────────────────────

function formatCandidates(candidates) {
  if (!candidates.length) return "(none — search returned nothing for this entry)";
  return candidates.map((c, i) =>
    `[${i + 1}] #${c.id} · ${c.classification ?? "?"} · ${(c.created_at || "").slice(0, 10)} · sim ${c.similarity?.toFixed?.(2) ?? "n/a"}
${String(c.content ?? "").slice(0, 500)}`
  ).join("\n\n");
}

function formatWikiAnchors(anchors) {
  if (!anchors.length) return "(none — none of the named entities have wiki pages yet)";
  return anchors.map((a) => `- ${a.title}  (slug: ${a.slug}, type: ${a.type})`).join("\n");
}

function formatPendingUpdates(candidates, pendingByTarget) {
  const blocks = [];
  for (const c of candidates) {
    const p = pendingByTarget.get(c.id);
    if (!p) continue;
    blocks.push(
      `→ Target #${c.id} already has a PENDING update in the review queue (amend_count ${p.amend_count}). The current proposed-new-state of #${c.id} is:\n${String(p.content ?? "").slice(0, 1200)}`
    );
  }
  if (blocks.length === 0) {
    return "(no pending updates for these candidates — your merged_content can be built straight from the candidate body)";
  }
  return blocks.join("\n\n");
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch {}
  // Try extracting the first {...} block — model sometimes wraps in prose
  const match = text.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch {} }
  return null;
}

async function curatorDecide(entry, candidates, wikiAnchors, pendingByTarget = new Map()) {
  const template = loadCuratorPrompt();
  if (!template) {
    console.error("[plaud-webhook] Curator prompt missing — defaulting to CAPTURE");
    return { decision: "capture", confidence: 0.5, reasoning: "Curator prompt unavailable", target_id: null, merged_content: null, open_question: null };
  }
  const prompt = template
    .replace(/\{\{TODAY\}\}/g, todayIso())
    .replace(/\{\{ENTRY_TYPE\}\}/g, entry.type ?? "observation")
    .replace(/\{\{ENTRY_CONTEXT\}\}/g, entry.classification ?? "work")
    .replace(/\{\{ENTRY_ENTITIES\}\}/g, entry.entities.join(", ") || "(none specified)")
    .replace(/\{\{ENTRY_SEARCH_HINTS\}\}/g, entry.search_hints.join("\n") || "(none specified)")
    .replace(/\{\{ENTRY_BODY\}\}/g, entry.content)
    .replace(/\{\{CANDIDATES_BLOCK\}\}/g, formatCandidates(candidates))
    .replace(/\{\{WIKI_ANCHORS_BLOCK\}\}/g, formatWikiAnchors(wikiAnchors))
    .replace(/\{\{PENDING_UPDATES_BLOCK\}\}/g, formatPendingUpdates(candidates, pendingByTarget));

  const response = await ollamaGenerate(prompt);
  const parsed = safeJsonParse(response);
  if (!parsed || !parsed.decision) {
    console.error("[plaud-webhook] Curator returned unparseable response — defaulting to CAPTURE");
    console.error("[plaud-webhook] Raw:", response.slice(0, 500));
    return { decision: "capture", confidence: 0.5, reasoning: "Curator output unparseable", target_id: null, merged_content: null, open_question: null };
  }
  return {
    decision: String(parsed.decision).toLowerCase(),
    target_id: parsed.target_id ?? null,
    merged_content: parsed.merged_content ?? null,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    reasoning: parsed.reasoning ?? "",
    open_question: parsed.open_question ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// OPEN_QUESTIONS.md handling
// ─────────────────────────────────────────────────────────────────────

function readQuestions() {
  try { return fs.readFileSync(QUESTIONS_PATH, "utf8"); }
  catch { return null; }
}

function writeQuestions(content) {
  const tmp = `${QUESTIONS_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, QUESTIONS_PATH);
}

function nextQuestionNumber(content) {
  if (!content) return 1;
  const nums = [...content.matchAll(/^## Q(\d+)\b/gm)].map((m) => parseInt(m[1], 10));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

function appendOpenQuestions(items) {
  if (!items.length) return 0;
  let content = readQuestions();
  if (content == null) {
    content = "# Open Questions — Plaud → Open Brain Auto-Processor\n\n" +
      "This file is the human-in-the-loop channel for queries the processor can't resolve on its own.\n\n" +
      "**Status values:** `open` · `answered` · `resolved` · `dismissed`\n\n---\n\n";
  }
  let n = nextQuestionNumber(content);
  for (const it of items) {
    const id = `Q${String(n).padStart(3, "0")}`;
    const block = `\n## ${id} — ${it.title}\n\n` +
      `- **Raised:** ${todayIso()} (plaud-webhook)\n` +
      `- **Status:** open\n` +
      (it.target_thought_id != null ? `- **Target thought:** #${it.target_thought_id}\n` : "") +
      `- **Question:** ${it.question}\n` +
      (it.why ? `- **Why it matters:** ${it.why}\n` : "") +
      `- **Answer:** _(write your answer here)_\n\n---\n`;
    content += block;
    n += 1;
  }
  writeQuestions(content);
  return items.length;
}

// Find blocks with Status: answered and an Answer that isn't the placeholder
function findAnsweredQuestions(content) {
  if (!content) return [];
  const blocks = content.split(/\n## Q\d+/g);
  const ids = [...content.matchAll(/\n## (Q\d+)/g)].map((m) => m[1]);
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const block = blocks[i + 1] || "";
    if (!/Status:\s*answered\b/i.test(block)) continue;
    const targetMatch = block.match(/Target thought:\s*#(\d+)/i);
    const answerMatch = block.match(/Answer:\s*([\s\S]*?)(?:\n\n|\n---|$)/i);
    if (!targetMatch || !answerMatch) continue;
    const answer = answerMatch[1].trim();
    if (!answer || /write your answer here/i.test(answer)) continue;
    const titleMatch = block.match(/^\s*—\s*(.+?)\n/);
    out.push({
      qid: ids[i],
      target_id: parseInt(targetMatch[1], 10),
      answer,
      title: titleMatch ? titleMatch[1].trim() : ids[i],
    });
  }
  return out;
}

function markResolved(content, qid) {
  // Replace the first `Status: answered` line within the block of this qid
  const headerRe = new RegExp(`(^|\\n)## ${qid}\\b`);
  const startMatch = content.match(headerRe);
  if (!startMatch) return content;
  const startIdx = startMatch.index + startMatch[0].length;
  const tail = content.slice(startIdx);
  const nextHeader = tail.search(/\n## Q\d+/);
  const blockEnd = nextHeader >= 0 ? startIdx + nextHeader : content.length;
  const block = content.slice(startIdx, blockEnd);
  const updated = block.replace(/(Status:\s*)answered/i, "$1resolved");
  return content.slice(0, startIdx) + updated + content.slice(blockEnd);
}

async function applyAnsweredQuestions() {
  const content = readQuestions();
  const answered = findAnsweredQuestions(content);
  if (!answered.length) return { applied: 0, errors: [] };

  let updatedContent = content;
  let applied = 0;
  const errors = [];

  for (const a of answered) {
    try {
      const target = await getThought(a.target_id);
      if (!target?.content) { errors.push({ qid: a.qid, error: `Target #${a.target_id} not found` }); continue; }
      const merged = `${target.content}\n\n## ${todayIso()} — Answered question (${a.qid})\n${a.answer}`;
      const r = await capturePending({
        content: merged,
        decision: "UPDATE",
        updateTargetId: a.target_id,
        originalContent: target.content,
        type: target.type || "observation",
        classification: target.classification || "work",
        actionItems: null,
      });
      if (r.status >= 200 && r.status < 300) {
        updatedContent = markResolved(updatedContent, a.qid);
        applied += 1;
        console.log(`[plaud-webhook] OPEN_QUESTIONS: applied ${a.qid} → #${a.target_id} (pending review)`);
      } else {
        errors.push({ qid: a.qid, error: `capture-pending status ${r.status}` });
      }
    } catch (err) { errors.push({ qid: a.qid, error: err.message }); }
  }

  if (applied > 0) writeQuestions(updatedContent);
  return { applied, errors };
}

// ─────────────────────────────────────────────────────────────────────
// Skip-rule helpers
// ─────────────────────────────────────────────────────────────────────

function shouldSkipByRules(payload, cursor) {
  const rules = cursor.skip_rules || {};
  const durationMs = payload.recording?.duration_ms ?? payload.recording?.duration_s != null ? payload.recording.duration_s * 1000 : null;
  if (rules.min_duration_ms && durationMs != null && durationMs < rules.min_duration_ms) {
    return { skip: true, reason: `duration ${durationMs}ms < min ${rules.min_duration_ms}ms` };
  }
  const title = (payload.recording?.filename ?? payload.recording?.title ?? "").toLowerCase();
  const keywords = rules.title_skip_keywords || [];
  for (const kw of keywords) {
    if (title.includes(kw.toLowerCase())) return { skip: true, reason: `title matched skip keyword "${kw}"` };
  }
  return { skip: false };
}

// ─────────────────────────────────────────────────────────────────────
// Main processing
// ─────────────────────────────────────────────────────────────────────

async function processRecording(payload) {
  const cursor = readCursor();
  const fileId = payload.recording?.id;
  const filename = payload.recording?.filename ?? "unknown";

  const runLog = {
    run_at: new Date().toISOString(),
    trigger: "applaud-webhook",
    file_id: fileId,
    filename,
    files_checked: 1,
    files_processed: 0,
    actions: { ignore: [], update: [], capture: [] },
    queries_raised: 0,
    answered_applied: 0,
    errors: [],
  };

  // Dedup by file_id (cursor.json canonical), falling back to summary path
  const dedupKey = fileId || payload.files?.summary;

  // ── BLESSING CHECK ────────────────────────────────────────────────
  // Applaud fires TWO transcript_ready webhooks per recording:
  //   1. The original auto-summary fire (summary_markdown = auto sum,
  //      no ENTRY blocks) — fires for every recording with summary.md.
  //   2. The Open-Brain consumer_note fire from Adam's [ob] commit —
  //      only fires when the blessed template's consumer_note is
  //      downloaded. summary_markdown = the OB template output.
  // Only (2) is processable. Distinguish by inspecting files.summary —
  // the OB fire sets it to "<folder>/Open_Brain_Ready_Thought_Extractor*"
  // while the auto fire sets it to "<folder>/summary.md".
  const blessingTabName = cursor.skip_rules?.required_blessing_tab_name || "Open Brain Ready Thought Extractor";
  const blessingNeedle = blessingTabName.replace(/\s+/g, "_");
  const summaryPath = payload.files?.summary ?? "";
  if (!summaryPath.includes(blessingNeedle)) {
    console.log(`[plaud-webhook] Unblessed fire for ${filename} (summary=${summaryPath.split("/").pop()}) — ignoring (waiting for blessed consumer_note)`);
    runLog.notes = "skipped — unblessed webhook fire (no dedup change)";
    cursor.run_log.push(runLog);
    persistCursor(cursor);
    return;
  }

  if (dedupKey && cursor.processed_file_ids.includes(dedupKey)) {
    console.log(`[plaud-webhook] Already processed: ${filename} (${dedupKey}) — skipping`);
    runLog.notes = "skipped — already in processed_file_ids";
    cursor.run_log.push(runLog);
    persistCursor(cursor);
    return;
  }

  // Skip rules (short recordings, mic tests, etc.) — these ARE permanent
  // skips, so we DO add to processed_file_ids.
  const skip = shouldSkipByRules(payload, cursor);
  if (skip.skip) {
    console.log(`[plaud-webhook] Skipping ${filename}: ${skip.reason}`);
    runLog.notes = `skipped — ${skip.reason}`;
    if (dedupKey) cursor.processed_file_ids.push(dedupKey);
    cursor.run_log.push(runLog);
    persistCursor(cursor);
    return;
  }

  const summaryMarkdown = payload.content?.summary_markdown;
  if (!summaryMarkdown) {
    console.log(`[plaud-webhook] No summary for: ${filename}`);
    runLog.notes = "skipped — no summary_markdown (no dedup change)";
    cursor.run_log.push(runLog);
    persistCursor(cursor);
    return;
  }

  // Apply entity corrections BEFORE parsing
  const { text: correctedMarkdown, flagsTriggered } = applyCorrections(summaryMarkdown);

  const entries = parseEntries(correctedMarkdown);
  if (entries.length === 0) {
    // Don't dedup — a later consumer_note fire might bring entries with the
    // same file_id. Marking it processed here was the bug that prevented
    // re-processing once the blessed template was applied.
    console.log(`[plaud-webhook] Blessed fire for ${filename} contained no ENTRY blocks — skipping without dedup`);
    runLog.notes = "skipped — blessed fire had no ENTRY blocks (no dedup change)";
    cursor.run_log.push(runLog);
    persistCursor(cursor);
    return;
  }

  console.log(`[plaud-webhook] Processing ${entries.length} entries from: ${filename}`);
  const openQuestionsToAdd = [];

  // Meeting-cluster context — one Plaud recording = one meeting; the dashboard
  // /review groups pending rows by meeting_id so 5 atomic captures show up as
  // one cluster instead of 5 individual rows. Prefer the topic from the
  // template's MEETING: header when present; otherwise fall back to filename.
  const meetingId = fileId || dedupKey || null;
  const meetingHeader = parseMeetingHeader(correctedMarkdown);
  const meetingTitle = meetingHeader?.topic
    || (filename ? filename.replace(/\.[^/.]+$/, "") : null);
  const meetingTotal = entries.length;
  if (meetingHeader) {
    console.log(`[plaud-webhook] MEETING header → date=${meetingHeader.date || "?"} participants=[${meetingHeader.participants.join(", ")}] topic="${meetingHeader.topic || ""}"`);
  }

  // Surface flag_only triggers as open questions if any non-trivial entry uses them
  for (const f of flagsTriggered) {
    openQuestionsToAdd.push({
      title: `Ambiguous entity name: "${f.wrong}"`,
      question: `Plaud transcript used "${f.wrong}" — is this ${f.canonical}? Context: ${f.context}`,
      why: "Flagged as flag_only in entity_corrections.json — automated replacement skipped.",
      target_thought_id: null,
    });
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const label = `entry ${i + 1}/${entries.length}`;

    try {
      // Pull candidate thoughts via /search per SEARCH_HINTS. Filter pending
      // review rows out of candidates — they're surfaced separately to the
      // curator as "in-flight pending updates" so the curator can amend
      // them rather than treat them as new targets.
      const candidateMap = new Map();
      const hintsToSearch = entry.search_hints.length > 0 ? entry.search_hints : [entry.content.slice(0, 200)];
      for (const hint of hintsToSearch) {
        const results = await searchThoughts(hint, entry.classification);
        for (const r of results) {
          if (r.metadata?.review_status === "pending_review") continue;
          if (!candidateMap.has(r.id)) candidateMap.set(r.id, r);
        }
      }
      const candidates = [...candidateMap.values()].slice(0, 8);

      // For each candidate, check whether a pending UPDATE row already
      // proposes a change to it. If so, surface it to the curator so the
      // merged_content can supersede that pending body rather than
      // duplicating it. This is the fix for the "6 UPDATEs all wiping
      // each other" bug.
      const candidateSerialIds = candidates.map((c) => c.id).filter((n) => Number.isFinite(n));
      const pendingByTarget = await findPendingUpdatesForTargets(candidateSerialIds);

      // Look up canonical wiki anchors for each named entity
      const wikiAnchors = [];
      for (const name of entry.entities) {
        const anchor = await findWikiAnchor(name);
        if (anchor) wikiAnchors.push(anchor);
      }

      // Hand to curator with pending state baked in
      const decision = await curatorDecide(entry, candidates, wikiAnchors, pendingByTarget);
      console.log(`[plaud-webhook] ${label}: ${decision.decision.toUpperCase()}${decision.target_id ? ` #${decision.target_id}` : ""} (conf ${decision.confidence.toFixed(2)}) — ${decision.reasoning}`);

      // Raise open question if curator confidence is low
      if (decision.open_question) {
        openQuestionsToAdd.push({
          title: entry.entities[0] ? `Disambiguate "${entry.entities[0]}" in ${filename}` : `Curator low confidence on ${filename}`,
          question: decision.open_question,
          why: decision.reasoning,
          target_thought_id: decision.target_id ?? null,
        });
      }

      // Act on the decision
      if (decision.decision === "ignore") {
        runLog.actions.ignore.push(`${label}: ${decision.reasoning}`);
        continue;
      }

      if (decision.decision === "update") {
        const target = decision.target_id != null ? await getThought(decision.target_id) : null;
        if (!target?.content) {
          // Fall back to CAPTURE rather than fail
          console.log(`[plaud-webhook] ${label}: UPDATE target #${decision.target_id} not found — falling back to CAPTURE`);
          const r = await capturePending({
            content: entry.content,
            decision: "NEW",
            type: entry.type,
            classification: entry.classification,
            actionItems: entry.action_items,
            meetingId,
            meetingTitle,
            meetingPosition: i + 1,
            meetingTotal,
          });
          runLog.actions.capture.push(`${label}: fallback (target not found) — ${r.body?.thought_id ?? r.status}`);
          continue;
        }
        const existingPending = pendingByTarget.get(decision.target_id);
        const merged = decision.merged_content && decision.merged_content.trim().length > 50
          ? decision.merged_content.trim()
          : `${(existingPending?.content) ?? target.content}\n\n## ${todayIso()}\n${entry.content}`;
        const w = await writeOrAmendPendingUpdate({
          targetSerialId: decision.target_id,
          newContent: merged,
          originalContent: target.content,
          type: entry.type,
          classification: entry.classification,
          actionItems: entry.action_items,
          existingPending,
          meetingId,
          meetingTitle,
          meetingPosition: i + 1,
          meetingTotal,
        });
        if (!w.ok) {
          console.error(`[plaud-webhook] ${label}: UPDATE write failed — ${w.error}`);
          runLog.errors.push({ entry: i + 1, message: `update write failed: ${w.error}` });
          continue;
        }
        if (w.amended) {
          // Reflect the amendment in pendingByTarget so subsequent entries
          // in THIS same session see the latest pending body. Without this,
          // entry 3 of the same Plaud bundle would re-fetch from DB but the
          // map we already built wouldn't show the just-amended content.
          pendingByTarget.set(decision.target_id, {
            ...existingPending,
            content: merged,
            amend_count: w.amend_count,
          });
          runLog.actions.update.push(`${label}: #${decision.target_id} ← amended pending #${w.serial_id} (amend ${w.amend_count})`);
        } else {
          pendingByTarget.set(decision.target_id, {
            uuid: null,
            serial_id: w.serial_id,
            content: merged,
            amend_count: 0,
          });
          runLog.actions.update.push(`${label}: #${decision.target_id} → new pending #${w.serial_id ?? "?"}`);
        }
        continue;
      }

      // CAPTURE (default)
      const r = await capturePending({
        content: entry.content,
        decision: "NEW",
        type: entry.type,
        classification: entry.classification,
        actionItems: entry.action_items,
        meetingId,
        meetingTitle,
        meetingPosition: i + 1,
        meetingTotal,
      });
      runLog.actions.capture.push(`${label}: #${r.body?.thought_id ?? "?"}`);
    } catch (err) {
      console.error(`[plaud-webhook] ${label}: error —`, err.message);
      runLog.errors.push({ entry: i + 1, message: err.message });
    }
  }

  // Append open questions (if any)
  if (openQuestionsToAdd.length > 0) {
    runLog.queries_raised = appendOpenQuestions(openQuestionsToAdd);
  }

  // Apply any answered open questions
  const answered = await applyAnsweredQuestions();
  runLog.answered_applied = answered.applied;
  if (answered.errors.length) runLog.errors.push(...answered.errors.map((e) => ({ kind: "answered_apply", ...e })));

  // Persist cursor with dedupe + run log
  if (dedupKey) cursor.processed_file_ids.push(dedupKey);
  cursor.last_processed_at = new Date().toISOString();
  runLog.files_processed = 1;
  cursor.run_log.push(runLog);
  // Cap run_log at 50 entries (keep newest)
  if (cursor.run_log.length > 50) cursor.run_log = cursor.run_log.slice(-50);
  persistCursor(cursor);

  console.log(`[plaud-webhook] Done: ${runLog.actions.capture.length} captures, ${runLog.actions.update.length} updates, ${runLog.actions.ignore.length} ignored, ${runLog.queries_raised} queries raised, ${runLog.answered_applied} answers applied`);
}

// ─────────────────────────────────────────────────────────────────────
// HTTP server
// ─────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    const cursor = readCursor();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      processed_count: cursor.processed_file_ids.length,
      last_processed_at: cursor.last_processed_at ?? null,
      runs_logged: cursor.run_log.length,
    }));
    return;
  }

  // Manual trigger for answered-questions scan (no Applaud needed)
  if (req.method === "POST" && req.url === "/scan-answered") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: true }));
    applyAnsweredQuestions().then((r) =>
      console.log(`[plaud-webhook] /scan-answered: applied ${r.applied}, errors ${r.errors.length}`)
    ).catch((err) =>
      console.error("[plaud-webhook] /scan-answered error:", err.message)
    );
    return;
  }

  // POST /forget?file_id=<id> — drop a file_id from processed_file_ids so
  // the next webhook fire for it gets processed again. Use when an entry
  // was pre-loaded (e.g. by the manual backfill) but you want the curator
  // to re-run on it. Also accepts ?all_unblessed=1 to clear any file_id
  // that hit the old "no ENTRY blocks" bug and got dedup-locked.
  if (req.method === "POST" && req.url.startsWith("/forget")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const fileId = url.searchParams.get("file_id");
    const cursor = readCursor();
    const before = cursor.processed_file_ids.length;
    if (fileId) {
      cursor.processed_file_ids = cursor.processed_file_ids.filter((id) => id !== fileId);
    } else {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing ?file_id=<id>" }));
      return;
    }
    persistCursor(cursor);
    const removed = before - cursor.processed_file_ids.length;
    console.log(`[plaud-webhook] /forget: removed ${removed} entries (file_id=${fileId})`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ removed, remaining: cursor.processed_file_ids.length }));
    return;
  }

  // POST /consolidate-pending?target=<serial_id> — recovery operation for
  // the pre-fix duplicate-pending bug. Find all pending UPDATE rows for a
  // single target, ask Qwen3 to merge their bodies into one canonical
  // pending merged_content, write that to the oldest row, delete the
  // rest. Run once per affected target. Idempotent — running it on a
  // target with only one pending UPDATE is a no-op.
  if (req.method === "POST" && req.url.startsWith("/consolidate-pending")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const target = url.searchParams.get("target");
    if (!target) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing ?target=<serial_id>" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: true, target }));
    consolidatePendingUpdatesForTarget(Number(target))
      .then((r) => console.log(`[plaud-webhook] /consolidate-pending target=${target}: ${JSON.stringify(r)}`))
      .catch((err) => console.error(`[plaud-webhook] /consolidate-pending target=${target} error:`, err.message));
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
  const cursor = readCursor();
  console.log(`[plaud-webhook] Listening on http://127.0.0.1:${PORT}/webhook`);
  console.log(`[plaud-webhook] Ollama model: ${OLLAMA_MODEL}`);
  console.log(`[plaud-webhook] Processed file IDs loaded: ${cursor.processed_file_ids.length}`);
  console.log(`[plaud-webhook] Curator prompt: ${CURATOR_PROMPT_PATH}`);
  console.log(`[plaud-webhook] Corrections: ${CORRECTIONS_PATH}`);
  console.log(`[plaud-webhook] Open questions: ${QUESTIONS_PATH}`);
});
