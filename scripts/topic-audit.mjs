#!/usr/bin/env node
/**
 * Topic audit — re-evaluate every surviving topic entity against the
 * tightened topic definition.
 *
 * The prompt + filter changes prevent NEW junk topics from being created,
 * but the 214 surviving topics were classified under the old (too-permissive)
 * rules. Many would now be rejected as too-generic, misclassified (should be
 * a tool/project/place), or not-durable-enough for a wiki page.
 *
 * Workflow:
 *   1. Audit (default):
 *        node --env-file=.env scripts/topic-audit.mjs
 *      For each topic entity, fetches its canonical_name + up to 3 sample
 *      mention snippets, asks Qwen3 (using the new topic definition)
 *      whether to keep / delete / reclassify. Writes a markdown report to
 *      processor_prompt/topic-audit-<timestamp>.md for human review.
 *
 *   2. Review:
 *      Open the markdown file. Each row has a Verdict column you can edit.
 *      Valid values:
 *        keep                    — leave as-is
 *        delete                  — drop the entity (and its wiki page)
 *        reclassify-tool         — change entity_type to "tool"
 *        reclassify-project      — change entity_type to "project"
 *        reclassify-organization — change entity_type to "organization"
 *        reclassify-place        — change entity_type to "place"
 *        reclassify-person       — change entity_type to "person"
 *
 *   3. Apply:
 *        node --env-file=.env scripts/topic-audit.mjs --apply <file>
 *      Reads the (possibly hand-edited) markdown file and executes verdicts.
 *      Add --only delete to only apply deletion verdicts, etc.
 *      Default: dry-run, prints what it WOULD do.
 *      Add --yes to actually do it.
 */

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.OPEN_BRAIN_URL;
const BRAIN_KEY = process.env.SUPABASE_KEY || process.env.OPEN_BRAIN_SERVICE_KEY;
const OLLAMA_BASE = (process.env.OLLAMA_URL || "http://localhost:11434/api").replace(/\/+$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:30b";

if (!SUPABASE_URL || !BRAIN_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY in environment.");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, BRAIN_KEY);
const API_BASE = `${SUPABASE_URL}/functions/v1/rest-api`;

const args = process.argv.slice(2);
const APPLY_IDX = args.indexOf("--apply");
const APPLY_PATH = APPLY_IDX >= 0 ? args[APPLY_IDX + 1] : null;
const ONLY_IDX = args.indexOf("--only");
const ONLY_VERDICT = ONLY_IDX >= 0 ? args[ONLY_IDX + 1] : null;
const APPLY_YES = args.includes("--yes") || args.includes("-y");

const PROCESSOR_DIR = path.resolve(process.cwd(), "processor_prompt");
if (!fs.existsSync(PROCESSOR_DIR)) fs.mkdirSync(PROCESSOR_DIR, { recursive: true });

const VALID_VERDICTS = new Set([
  "keep",
  "delete",
  "reclassify-tool",
  "reclassify-project",
  "reclassify-organization",
  "reclassify-place",
  "reclassify-person",
  "uncertain",
]);

// ─── Audit prompt — embeds the tightened definition ────────────────────
const AUDIT_PROMPT_TEMPLATE = `/no_think
You are auditing one entry in a personal knowledge graph. The user wants
to know: should this STAY as a topic, should it be DELETED, or should it
be RECLASSIFIED as a different entity type?

A topic is a DURABLE CONCEPT — a methodology, theme, technical area, or
domain that the user would want to read a wiki page about in 3 months.
Topics ARE allowed to be abstract — that's what makes them topics.

KEEP these (durable concepts, even when they sound abstract):
- "agentic AI", "vector embeddings", "RAG", "prompt engineering"
- "per-funder concurrency", "Open Banking", "Consumer Duty"
- "renewal leads", "Solver-of-the-week", "remote-first culture"
- "regression testing", "Playwright fingerprinting", "rate-limiting"
- "customer journey mapping", "retention metrics", "B2B sales motion"

DELETE these (not durable concepts):
- Dates / date-like ("2026-05-19", "Q1 2026", "early November", "next week")
- Filenames / paths ("README.md", "scripts/foo.js")
- Config keys / parameter names ("num_predict", "max_tokens", "OPENROUTER_API_KEY")
- Jira / ticket IDs ("AA-222", "ENG-1234")
- Product SKUs ("20,000-credit pack")
- Generic English nouns USED IN ORDINARY SENSE without specific context
  ("the meeting", "the system", "the bot", "the platform" — these are
  filler, not durable concepts)
- Meeting jargon ("stakeholder meeting", "POC milestone", "weekly standup")
- Bare numbers or money amounts ("92", "£28,000", "1024 tokens")
- Garbled / suspected STT errors (half-formed, doesn't make sense in context)
- Single-character or two-letter junk

RECLASSIFY if the candidate IS a specific real thing but the wrong type:
- reclassify-tool         → a named software product, library, or framework
                            (e.g. "Promptinator", "LangChain", "BookStack")
- reclassify-project      → a named initiative, build, or product the user
                            is involved in
                            (e.g. "Funder Pricing Bot Migration", "Open Brain")
- reclassify-organization → a named company / body / team / institution
                            (e.g. "Cybit", "BVRLA")
- reclassify-place        → a named geographic location ("Reading", "London")
- reclassify-person       → a named individual human

IMPORTANT — read the sample snippets:
- The CANDIDATE name on its own can look ambiguous. The samples tell you
  how the user actually uses it. If the samples show this name appearing
  as the SUBJECT of recurring substantive discussion, it's a real topic
  and you KEEP it, even if the bare name looks abstract.
- If the samples show this name appearing as a passing English noun
  (e.g. "we held a meeting", "the system was down"), it's filler — DELETE.

CANDIDATE:
Name: {{NAME}}
Linked mentions: {{MENTION_COUNT}}
Sample thought snippets (how the name is actually used in real captures):

{{SAMPLES}}

Return ONLY a single-line JSON object — no explanation, no preamble, no
markdown fences. Schema:
{"verdict":"keep|delete|reclassify-tool|reclassify-project|reclassify-organization|reclassify-place|reclassify-person|uncertain","reason":"<one short sentence>"}`;

// ─── Ollama call ───────────────────────────────────────────────────────

async function ollamaGenerate(prompt) {
  const res = await fetch(`${OLLAMA_BASE}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const body = await res.json();
  return (body.response ?? body.message?.content ?? "").trim();
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*?\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// ─── Audit mode ────────────────────────────────────────────────────────

async function fetchSampleSnippets(entityId) {
  const { data: links } = await supabase
    .from("thought_entities")
    .select("thought_id")
    .eq("entity_id", entityId)
    .limit(3);
  if (!links?.length) return [];
  const uuids = links.map((l) => l.thought_id);
  const { data: thoughts } = await supabase
    .from("thoughts")
    .select("serial_id, content")
    .in("id", uuids);
  return (thoughts ?? []).map((t) => ({
    serial: t.serial_id,
    snippet: String(t.content ?? "").replace(/\s+/g, " ").slice(0, 350),
  }));
}

async function auditEntity(entity) {
  const samples = await fetchSampleSnippets(entity.id);
  const sampleBlock = samples.length
    ? samples.map((s, i) => `[${i + 1}] #${s.serial}: ${s.snippet}`).join("\n\n")
    : "(no linked thoughts found)";
  const prompt = AUDIT_PROMPT_TEMPLATE
    .replace("{{NAME}}", entity.canonical_name)
    .replace("{{MENTION_COUNT}}", String(entity.mention_count ?? 0))
    .replace("{{SAMPLES}}", sampleBlock);

  let parsed = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const raw = await ollamaGenerate(prompt);
    parsed = safeJsonParse(raw);
  }
  if (!parsed?.verdict || !VALID_VERDICTS.has(parsed.verdict)) {
    return { verdict: "uncertain", reason: "audit-call returned unparseable verdict" };
  }
  return { verdict: parsed.verdict, reason: String(parsed.reason ?? "").slice(0, 200) };
}

async function runAudit() {
  console.log(`Loading topic entities…`);
  const { data: topics, error } = await supabase
    .from("entities")
    .select("id, canonical_name")
    .eq("entity_type", "topic")
    .order("canonical_name");
  if (error) { console.error(error); process.exit(1); }
  console.log(`Loaded ${topics.length} topics. Auditing each via ${OLLAMA_MODEL}…`);

  const mentionCounts = new Map();
  {
    const { data } = await supabase.rpc("constellation_top_entities", { p_days: 90, p_limit: 5000 });
    for (const row of data ?? []) mentionCounts.set(row.entity_id, Number(row.mentions) || 0);
  }

  const results = [];
  let idx = 0;
  for (const t of topics) {
    idx += 1;
    process.stdout.write(`[${idx}/${topics.length}] #${t.id} ${t.canonical_name} … `);
    try {
      const r = await auditEntity({ ...t, mention_count: mentionCounts.get(t.id) ?? 0 });
      results.push({ id: t.id, name: t.canonical_name, mentions: mentionCounts.get(t.id) ?? 0, ...r });
      console.log(r.verdict);
    } catch (err) {
      console.log(`ERR: ${err.message}`);
      results.push({ id: t.id, name: t.canonical_name, mentions: mentionCounts.get(t.id) ?? 0, verdict: "uncertain", reason: `audit error: ${err.message}` });
    }
  }

  // Save markdown report
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const outPath = path.join(PROCESSOR_DIR, `topic-audit-${ts}.md`);
  const lines = [
    `# Topic audit — ${new Date().toISOString().slice(0, 19)}`,
    "",
    `Audited ${results.length} topic entities via ${OLLAMA_MODEL}.`,
    "",
    "Edit the **Verdict** column if you want to override a recommendation, then apply:",
    "",
    "```",
    `node --env-file=.env scripts/topic-audit.mjs --apply ${path.relative(process.cwd(), outPath)}`,
    "```",
    "",
    "Add `--only delete` (or any single verdict) to scope the apply.",
    "Default is dry-run; add `--yes` to actually execute.",
    "",
    "| ID | Name | Mentions | Verdict | Reason |",
    "|---:|------|---------:|---------|--------|",
  ];
  // Sort: deletes first, then reclassifies, then uncertain, then keeps. Within group, by name.
  const order = ["delete", "reclassify-tool", "reclassify-project", "reclassify-organization", "reclassify-place", "reclassify-person", "uncertain", "keep"];
  results.sort((a, b) => {
    const oa = order.indexOf(a.verdict);
    const ob = order.indexOf(b.verdict);
    if (oa !== ob) return oa - ob;
    return a.name.localeCompare(b.name);
  });
  for (const r of results) {
    const name = r.name.replace(/\|/g, "\\|");
    const reason = r.reason.replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${r.id} | ${name} | ${r.mentions} | ${r.verdict} | ${reason} |`);
  }
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");

  const summary = results.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] ?? 0) + 1; return acc; }, {});
  console.log("");
  console.log("Verdict summary:");
  for (const v of order) if (summary[v]) console.log(`  ${v.padEnd(28)} ${summary[v]}`);
  console.log("");
  console.log(`Wrote ${outPath}`);
}

// ─── Apply mode ────────────────────────────────────────────────────────

function parseAuditFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(\d+)\s*\|\s*(\S+)\s*\|\s*(.*?)\s*\|$/);
    if (!m) continue;
    const verdict = m[4];
    if (!VALID_VERDICTS.has(verdict)) continue;
    rows.push({
      id: Number(m[1]),
      name: m[2],
      mentions: Number(m[3]),
      verdict,
      reason: m[5],
    });
  }
  return rows;
}

async function applyAudit() {
  if (!APPLY_PATH) {
    console.error("--apply <file> required");
    process.exit(1);
  }
  const rows = parseAuditFile(APPLY_PATH);
  console.log(`Parsed ${rows.length} verdicts from ${APPLY_PATH}.`);

  const filtered = ONLY_VERDICT
    ? rows.filter((r) => r.verdict === ONLY_VERDICT)
    : rows.filter((r) => r.verdict !== "keep" && r.verdict !== "uncertain");

  if (!filtered.length) {
    console.log("Nothing to apply (after filter).");
    return;
  }

  console.log(`Filter: ${ONLY_VERDICT ?? "non-keep, non-uncertain"} → ${filtered.length} rows.`);
  const counts = filtered.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] ?? 0) + 1; return acc; }, {});
  for (const [v, c] of Object.entries(counts)) console.log(`  ${v.padEnd(28)} ${c}`);

  if (!APPLY_YES) {
    console.log("\nDry-run. Add --yes to execute.");
    return;
  }

  let ok = 0, failed = 0;
  for (const r of filtered) {
    try {
      if (r.verdict === "delete") {
        const res = await fetch(`${API_BASE}/entities/${r.id}`, {
          method: "DELETE",
          headers: { "x-brain-key": BRAIN_KEY },
        });
        if (!res.ok) throw new Error(`delete HTTP ${res.status}`);
      } else if (r.verdict.startsWith("reclassify-")) {
        const newType = r.verdict.slice("reclassify-".length);
        const res = await fetch(`${API_BASE}/entities/${r.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "x-brain-key": BRAIN_KEY },
          body: JSON.stringify({ entity_type: newType }),
        });
        if (!res.ok) throw new Error(`patch HTTP ${res.status}`);
      } else {
        continue;
      }
      ok += 1;
      process.stdout.write(".");
    } catch (err) {
      failed += 1;
      console.error(`\n  Failed #${r.id} ${r.name} (${r.verdict}): ${err.message}`);
    }
  }
  console.log(`\nDone. Applied ${ok}, failed ${failed}.`);
}

// ─── Main ──────────────────────────────────────────────────────────────

(APPLY_PATH ? applyAudit() : runAudit()).catch((err) => {
  console.error(err);
  process.exit(1);
});
