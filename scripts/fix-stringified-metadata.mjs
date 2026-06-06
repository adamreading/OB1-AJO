// Backfill: the thought-enrichment recipe had a bug where it double-stringified
// the metadata column before PATCH, so PostgREST stored it as a JSONB string
// scalar instead of a JSONB object. This makes metadata->'topics',
// metadata->'action_items', etc. all return null, which broke the MCP
// list_action_items tool, thought_stats top_topics, and any other query that
// uses the JSON operators. This script reads every affected row, parses the
// inner string back to an object, and writes it back as a proper JSONB object.

import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL || process.env.OPEN_BRAIN_URL;
const KEY = process.env.SUPABASE_KEY || process.env.OPEN_BRAIN_SERVICE_KEY;
const sb = createClient(URL, KEY);

const apply = process.argv.includes("--apply");

const rows = [];
let from = 0;
while (true) {
  const { data, error } = await sb.from("thoughts").select("id, serial_id, metadata").eq("enriched", true).range(from, from + 999);
  if (error || !data || data.length === 0) break;
  rows.push(...data);
  if (data.length < 1000) break;
  from += 1000;
}

const stringified = rows.filter((r) => typeof r.metadata === "string");
console.log(`Enriched thoughts: ${rows.length}`);
console.log(`With stringified metadata: ${stringified.length}`);

if (stringified.length === 0) {
  console.log("Nothing to fix.");
  process.exit(0);
}

const samples = stringified.slice(0, 2);
console.log("\nSample BEFORE:");
for (const t of samples) {
  console.log(`  #${t.serial_id}: ${String(t.metadata).slice(0, 100)}…`);
}

let parseErrors = 0;
const fixes = [];
for (const t of stringified) {
  try {
    const parsed = JSON.parse(t.metadata);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      parseErrors++;
      continue;
    }
    fixes.push({ id: t.id, serial_id: t.serial_id, metadata: parsed });
  } catch (err) {
    parseErrors++;
  }
}
console.log(`\nParseable: ${fixes.length}, parse-errors: ${parseErrors}`);

if (!apply) {
  console.log("\nDry-run only. Pass --apply to commit.");
  process.exit(0);
}

let ok = 0, fail = 0;
for (const fix of fixes) {
  const { error } = await sb.from("thoughts").update({ metadata: fix.metadata }).eq("id", fix.id);
  if (error) {
    fail++;
    if (fail <= 5) console.log(`  FAIL #${fix.serial_id}: ${error.message}`);
  } else {
    ok++;
  }
}
console.log(`\nFixed: ${ok}, failed: ${fail}`);
