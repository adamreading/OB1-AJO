#!/usr/bin/env node
/**
 * Topic cleanup — audit and delete junk topic entities.
 *
 * The brain worker's prompt was historically too permissive about what
 * counts as a `topic` entity type. Result: 249 topics in the DB, many
 * of which are dates, filenames, config keys, pure numbers, generic
 * English nouns, or meeting jargon. This script runs the same junk
 * filter the worker now applies at extraction time, but against the
 * EXISTING topic set, and reports / deletes the matches.
 *
 * Usage:
 *   node --env-file=.env scripts/topic-cleanup.mjs            # dry-run (default)
 *   node --env-file=.env scripts/topic-cleanup.mjs --apply    # actually delete
 *   node --env-file=.env scripts/topic-cleanup.mjs --apply --yes  # skip confirm
 *
 * Deletes via REST /entities/:id which cascades to thought_entities + edges
 * and explicitly drops wiki_pages.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.OPEN_BRAIN_URL;
const BRAIN_KEY = process.env.SUPABASE_KEY || process.env.OPEN_BRAIN_SERVICE_KEY;

if (!SUPABASE_URL || !BRAIN_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY in environment.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, BRAIN_KEY);
const API_BASE = `${SUPABASE_URL}/functions/v1/rest-api`;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const SKIP_CONFIRM = args.includes("--yes") || args.includes("-y");

// ─── Same filter logic as scripts/local-brain-worker.js ────────────────
const TOPIC_FILE_EXT_RE = /\.(md|markdown|json|ya?ml|toml|env|ini|cfg|sql|tsx?|jsx?|mjs|cjs|py|rb|go|rs|sh|ps1|bat|txt|csv|log|html?|css|scss|xml)$/i;
const TOPIC_DATE_RE = /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4}|Q[1-4](\s*\d{4})?|\d{4}\s*Q[1-4]|H[12](\s*\d{4})?)$/i;
const TOPIC_CONFIG_KEY_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+){1,}$/;
const TOPIC_PURE_NUMBER_RE = /^[£$€]?\s*[\d,]+(\.\d+)?\s*[kKmMbB%]?$/;
// Tighter than "any slash" — only flag relative/absolute paths or path+ext.
const TOPIC_FILE_PATH_RE = /^[.\/\\]|^[\w\-]+\/[\w\-./\\]+\.[a-z]{1,5}$/i;
const TOPIC_BAD_GENERIC_NOUNS = new Set([
  "funder", "funders", "rate book", "rate books", "the meeting", "the system",
  "the bot", "the dashboard", "the tool", "the project", "the platform",
  "the team", "the vendor", "the client", "the customer",
  "stakeholder meetings", "stakeholder meeting", "poc milestones", "poc milestone",
  "end-of-quarter period", "weekly standup", "daily standup", "all-hands",
  "the call", "the chat", "the email", "the demo", "the proposal",
]);

function classifyJunk(name) {
  const t = String(name || "").trim();
  if (!t) return "empty";
  if (t.length < 2) return "too-short";
  if (TOPIC_DATE_RE.test(t)) return "date";
  if (TOPIC_FILE_EXT_RE.test(t)) return "filename";
  if (TOPIC_FILE_PATH_RE.test(t)) return "file-path";
  if (TOPIC_CONFIG_KEY_RE.test(t)) return "config-key";
  if (TOPIC_PURE_NUMBER_RE.test(t)) return "pure-number";
  if (TOPIC_BAD_GENERIC_NOUNS.has(t.toLowerCase())) return "generic-noun";
  return null;
}

// ─── Main ──────────────────────────────────────────────────────────────
async function main() {
  console.log(APPLY ? "MODE: APPLY (will delete)" : "MODE: dry-run (use --apply to delete)");
  console.log("Fetching topics…");

  const { data: topics, error } = await supabase
    .from("entities")
    .select("id, canonical_name")
    .eq("entity_type", "topic")
    .order("canonical_name");
  if (error) {
    console.error("Failed to load topics:", error.message);
    process.exit(1);
  }
  console.log(`Loaded ${topics.length} topic entities.`);

  // Group by junk category for review
  const byCategory = new Map();
  for (const t of topics) {
    const cat = classifyJunk(t.canonical_name);
    if (!cat) continue;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(t);
  }

  const totalJunk = [...byCategory.values()].reduce((sum, arr) => sum + arr.length, 0);
  console.log(`\nFound ${totalJunk} junk topics across ${byCategory.size} categories:\n`);

  for (const [cat, rows] of byCategory) {
    console.log(`  [${cat}] ${rows.length} entities:`);
    for (const r of rows.slice(0, 30)) {
      console.log(`    #${r.id}  ${r.canonical_name}`);
    }
    if (rows.length > 30) console.log(`    …and ${rows.length - 30} more`);
    console.log();
  }

  if (!APPLY) {
    console.log("Dry-run complete. Re-run with --apply to delete these entities.");
    return;
  }

  if (!SKIP_CONFIRM) {
    console.log(`About to delete ${totalJunk} entities. Pass --yes to skip this prompt.`);
    console.log("Sleeping 5s — Ctrl+C to abort.");
    await new Promise((r) => setTimeout(r, 5000));
  }

  // Use REST DELETE so cascade behaviour matches the dashboard's delete flow
  // (drops wiki_pages explicitly, cascades thought_entities + edges).
  let ok = 0;
  let failed = 0;
  for (const [, rows] of byCategory) {
    for (const r of rows) {
      const res = await fetch(`${API_BASE}/entities/${r.id}`, {
        method: "DELETE",
        headers: { "x-brain-key": BRAIN_KEY },
      });
      if (res.ok) {
        ok += 1;
        process.stdout.write(".");
      } else {
        failed += 1;
        const text = await res.text().catch(() => "");
        console.error(`\nFailed to delete #${r.id} ${r.canonical_name}: ${res.status} ${text.slice(0, 100)}`);
      }
    }
  }
  console.log(`\nDone. Deleted ${ok}, failed ${failed}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
