#!/usr/bin/env node
/**
 * wiki-prune.mjs — delete wiki pages for entities below the link threshold.
 *
 * Use this once after lowering the wiki-generation bar (default 3 linked
 * thoughts) to clean out the long tail of single-mention pages. Entities
 * themselves are kept; only their wiki_pages rows go. If an entity later
 * accumulates enough mentions, the worker will regenerate the page.
 *
 * Usage:
 *   node --env-file=.env scripts/wiki-prune.mjs --dry-run
 *   node --env-file=.env scripts/wiki-prune.mjs              # default min=3
 *   node --env-file=.env scripts/wiki-prune.mjs --min 2
 *
 * Options:
 *   --min <N>     Minimum linked thought count to keep (default 3)
 *   --dry-run     Print what would be deleted, change nothing
 */
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const minIdx = args.indexOf("--min");
const min = minIdx >= 0 ? Number(args[minIdx + 1]) : Number(process.env.MIN_LINKED_FOR_WIKI || 3);
if (!Number.isFinite(min) || min < 1) {
  console.error(`Invalid --min value: ${args[minIdx + 1]}`);
  process.exit(1);
}

const url = process.env.SUPABASE_URL || process.env.OPEN_BRAIN_URL;
const key = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.OPEN_BRAIN_SERVICE_KEY;
if (!url || !key) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_KEY required in .env");
  process.exit(1);
}
const sb = createClient(url, key);

console.log(`Pruning wiki_pages for entities with < ${min} linked thoughts${dryRun ? " (dry-run)" : ""}...`);

const { data: pages, error: pErr } = await sb
  .from("wiki_pages")
  .select("id, slug, title, entity_id, manually_edited, notes")
  .not("entity_id", "is", null);
if (pErr) { console.error("wiki_pages fetch failed:", pErr.message); process.exit(1); }

let kept = 0;
let pruned = 0;
let skippedManual = 0;
let skippedNotes = 0;
const toDelete = [];

for (const page of pages || []) {
  if (page.manually_edited) {
    skippedManual++;
    continue;
  }
  if (page.notes && String(page.notes).trim().length > 0) {
    skippedNotes++;
    continue;
  }
  const { count } = await sb
    .from("thought_entities")
    .select("thought_id", { count: "exact", head: true })
    .eq("entity_id", page.entity_id);
  const linked = count ?? 0;
  if (linked < min) {
    toDelete.push(page);
    pruned++;
    if (toDelete.length <= 20) {
      console.log(`  PRUNE  ${page.slug.padEnd(40)} (${linked} linked) — ${page.title}`);
    } else if (toDelete.length === 21) {
      console.log(`  ... (more pruned, only first 20 shown)`);
    }
  } else {
    kept++;
  }
}

console.log("");
console.log(`Summary: ${kept} kept, ${pruned} to prune, ${skippedManual} manually-edited (skipped), ${skippedNotes} with curator notes (skipped)`);

if (dryRun) {
  console.log(`\n[dry-run] Re-run without --dry-run to delete ${pruned} wiki page${pruned === 1 ? "" : "s"}.`);
  process.exit(0);
}

if (pruned === 0) {
  console.log("Nothing to prune.");
  process.exit(0);
}

const ids = toDelete.map((p) => p.id);
const CHUNK = 100;
let deleted = 0;
for (let i = 0; i < ids.length; i += CHUNK) {
  const chunk = ids.slice(i, i + CHUNK);
  const { error } = await sb.from("wiki_pages").delete().in("id", chunk);
  if (error) { console.error("delete chunk failed:", error.message); process.exit(1); }
  deleted += chunk.length;
}
console.log(`Done. Deleted ${deleted} wiki page${deleted === 1 ? "" : "s"}.`);
