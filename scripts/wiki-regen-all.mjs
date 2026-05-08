#!/usr/bin/env node
/**
 * wiki-regen-all.mjs — regenerate wiki pages for every entity at or above the
 * MIN_LINKED_FOR_WIKI threshold. One-shot maintenance script — runs the
 * existing recipes/entity-wiki/generate-wiki.mjs once per qualifying entity.
 *
 * Use after a structural edge change (reconcile pass, Layer 2 cutover) to
 * bring every wiki article in line with the live edges/entities tables in
 * one go, instead of relying on the worker to regenerate them piecemeal as
 * thoughts get touched.
 *
 * Usage:
 *   node --env-file=.env scripts/wiki-regen-all.mjs --dry-run
 *   node --env-file=.env scripts/wiki-regen-all.mjs              # default min=3
 *   node --env-file=.env scripts/wiki-regen-all.mjs --min 2
 *   node --env-file=.env scripts/wiki-regen-all.mjs --skip-pinned-only
 */
import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIKI_SCRIPT = path.resolve(__dirname, "..", "recipes", "entity-wiki", "generate-wiki.mjs");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const minIdx = args.indexOf("--min");
const min = minIdx >= 0 ? Number(args[minIdx + 1]) : Number(process.env.MIN_LINKED_FOR_WIKI || 3);
const skipPinnedOnly = args.includes("--skip-pinned-only");

const url = process.env.SUPABASE_URL || process.env.OPEN_BRAIN_URL;
const key = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("SUPABASE_URL / SUPABASE_KEY required"); process.exit(1); }
const sb = createClient(url, key);

console.log(`Discovering entities with >= ${min} linked thoughts${skipPinnedOnly ? " (pinned-only)" : ""}...`);

const { data: entities } = await sb
  .from("entities")
  .select("id, canonical_name, entity_type, pinned");

const eligible = [];
for (const e of entities || []) {
  if (skipPinnedOnly && !e.pinned) continue;
  const { count } = await sb
    .from("thought_entities")
    .select("thought_id", { count: "exact", head: true })
    .eq("entity_id", e.id);
  if ((count ?? 0) >= min || (e.pinned && (count ?? 0) > 0)) {
    eligible.push({ ...e, linked: count ?? 0 });
  }
}
eligible.sort((a, b) => b.linked - a.linked);

console.log(`Eligible: ${eligible.length} entities.`);
if (dryRun) {
  for (const e of eligible.slice(0, 50)) {
    console.log(`  #${String(e.id).padEnd(5)} [${e.entity_type.padEnd(12)}] ${e.canonical_name.padEnd(38)} ${e.linked} thoughts${e.pinned ? " 📌" : ""}`);
  }
  if (eligible.length > 50) console.log(`  ... and ${eligible.length - 50} more`);
  console.log(`\n[dry-run] Re-run without --dry-run to regenerate ${eligible.length} wiki page${eligible.length === 1 ? "" : "s"}.`);
  process.exit(0);
}

function runWiki(entityId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WIKI_SCRIPT, "--id", String(entityId)], {
      stdio: "inherit",
      env: process.env,
      cwd: path.resolve(__dirname, ".."),
    });
    child.on("exit", (code) => resolve({ ok: code === 0 }));
    child.on("error", (err) => { console.error(err.message); resolve({ ok: false }); });
  });
}

const startedAt = Date.now();
let ok = 0, failed = 0;
for (let i = 0; i < eligible.length; i++) {
  const e = eligible[i];
  console.log(`\n[${i + 1}/${eligible.length}] #${e.id} ${e.canonical_name} (${e.linked} linked)`);
  const r = await runWiki(e.id);
  if (r.ok) ok++; else failed++;
}
const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
console.log(`\nDone. ${ok} ok, ${failed} failed, ${elapsedMin} min wall clock.`);
