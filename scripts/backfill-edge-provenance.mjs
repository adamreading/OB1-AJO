#!/usr/bin/env node
/**
 * backfill-edge-provenance.mjs — populate thought_entity_edges for the edges
 * that survived the reconcile pass.
 *
 * After Layer 2 migrations are applied, the `edges` table's support_count is
 * a derived aggregate of thought_entity_edges. With zero provenance rows,
 * the first time a worker re-processes any thought, the trigger will see
 * count=0 and delete the edge.
 *
 * This script seeds thought_entity_edges so existing edges have provenance
 * before the worker resumes. For each edge:
 *
 *   1. Find thoughts that mention BOTH endpoints (via thought_entities, then
 *      text-search fallback for ghost cases — same logic as reconcile-edges).
 *   2. Insert a thought_entity_edges row per supporting thought.
 *   3. The trigger recomputes support_count = count of inserted rows.
 *
 * If no supporting thoughts can be found AND the edge is pinned (either
 * endpoint), the edge is kept with support_count=0 (preserved by the trigger).
 * Otherwise the edge is deleted as a true ghost.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-edge-provenance.mjs --dry-run
 *   node --env-file=.env scripts/backfill-edge-provenance.mjs
 *
 * Run AFTER:
 *   - reconcile-edges.mjs --apply (clean edges)
 *   - 20260508000300_entity_pinning.sql + 20260508000400_thought_entity_edges.sql migrations applied
 * Run BEFORE: restarting the local-brain-worker with the new Layer 2 code.
 */
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const url = process.env.SUPABASE_URL || process.env.OPEN_BRAIN_URL;
const key = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL / SUPABASE_KEY required");
  process.exit(1);
}
const sb = createClient(url, key);

console.log(`Backfilling thought_entity_edges${dryRun ? " (dry-run)" : ""}...`);

const { data: edges, error: edgesErr } = await sb
  .from("edges")
  .select("id, from_entity_id, to_entity_id, relation, support_count, confidence");
if (edgesErr) { console.error("edges fetch failed:", edgesErr.message); process.exit(1); }
console.log(`Found ${edges.length} edges to backfill.`);

const entityCache = new Map();
async function getEntity(id) {
  if (entityCache.has(id)) return entityCache.get(id);
  const { data } = await sb.from("entities").select("id, canonical_name, aliases, pinned").eq("id", id).maybeSingle();
  entityCache.set(id, data);
  return data;
}

async function findSupportingThoughts(idA, idB, entityA, entityB) {
  // Primary: co-linked via thought_entities
  const { data: aLinks } = await sb.from("thought_entities").select("thought_id").eq("entity_id", idA);
  const { data: bLinks } = await sb.from("thought_entities").select("thought_id").eq("entity_id", idB);
  const aSet = new Set((aLinks || []).map((r) => r.thought_id));
  const both = (bLinks || []).map((r) => r.thought_id).filter((id) => aSet.has(id));
  if (both.length > 0) return both;

  // Fallback: text-search for both names (or aliases) in thought content
  const namesA = [entityA.canonical_name, ...(entityA.aliases || [])].filter(Boolean);
  const namesB = [entityB.canonical_name, ...(entityB.aliases || [])].filter(Boolean);
  if (namesA.length === 0 || namesB.length === 0) return [];
  const orA = namesA.map((n) => `content.ilike.%${n.replace(/[,%_]/g, "")}%`).join(",");
  const { data: candidates } = await sb.from("thoughts")
    .select("id, content")
    .or(orA)
    .limit(50);
  return (candidates || [])
    .filter((t) => {
      const c = String(t.content || "").toLowerCase();
      return namesB.some((n) => c.includes(n.toLowerCase()));
    })
    .map((t) => t.id);
}

let stats = { backfilled: 0, kept_pinned: 0, deleted: 0, total_provenance_rows: 0 };

for (let i = 0; i < edges.length; i++) {
  const e = edges[i];
  const [entityA, entityB] = await Promise.all([getEntity(e.from_entity_id), getEntity(e.to_entity_id)]);
  if (!entityA || !entityB) continue;

  const thoughtIds = await findSupportingThoughts(e.from_entity_id, e.to_entity_id, entityA, entityB);

  if (thoughtIds.length === 0) {
    const eitherPinned = entityA.pinned || entityB.pinned;
    if (eitherPinned) {
      stats.kept_pinned++;
      if ((i + 1) % 50 === 0) console.log(`  [${i + 1}/${edges.length}] ...`);
      continue;
    }
    stats.deleted++;
    if (!dryRun) {
      await sb.from("edges").delete().eq("id", e.id);
    }
    if (stats.deleted <= 10) {
      console.log(`  GHOST  ${entityA.canonical_name} ${e.relation} ${entityB.canonical_name} (no supporting thoughts, neither pinned)`);
    }
    continue;
  }

  if (!dryRun) {
    const rows = thoughtIds.map((tid) => ({
      thought_id: tid,
      from_entity_id: e.from_entity_id,
      to_entity_id: e.to_entity_id,
      relation: e.relation,
      confidence: e.confidence,
    }));
    // Plain insert — backfill iterates edges once so duplicates shouldn't occur.
    // If a conflict does happen, fall through and report.
    const { error } = await sb.from("thought_entity_edges").insert(rows);
    if (error) {
      // Tolerate the rare duplicate by retrying row-by-row, skipping conflicts.
      let recovered = 0;
      for (const row of rows) {
        const { error: e2 } = await sb.from("thought_entity_edges").insert(row);
        if (!e2) recovered++;
      }
      if (recovered === 0) {
        console.error(`  insert failed for edge #${e.id}: ${error.message}`);
        continue;
      }
    }
  }
  stats.backfilled++;
  stats.total_provenance_rows += thoughtIds.length;
  if ((i + 1) % 50 === 0) console.log(`  [${i + 1}/${edges.length}] backfilled ${stats.backfilled}, ghost+deleted ${stats.deleted}, kept pinned ${stats.kept_pinned}`);
}

console.log("");
console.log("— Summary —");
console.log(`  edges backfilled with provenance: ${stats.backfilled}`);
console.log(`  total provenance rows inserted   : ${stats.total_provenance_rows}`);
console.log(`  ghosts deleted (no support)      : ${stats.deleted}`);
console.log(`  ghosts kept (pinned endpoint)    : ${stats.kept_pinned}`);
if (dryRun) console.log("\n[dry-run] Re-run without --dry-run to apply.");
