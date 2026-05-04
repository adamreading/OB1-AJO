#!/usr/bin/env node
/**
 * wiki-wipe.mjs — clear all wiki_pages rows and report entity/alias health.
 * Usage: node --env-file=.env scripts/wiki-wipe.mjs
 *        node --env-file=.env scripts/wiki-wipe.mjs --dry-run
 */

import { createClient } from "@supabase/supabase-js";

const dryRun = process.argv.includes("--dry-run");

const url = process.env.OPEN_BRAIN_URL || process.env.SUPABASE_URL;
const key = process.env.OPEN_BRAIN_SERVICE_KEY || process.env.SUPABASE_KEY;
if (!url || !key) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_KEY required in .env");
  process.exit(1);
}

const sb = createClient(url, key);

// ── Report entity + alias health ──────────────────────────────────────────

const { data: entities, error: entErr } = await sb
  .from("entities")
  .select("id, canonical_name, entity_type, aliases, normalized_name")
  .order("canonical_name");

if (entErr) { console.error("entity fetch failed:", entErr.message); process.exit(1); }

console.log(`\n── Entity health (${entities.length} total) ──`);
for (const e of entities) {
  const aliases = e.aliases ?? [];
  console.log(`  #${e.id} [${e.entity_type}] ${e.canonical_name}${aliases.length ? `  aliases: ${aliases.join(", ")}` : ""}`);
}

// ── Check for wiki_pages with no matching entity ──────────────────────────

const { data: wikiPages, error: wErr } = await sb
  .from("wiki_pages")
  .select("id, slug, title, entity_id, type");

if (wErr) { console.error("wiki_pages fetch failed:", wErr.message); process.exit(1); }

const entityIds = new Set(entities.map((e) => e.id));
const orphaned = wikiPages.filter((p) => p.entity_id && !entityIds.has(p.entity_id));
const total = wikiPages.length;

console.log(`\n── wiki_pages: ${total} rows, ${orphaned.length} orphaned ──`);
if (orphaned.length) {
  for (const p of orphaned) {
    console.log(`  ORPHAN: slug="${p.slug}" title="${p.title}" entity_id=${p.entity_id}`);
  }
}

// ── Wipe ──────────────────────────────────────────────────────────────────

if (dryRun) {
  console.log(`\n[dry-run] would delete ${total} wiki_pages rows. Re-run without --dry-run to proceed.`);
  process.exit(0);
}

console.log(`\nDeleting all ${total} wiki_pages rows…`);
const { error: delErr } = await sb.from("wiki_pages").delete().gte("id", 0);
if (delErr) { console.error("delete failed:", delErr.message); process.exit(1); }
console.log("Done. wiki_pages is now empty. Run the batch rebuild to regenerate.");
