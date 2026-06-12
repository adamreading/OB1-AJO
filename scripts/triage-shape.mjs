// Inventory the 70 pending + 102 actions to design a triage pass.
// Output: distribution by entity, by age, by content-shape signal,
// and a sample from each bucket so we can see what we're actually dealing with.

import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const { data: pending } = await sb
  .from("thoughts")
  .select("id, serial_id, type, classification, metadata, source_type, created_at, content")
  .filter("metadata->>review_status", "eq", "pending_review")
  .order("created_at", { ascending: false });

const { data: actionThoughts } = await sb
  .from("thoughts")
  .select("id, serial_id, type, status, metadata, created_at, content, classification")
  .not("metadata->action_items", "is", null)
  .order("created_at", { ascending: false })
  .limit(500);
const acts = (actionThoughts || []).filter(t => Array.isArray(t.metadata?.action_items) && t.metadata.action_items.length > 0);

// Pull entities per thought for both sets
const ids = [...new Set([...(pending || []).map(t => t.id), ...acts.map(t => t.id)])];
const { data: links } = await sb.from("thought_entities").select("thought_id, entity_id").in("thought_id", ids);
const entIds = [...new Set((links || []).map(l => l.entity_id))];
const { data: ents } = await sb.from("entities").select("id, canonical_name, entity_type").in("id", entIds);
const entById = new Map((ents || []).map(e => [e.id, e]));
const thoughtEnts = new Map();
for (const l of links || []) {
  if (!thoughtEnts.has(l.thought_id)) thoughtEnts.set(l.thought_id, []);
  thoughtEnts.get(l.thought_id).push(entById.get(l.entity_id));
}

// Active kanban projects -- to test "is this action relevant to active work"
const { data: kanban } = await sb
  .from("thoughts")
  .select("metadata, status")
  .in("status", ["active", "planning"]);
const activeTags = new Set();
for (const t of kanban || []) {
  const tag = String(t.metadata?.topics?.[0] || "").toLowerCase();
  if (tag) activeTags.add(tag);
}

console.log(`\n=== ACTIVE KANBAN TAGS (${activeTags.size}) ===`);
console.log([...activeTags].join(", "));

// === PENDING REVIEW ===
console.log(`\n\n=== PENDING REVIEW (${pending?.length || 0}) ===\n`);

const pBuckets = { newsletter: [], plaud_task: [], plaud_decision: [], plaud_reference: [], plaud_observation: [], other: [] };
for (const t of pending || []) {
  if (t.type === "newsletter") pBuckets.newsletter.push(t);
  else if (t.type === "task") pBuckets.plaud_task.push(t);
  else if (t.type === "decision") pBuckets.plaud_decision.push(t);
  else if (t.type === "reference") pBuckets.plaud_reference.push(t);
  else if (t.type === "observation") pBuckets.plaud_observation.push(t);
  else pBuckets.other.push(t);
}

for (const [k, list] of Object.entries(pBuckets)) {
  if (list.length === 0) continue;
  console.log(`\n--- ${k.toUpperCase()} (${list.length}) ---`);
  for (const t of list.slice(0, 5)) {
    const entNames = (thoughtEnts.get(t.id) || []).slice(0, 4).map(e => `${e?.canonical_name}/${e?.entity_type}`).join(", ");
    const preview = String(t.content || "").replace(/\s+/g, " ").slice(0, 140);
    console.log(`  #${t.serial_id} (${t.classification}) ents=[${entNames}]`);
    console.log(`     ${preview}`);
  }
  if (list.length > 5) console.log(`  ... ${list.length - 5} more`);
}

// === ACTION ITEMS ===
console.log(`\n\n=== ACTION ITEMS (${acts.length} thoughts, ${acts.reduce((n, t) => n + t.metadata.action_items.length, 0)} items) ===\n`);

// Flatten into individual action items with provenance + entity tags + active-match
const flatActions = [];
for (const t of acts) {
  const tagNames = (thoughtEnts.get(t.id) || []).map(e => e?.canonical_name?.toLowerCase() || "");
  const touchesActive = tagNames.some(n => activeTags.has(n));
  for (const item of t.metadata.action_items) {
    flatActions.push({
      thought_serial: t.serial_id,
      thought_type: t.type,
      action: item,
      entities: (thoughtEnts.get(t.id) || []).map(e => e?.canonical_name).filter(Boolean),
      touchesActive,
      created_at: t.created_at,
      ageDays: Math.floor((Date.now() - new Date(t.created_at).getTime()) / 86400000),
    });
  }
}

// Bucketing heuristics
const stale = flatActions.filter(a => a.ageDays > 14);
const notActive = flatActions.filter(a => !a.touchesActive && a.ageDays <= 14);
const onActive = flatActions.filter(a => a.touchesActive);

console.log(`Action buckets:`);
console.log(`  Touches active kanban entity:  ${onActive.length}`);
console.log(`  Not on active kanban, <=14d:   ${notActive.length}`);
console.log(`  Stale (>14d):                  ${stale.length}`);

console.log(`\n--- SAMPLE: on active kanban (${onActive.length}) ---`);
for (const a of onActive.slice(0, 10)) {
  console.log(`  [#${a.thought_serial} ${a.ageDays}d ents=${a.entities.slice(0,3).join("|")}] ${a.action.slice(0, 120)}`);
}

console.log(`\n--- SAMPLE: NOT on active kanban (${notActive.length}) ---`);
for (const a of notActive.slice(0, 10)) {
  console.log(`  [#${a.thought_serial} ${a.ageDays}d ents=${a.entities.slice(0,3).join("|")}] ${a.action.slice(0, 120)}`);
}

console.log(`\n--- SAMPLE: stale >14d (${stale.length}) ---`);
for (const a of stale.slice(0, 10)) {
  console.log(`  [#${a.thought_serial} ${a.ageDays}d ents=${a.entities.slice(0,3).join("|")}] ${a.action.slice(0, 120)}`);
}
