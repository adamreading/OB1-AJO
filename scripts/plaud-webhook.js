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

const PORT = Number(process.env.PLAUD_WEBHOOK_PORT || 4001);
const SUPABASE_URL = process.env.SUPABASE_URL;
const BRAIN_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
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

async function capturePending({ content, decision, updateTargetId, originalContent, type, classification, actionItems }) {
  const body = { content, source_type: "plaud", ollama_decision: decision };
  if (updateTargetId != null) body.update_target_id = updateTargetId;
  if (originalContent != null) body.original_content = originalContent;
  if (type) body.type = type;
  if (classification) body.classification = classification;
  if (Array.isArray(actionItems) && actionItems.length > 0) body.action_items = actionItems;
  return apiCall("POST", "/capture-pending", body);
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

async function curatorDecide(entry, candidates, wikiAnchors) {
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
    .replace(/\{\{WIKI_ANCHORS_BLOCK\}\}/g, formatWikiAnchors(wikiAnchors));

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
  if (dedupKey && cursor.processed_file_ids.includes(dedupKey)) {
    console.log(`[plaud-webhook] Already processed: ${filename} (${dedupKey}) — skipping`);
    runLog.notes = "skipped — already in processed_file_ids";
    cursor.run_log.push(runLog);
    persistCursor(cursor);
    return;
  }

  // Skip rules (short recordings, mic tests, etc.)
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
    runLog.notes = "skipped — no summary_markdown";
    cursor.run_log.push(runLog);
    persistCursor(cursor);
    return;
  }

  // Apply entity corrections BEFORE parsing
  const { text: correctedMarkdown, flagsTriggered } = applyCorrections(summaryMarkdown);

  const entries = parseEntries(correctedMarkdown);
  if (entries.length === 0) {
    console.log(`[plaud-webhook] No ENTRY blocks in: ${filename} — not blessed, skipping`);
    runLog.notes = "skipped — no ENTRY blocks (not the blessed template)";
    if (dedupKey) cursor.processed_file_ids.push(dedupKey);
    cursor.run_log.push(runLog);
    persistCursor(cursor);
    return;
  }

  console.log(`[plaud-webhook] Processing ${entries.length} entries from: ${filename}`);
  const openQuestionsToAdd = [];

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
      // Pull candidate thoughts via /search per SEARCH_HINTS
      const candidateMap = new Map(); // dedupe by id
      const hintsToSearch = entry.search_hints.length > 0 ? entry.search_hints : [entry.content.slice(0, 200)];
      for (const hint of hintsToSearch) {
        const results = await searchThoughts(hint, entry.classification);
        for (const r of results) {
          if (!candidateMap.has(r.id)) candidateMap.set(r.id, r);
        }
      }
      const candidates = [...candidateMap.values()].slice(0, 8);

      // Look up canonical wiki anchors for each named entity
      const wikiAnchors = [];
      for (const name of entry.entities) {
        const anchor = await findWikiAnchor(name);
        if (anchor) wikiAnchors.push(anchor);
      }

      // Hand to curator
      const decision = await curatorDecide(entry, candidates, wikiAnchors);
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
          });
          runLog.actions.capture.push(`${label}: fallback (target not found) — ${r.body?.thought_id ?? r.status}`);
          continue;
        }
        const merged = decision.merged_content && decision.merged_content.trim().length > 50
          ? decision.merged_content.trim()
          : `${target.content}\n\n## ${todayIso()}\n${entry.content}`;
        const r = await capturePending({
          content: merged,
          decision: "UPDATE",
          updateTargetId: decision.target_id,
          originalContent: target.content,
          type: entry.type,
          classification: entry.classification,
          actionItems: entry.action_items,
        });
        runLog.actions.update.push(`${label}: #${decision.target_id} → #${r.body?.thought_id ?? "?"}`);
        continue;
      }

      // CAPTURE (default)
      const r = await capturePending({
        content: entry.content,
        decision: "NEW",
        type: entry.type,
        classification: entry.classification,
        actionItems: entry.action_items,
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
