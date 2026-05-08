#!/usr/bin/env node
/**
 * wiki-clean-stale.mjs — find and clean wiki pages with citations to deleted thoughts.
 *
 * Scans every wiki_pages.content for [#N] citations, verifies each N exists in
 * thoughts.serial_id. For pages with any stale citation:
 *   - If the entity now has < MIN_LINKED_FOR_WIKI linked thoughts, delete the
 *     wiki_pages row entirely.
 *   - Otherwise, re-queue the entity's most recent linked thought into
 *     entity_extraction_queue. The local worker picks it up and regenerates
 *     the page with current citations only.
 *
 * Skips manually_edited pages and pages with curator notes.
 *
 * Usage:
 *   node --env-file=.env scripts/wiki-clean-stale.mjs --dry-run
 *   node --env-file=.env scripts/wiki-clean-stale.mjs
 *   node --env-file=.env scripts/wiki-clean-stale.mjs --min 3
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

console.log(`Scanning wiki pages for citations to deleted thoughts${dryRun ? " (dry-run)" : ""}...`);

const { data: pages, error: pErr } = await sb
  .from("wiki_pages")
  .select("id, slug, title, entity_id, content, manually_edited, notes")
  .not("entity_id", "is", null);
if (pErr) { console.error("wiki_pages fetch failed:", pErr.message); process.exit(1); }

// Citation pattern: [#42] or [#142] etc. We are intentionally strict — bare [42]
// without a hash isn't a real citation in the current format and won't be flagged.
const CITATION_RE = /\[#(\d+)\]/g;

// Build a fast lookup of all serial_ids that currently exist
const aliveSerialIds = new Set();
{
  const PAGE = 1000;
  let from = 0;
  // Loop in chunks because the table can be large.
  while (true) {
    const { data, error } = await sb
      .from("thoughts")
      .select("serial_id")
      .order("serial_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error("thoughts scan failed:", error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (r.serial_id != null) aliveSerialIds.add(r.serial_id);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
}
console.log(`Indexed ${aliveSerialIds.size} live thoughts.`);

let scanned = 0;
let cleanPages = 0;
let stalePages = 0;
let skippedManual = 0;
let skippedNotes = 0;
const toRequeue = []; // { entity_id, slug, title, dead: [serialIds] }
const toDelete = [];  // { id, slug, title, dead: [serialIds] }

for (const page of pages || []) {
  scanned++;
  if (page.manually_edited) { skippedManual++; continue; }
  if (page.notes && String(page.notes).trim().length > 0) { skippedNotes++; continue; }

  const cites = new Set();
  for (const m of String(page.content || "").matchAll(CITATION_RE)) {
    cites.add(Number(m[1]));
  }
  if (cites.size === 0) { cleanPages++; continue; }

  const dead = [...cites].filter((n) => !aliveSerialIds.has(n));
  if (dead.length === 0) { cleanPages++; continue; }

  stalePages++;
  // Decide what to do based on remaining link count
  const { count } = await sb
    .from("thought_entities")
    .select("thought_id", { count: "exact", head: true })
    .eq("entity_id", page.entity_id);
  const linked = count ?? 0;

  if (linked < min) {
    toDelete.push({ id: page.id, slug: page.slug, title: page.title, linked, dead });
  } else {
    toRequeue.push({ id: page.id, slug: page.slug, title: page.title, entity_id: page.entity_id, linked, dead });
  }
}

console.log("");
console.log(`Scanned ${scanned} pages: ${cleanPages} clean, ${stalePages} stale, ${skippedManual} manually-edited, ${skippedNotes} with notes.`);
console.log(`  → ${toDelete.length} to delete (entity below threshold)`);
console.log(`  → ${toRequeue.length} to re-queue for regeneration`);

const previewLimit = 15;
if (toDelete.length > 0) {
  console.log("\nWill DELETE these pages (entity has too few links):");
  for (const p of toDelete.slice(0, previewLimit)) {
    console.log(`  ${p.slug.padEnd(38)} (${p.linked} linked, ${p.dead.length} dead refs)`);
  }
  if (toDelete.length > previewLimit) console.log(`  ... and ${toDelete.length - previewLimit} more`);
}
if (toRequeue.length > 0) {
  console.log("\nWill RE-QUEUE these for regeneration:");
  for (const p of toRequeue.slice(0, previewLimit)) {
    console.log(`  ${p.slug.padEnd(38)} (${p.linked} linked, ${p.dead.length} dead refs)`);
  }
  if (toRequeue.length > previewLimit) console.log(`  ... and ${toRequeue.length - previewLimit} more`);
}

if (dryRun) {
  console.log("\n[dry-run] Re-run without --dry-run to apply.");
  process.exit(0);
}

if (toDelete.length === 0 && toRequeue.length === 0) {
  console.log("\nNothing to do.");
  process.exit(0);
}

// Delete in chunks
if (toDelete.length > 0) {
  const ids = toDelete.map((p) => p.id);
  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { error } = await sb.from("wiki_pages").delete().in("id", chunk);
    if (error) { console.error("delete chunk failed:", error.message); process.exit(1); }
  }
  console.log(`Deleted ${ids.length} stale wiki page${ids.length === 1 ? "" : "s"}.`);
}

// Re-queue: for each entity, find its most recently linked thought and queue it
if (toRequeue.length > 0) {
  let queued = 0;
  for (const p of toRequeue) {
    const { data: link } = await sb
      .from("thought_entities")
      .select("thought_id, thoughts(updated_at)")
      .eq("entity_id", p.entity_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const tid = link?.thought_id;
    if (!tid) continue;
    const { error } = await sb
      .from("entity_extraction_queue")
      .upsert(
        {
          thought_id: tid,
          status: "pending",
          attempt_count: 0,
          last_error: null,
          queued_at: new Date().toISOString(),
        },
        { onConflict: "thought_id" },
      );
    if (error) { console.error(`re-queue failed for ${p.slug}:`, error.message); continue; }
    queued++;
  }
  console.log(`Re-queued ${queued} thought${queued === 1 ? "" : "s"} for wiki regeneration.`);
  console.log("The local worker will regenerate these wiki pages on its next polls.");
}
