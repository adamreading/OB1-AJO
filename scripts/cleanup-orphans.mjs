// Clean up two kinds of debris in the brain:
//   1. ORPHAN ENTITIES — entities with 0 linked thoughts (typically debris
//      from entity merges where source got deleted but a parallel reference
//      survived). These should never be in the graph.
//   2. STALE WIKIS — wiki pages whose host entity has <3 linked thoughts
//      (below the >3 threshold the user set). These produce hallucinated
//      content because there isn't enough evidence behind them.
//
// Dry-run by default. Pass --apply to commit. Pass --aggressive to also
// delete wikis where the entity has 1-2 thoughts (default keeps 1-2 thoughts
// as borderline). Safe: deletes only WIKI PAGE rows, never thoughts.

import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL || process.env.OPEN_BRAIN_URL;
const KEY = process.env.SUPABASE_KEY || process.env.OPEN_BRAIN_SERVICE_KEY;
const sb = createClient(URL, KEY);

async function pullAll(table, select) {
  const out = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb.from(table).select(select).range(from, from + 999);
    if (error || !data || data.length === 0) break;
    out.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

const entities = await pullAll("entities", "id, canonical_name, entity_type");
const links = await pullAll("thought_entities", "entity_id");
const wikiPages = await pullAll("wiki_pages", "slug, entity_id, generated_at");

const linkCount = new Map();
for (const l of links) linkCount.set(l.entity_id, (linkCount.get(l.entity_id) || 0) + 1);

console.log(`Brain inventory: ${entities.length} entities, ${links.length} thought_entity links, ${wikiPages.length} wiki pages\n`);

// 1) Orphan entities — zero linked thoughts
const orphans = entities.filter((e) => (linkCount.get(e.id) || 0) === 0);
console.log(`ORPHAN ENTITIES (0 thoughts): ${orphans.length}`);
const orphanIds = new Set(orphans.map((e) => e.id));

// Wikis attached to orphan entities — delete BEFORE the entity (FK is SET NULL but cleaner to drop)
const orphanWikis = wikiPages.filter((w) => w.entity_id && orphanIds.has(w.entity_id));
console.log(`  → wikis attached to orphan entities: ${orphanWikis.length}`);

// 2) Stale wikis — host entity has <3 linked thoughts (entity is real but below threshold)
const STALE_MAX = process.argv.includes("--aggressive") ? 2 : 2; // default keeps 3+ — change here if needed
const staleWikis = wikiPages.filter((w) => {
  if (!w.entity_id) return false;
  if (orphanIds.has(w.entity_id)) return false; // already counted in orphan bucket
  const n = linkCount.get(w.entity_id) || 0;
  return n > 0 && n <= STALE_MAX;
});
console.log(`STALE WIKIS (entity has 1-${STALE_MAX} thoughts): ${staleWikis.length}`);

// Show a handful so the user can sanity-check
console.log(`\nSample orphans:`);
for (const e of orphans.slice(0, 8)) console.log(`  #${e.id} ${e.canonical_name} (${e.entity_type})`);
console.log(`\nSample stale wikis:`);
for (const w of staleWikis.slice(0, 8)) {
  const ent = entities.find((e) => e.id === w.entity_id);
  console.log(`  ${w.slug}  ← ${ent?.canonical_name || "?"}  (${linkCount.get(w.entity_id) || 0} thoughts)`);
}

if (!process.argv.includes("--apply")) {
  console.log(`\nDry-run only. Pass --apply to commit.`);
  console.log(`  Would delete: ${orphans.length} entities, ${orphanWikis.length + staleWikis.length} wiki pages`);
  process.exit(0);
}

// Delete wikis first (FK from wiki_pages.entity_id is SET NULL but cleaner to drop the row outright)
const wikiSlugsToDrop = [...new Set([...orphanWikis.map((w) => w.slug), ...staleWikis.map((w) => w.slug)])];
console.log(`\nDeleting ${wikiSlugsToDrop.length} wiki pages...`);
let wikiOk = 0;
for (const slug of wikiSlugsToDrop) {
  const { error } = await sb.from("wiki_pages").delete().eq("slug", slug);
  if (error) console.log(`  FAIL ${slug}: ${error.message}`);
  else wikiOk++;
}
console.log(`  wiki rows deleted: ${wikiOk}`);

// Delete orphan entities
console.log(`Deleting ${orphans.length} orphan entities...`);
let entOk = 0, entFail = 0;
for (const e of orphans) {
  const { error } = await sb.from("entities").delete().eq("id", e.id);
  if (error) { entFail++; if (entFail <= 5) console.log(`  FAIL #${e.id} ${e.canonical_name}: ${error.message}`); }
  else entOk++;
}
console.log(`  entities deleted: ${entOk}, failed: ${entFail}`);

console.log(`\nDone.`);
