#!/usr/bin/env node
/**
 * Topic consolidation — surface variant clusters for review.
 *
 * Finds topic entities that look like variants of the same concept
 * (substring containment, Levenshtein distance, normalized-form match)
 * and prints them as clusters. The user picks one entity as canonical
 * and merges the rest into it via the dashboard's alias system, or
 * passes them on the CLI to do a programmatic merge.
 *
 * Usage:
 *   node --env-file=.env scripts/topic-consolidate.mjs                    # list clusters
 *   node --env-file=.env scripts/topic-consolidate.mjs --min-cluster 3    # only clusters of N+
 *   node --env-file=.env scripts/topic-consolidate.mjs --merge 1234 5678 9999
 *                                                                         # merge entities 5678 + 9999 INTO 1234
 *
 * Merge is performed via PATCH /entities/<canonical>/aliases with the
 * absorbed entity's canonical_name as a new alias. The Edge Function
 * absorbs the duplicate (moves its thought_entities + edges into the
 * survivor, deletes the duplicate, marks the wiki page stale).
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
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const MIN_CLUSTER = Number(flag("--min-cluster") ?? 2);

// ─── Cluster heuristics ────────────────────────────────────────────────

function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const prev = new Array(bl + 1);
  const cur = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= bl; j++) prev[j] = cur[j];
  }
  return prev[bl];
}

function clusterTopics(topics) {
  // Pre-index by normalized form so we don't recompute.
  const entries = topics.map((t) => ({
    id: t.id,
    name: t.canonical_name,
    norm: normalize(t.canonical_name),
  }));

  // Union-find for cluster building
  const parent = new Map(entries.map((e) => [e.id, e.id]));
  function find(x) {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j];
      // Same normalized form → definite match
      if (a.norm === b.norm) { union(a.id, b.id); continue; }
      // Substring containment, with reasonable lengths
      const longer = a.norm.length >= b.norm.length ? a.norm : b.norm;
      const shorter = a.norm.length < b.norm.length ? a.norm : b.norm;
      if (shorter.length >= 3 && longer.includes(shorter)) {
        // Make sure it's a meaningful containment, not just a common 3-char fragment
        // — require either: longer is at most 2x shorter, or shorter appears as a whole word
        const wordBoundary = new RegExp(`(^|\\s)${shorter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(longer);
        if (wordBoundary || longer.length <= shorter.length * 2) {
          union(a.id, b.id);
          continue;
        }
      }
      // Levenshtein for typo-style variants on short strings
      if (Math.max(a.norm.length, b.norm.length) <= 25) {
        const d = levenshtein(a.norm, b.norm);
        if (d <= 2 && d / Math.max(a.norm.length, b.norm.length) <= 0.2) {
          union(a.id, b.id);
        }
      }
    }
  }

  const clusters = new Map();
  for (const e of entries) {
    const r = find(e.id);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(e);
  }
  return Array.from(clusters.values()).filter((c) => c.length >= MIN_CLUSTER);
}

// ─── Merge implementation ──────────────────────────────────────────────

async function mergeEntities(canonicalId, dupeIds) {
  // Fetch canonical entity
  const { data: canonical, error: cErr } = await supabase
    .from("entities")
    .select("id, canonical_name")
    .eq("id", canonicalId)
    .maybeSingle();
  if (cErr || !canonical) {
    console.error(`Canonical entity #${canonicalId} not found: ${cErr?.message ?? ""}`);
    return;
  }

  for (const dupeId of dupeIds) {
    const { data: dupe } = await supabase
      .from("entities")
      .select("id, canonical_name")
      .eq("id", dupeId)
      .maybeSingle();
    if (!dupe) {
      console.error(`Dupe #${dupeId} not found, skipping`);
      continue;
    }
    console.log(`Adding "${dupe.canonical_name}" as alias of "${canonical.canonical_name}" (auto-absorbs)`);
    const res = await fetch(`${API_BASE}/entities/${canonicalId}/aliases`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-brain-key": BRAIN_KEY },
      body: JSON.stringify({ alias: dupe.canonical_name }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`  Failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
      continue;
    }
    const absorbed = body?.absorbed ?? [];
    console.log(`  → absorbed ${absorbed.length} entity(ies): ${absorbed.map((a) => `#${a.id} ${a.canonical_name}`).join(", ") || "(none — alias only)"}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  // --merge mode
  const mergeIdx = args.indexOf("--merge");
  if (mergeIdx >= 0) {
    const ids = args.slice(mergeIdx + 1).map(Number).filter(Number.isFinite);
    if (ids.length < 2) {
      console.error("--merge requires at least 2 entity ids: first is canonical, rest are merged into it");
      process.exit(1);
    }
    const [canonical, ...dupes] = ids;
    await mergeEntities(canonical, dupes);
    return;
  }

  // List mode
  console.log(`Fetching topics (min cluster size: ${MIN_CLUSTER})…`);
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

  const clusters = clusterTopics(topics);
  if (clusters.length === 0) {
    console.log("No variant clusters found.");
    return;
  }

  console.log(`\nFound ${clusters.length} variant clusters:\n`);
  clusters.sort((a, b) => b.length - a.length);
  for (const c of clusters) {
    // Pick the longest name as suggested canonical (usually the most specific)
    const suggested = c.slice().sort((a, b) => b.name.length - a.name.length)[0];
    console.log(`  Cluster (${c.length}):`);
    for (const e of c) {
      const marker = e.id === suggested.id ? "  ★" : "   ";
      console.log(`  ${marker} #${e.id}  ${e.name}`);
    }
    console.log(`     Merge: node scripts/topic-consolidate.mjs --merge ${suggested.id} ${c.filter((e) => e.id !== suggested.id).map((e) => e.id).join(" ")}`);
    console.log();
  }

  console.log("★ = suggested canonical (longest name). Review each cluster, then run the merge command if it's correct.");
  console.log("If the suggested canonical is wrong, swap arguments — first id is kept, rest become aliases.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
