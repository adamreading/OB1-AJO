#!/usr/bin/env node
/**
 * Newsletter cleanup — retrofit existing brain for the newsletter entity type.
 *
 * Before the new entity-type/relation rules shipped, Cowork-captured
 * newsletter articles produced bad data:
 *   - Publications were classified as `person` or `organization`, with
 *     the publication name stored as an alias on the author's entity.
 *   - The worker emitted co_occurs_with / evaluates / integrates_with
 *     edges between the publication (or author) and the user's own
 *     projects, because they appeared in the same thought.
 *   - The wiki then narrated those edges as if the newsletter author
 *     was collaborating on the user's projects.
 *
 * This script does a one-shot retrofit:
 *   1. Identify newsletter-pattern thoughts (Pattern A or B).
 *   2. Set type=newsletter, classification=personal on each.
 *   3. Extract publication names from the content.
 *   4. Create newsletter entities for each distinct publication.
 *   5. For each newsletter, find the author (if a person entity exists
 *      under a related name) and emit a published_by edge.
 *   6. Find existing edges where the newsletter entity (or its author)
 *      is incorrectly the source/target of a working-relationship edge
 *      with a user-owned project/tool. Add those edges to
 *      edge_blocklist + delete them.
 *   7. Re-queue the affected thoughts for re-extraction so the worker's
 *      newsletter rules apply.
 *   8. Mark survivor wiki pages stale.
 *
 * Usage:
 *   node --env-file=.env scripts/newsletter-cleanup.mjs              # dry-run
 *   node --env-file=.env scripts/newsletter-cleanup.mjs --apply --yes
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.OPEN_BRAIN_URL;
const BRAIN_KEY = process.env.SUPABASE_KEY || process.env.OPEN_BRAIN_SERVICE_KEY;
if (!SUPABASE_URL || !BRAIN_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_KEY");
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, BRAIN_KEY);
const API_BASE = `${SUPABASE_URL}/functions/v1/rest-api`;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const YES = args.includes("--yes") || args.includes("-y");
const VERBOSE = args.includes("--verbose") || args.includes("-v");

// ─── Known publications + their authors ──────────────────────────────
// Curated list — extend as new newsletters appear. The script also
// matches by content pattern, so unknown publications get extracted
// even if not listed here; this map just gives high-quality
// author-attribution for the ones we know about.
const KNOWN_PUBLICATIONS = [
  { canonical: "Nate's Newsletter",        author: "Nate Jones",   author_aliases: ["Nate B. Jones", "Nate B Jones", "Nate"] },
  { canonical: "Ken Huang's Substack",     author: "Ken Huang",    author_aliases: ["Ken Huang"] },
  { canonical: "Claude Notebook",          author: null,           author_aliases: [] },
  { canonical: "OpenClaw",                 author: null,           author_aliases: [] },
  { canonical: "Excellent Prompts",        author: "Lea",          author_aliases: ["Lea"] },
  { canonical: "Sourcery",                 author: "Molly O'Shea", author_aliases: ["Molly O'Shea"] },
];

// A detected publication name is only WORTH CREATING as a newsletter
// entity if it looks like a real publication. The pattern catches:
//   - Anything matching a KNOWN_PUBLICATIONS canonical (or near variant)
//   - Names ending in "Newsletter" or "Substack"
//   - Two-word brand-style names (no commas, no dates, no roles)
// Reject:
//   - Names containing article titles (long, contains dates, etc.)
//   - Names with " et al." (article author attribution leak)
//   - Names matching "X × Y" (cross-discussion attribution leak)
function isWorthCreatingAsNewsletter(name) {
  const t = name.trim();
  if (!t || t.length > 60) return false;
  if (/\bet al\b/i.test(t)) return false;
  if (/\s[×x]\s/.test(t)) return false;            // "Nate × Tibo"
  if (/\b\d{4}\b/.test(t)) return false;           // contains a year
  if (/\b\d{1,2}\s+[A-Z][a-z]+\b/.test(t)) return false; // "8 May" date
  if (/[—–]/.test(t)) return false;                // em/en dash — likely article subtitle
  if (KNOWN_PUBLICATIONS.some((p) => p.canonical.toLowerCase() === t.toLowerCase())) return true;
  if (/\b(Newsletter|Substack)\b/i.test(t)) return true;
  return false;
}

// ─── Pattern detection ───────────────────────────────────────────────

// Pattern A: starts with "Newsletter — <Pub> /" (verbatim header form)
const PATTERN_A = /^\s*\**\s*Newsletter\s*[—–-]\s*([^\/\n]+?)\s*[\/\.]/i;

// Pattern B: distilled insight title followed by "(<Pub>, <Date>)" near the top
// We restrict to first 400 chars to avoid matching mid-thought parenthetical references.
const PATTERN_B = /\(\s*([^,\)\n]+?)\s*,\s*(?:\d{1,2}\s+[A-Z][a-z]+\s+\d{4}|\d{4}-\d{2}-\d{2}|Chapter\s*\d+|Part\s*\d+|[A-Z][a-z]+\s+\d{1,2},?\s*\d{4})/;

// Pattern C: content explicitly mentions "Source: <text>substack.com" — strong signal
const PATTERN_C = /Source:\s*([^\(\n]+?)\s*\(([^)]*substack\.com[^)]*)\)/i;

function detectNewsletter(content) {
  const head = String(content || "").slice(0, 600);
  let pubName = null;
  let pattern = null;
  let m;
  if ((m = head.match(PATTERN_A))) {
    pubName = m[1].trim();
    pattern = "A";
  } else if ((m = head.match(PATTERN_C))) {
    pubName = m[1].trim();
    pattern = "C";
  } else if ((m = head.match(PATTERN_B))) {
    pubName = m[1].trim();
    pattern = "B";
    // Pattern B is noisier — only accept if the captured name looks like
    // a publication (no spaces-with-digits, not a person's full name unless
    // it matches a known author).
    const looksLikeJunk = /\b\d{4}\b/.test(pubName) || pubName.length > 60;
    if (looksLikeJunk) { pubName = null; pattern = null; }
  }
  return pubName ? { pubName, pattern } : null;
}

// Normalise a captured pub name to the canonical form if it matches a known one
function canonicalisePub(rawName) {
  const lower = rawName.toLowerCase().trim();
  for (const p of KNOWN_PUBLICATIONS) {
    if (p.canonical.toLowerCase() === lower) return p;
    // Match the author name as a publication alias (e.g. "Ken Huang" → Ken Huang's Substack)
    for (const a of p.author_aliases) {
      if (a.toLowerCase() === lower) return p;
    }
  }
  // Match common variants — "OpenClaw Newsletter" → "OpenClaw"; "Excellent Prompts" → keep
  for (const p of KNOWN_PUBLICATIONS) {
    if (lower.includes(p.canonical.toLowerCase())) return p;
  }
  // Match "X / Y" — pick the longer half as canonical
  if (rawName.includes(" / ")) {
    const halves = rawName.split(" / ").map((s) => s.trim());
    const longer = halves.sort((a, b) => b.length - a.length)[0];
    for (const p of KNOWN_PUBLICATIONS) {
      if (longer.toLowerCase() === p.canonical.toLowerCase()) return p;
    }
  }
  // Unknown publication — return as-is
  return { canonical: rawName, author: null, author_aliases: [] };
}

// ─── 1. Identify newsletter thoughts ─────────────────────────────────

async function findNewsletterThoughts() {
  // Broad DB filter that catches Pattern A (starts with Newsletter —),
  // Pattern C (substack.com URL), AND Pattern B (insight title followed
  // by "(<Publication>, <Date>)" near the top). Pattern B can't be cheap
  // ilike-matched, so we pull anything containing one of the known
  // publication-name fragments OR a date-in-parens shape, then let the
  // detection function decide.
  const orFilters = [
    "content.ilike.Newsletter —%",
    "content.ilike.%substack.com%",
    "content.ilike.%Newsletter%",
    "content.ilike.%Substack%",
    // Known publications by name + author surname
    "content.ilike.%Nate's Newsletter%",
    "content.ilike.%Ken Huang%",
    "content.ilike.%Claude Notebook%",
    "content.ilike.%OpenClaw%",
    "content.ilike.%Excellent Prompts%",
    "content.ilike.%Molly O'Shea%",
    "content.ilike.%Sourcery%",
    "content.ilike.%Philippa Hardman%",
    "content.ilike.%Ruben Hassid%",
  ].join(",");
  const { data, error } = await sb
    .from("thoughts")
    .select("id, serial_id, type, classification, content, metadata")
    .or(orFilters)
    .limit(5000);
  if (error) throw error;
  const matches = [];
  for (const t of data || []) {
    const detected = detectNewsletter(t.content);
    if (!detected) continue;
    const pub = canonicalisePub(detected.pubName);
    matches.push({ ...t, detected_pub: pub, pattern: detected.pattern });
  }
  return matches;
}

// ─── 2. Reclassify thoughts ──────────────────────────────────────────

async function reclassifyThoughts(thoughts) {
  let ok = 0, skip = 0;
  for (const t of thoughts) {
    const alreadyOk = t.type === "newsletter" && t.classification === "personal";
    if (alreadyOk) { skip++; continue; }
    if (!APPLY) { ok++; continue; }
    const { error } = await sb
      .from("thoughts")
      .update({
        type: "newsletter",
        classification: "personal",
        metadata: { ...(t.metadata ?? {}), classification: "personal" },
      })
      .eq("id", t.id);
    if (error) {
      console.error(`  reclassify #${t.serial_id} failed: ${error.message}`);
      continue;
    }
    ok++;
  }
  return { ok, skip };
}

// ─── 3+4. Ensure newsletter + author entities exist ──────────────────

// Find an existing entity by canonical name (exact, any type).
async function findEntityByCanonicalName(canonicalName) {
  const normalized = canonicalName.trim().toLowerCase().replace(/\s+/g, " ");
  const { data } = await sb
    .from("entities")
    .select("id, entity_type, canonical_name, aliases")
    .eq("normalized_name", normalized)
    .maybeSingle();
  return data ?? null;
}

// Find an entity of a specific type whose canonical OR alias matches any
// of the candidates. Used for AUTHOR lookup — finds "Nate" person when
// candidates include "Nate Jones" or "Nate B Jones".
async function findEntityByAliasOfType(candidates, entityType) {
  const lowers = candidates.map((a) => a.toLowerCase());
  const { data: matches } = await sb
    .from("entities")
    .select("id, entity_type, canonical_name, aliases, normalized_name")
    .eq("entity_type", entityType);
  for (const e of matches || []) {
    if (lowers.includes(e.normalized_name)) return e;
    if (Array.isArray(e.aliases)) {
      const a = e.aliases.map((s) => s.toLowerCase());
      for (const cand of lowers) if (a.includes(cand)) return e;
    }
  }
  return null;
}

async function ensureEntity(canonicalName, entityType, aliasCandidates = []) {
  // Step 1: canonical-name match (any type) — if found wrong-type, reclassify
  // Step 2: alias-of-correct-type fallback (only relevant when aliasCandidates passed)
  let existing = await findEntityByCanonicalName(canonicalName);
  if (!existing && aliasCandidates.length > 0) {
    existing = await findEntityByAliasOfType([canonicalName, ...aliasCandidates], entityType);
  }
  if (existing) {
    if (existing.entity_type !== entityType) {
      // Convert (e.g. person → newsletter for a misclassified one)
      if (!APPLY) {
        console.log(`  would change #${existing.id} "${existing.canonical_name}" from ${existing.entity_type} → ${entityType}`);
        return existing;
      }
      const res = await fetch(`${API_BASE}/entities/${existing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-brain-key": BRAIN_KEY },
        body: JSON.stringify({ entity_type: entityType }),
      });
      if (!res.ok) console.error(`  PATCH ${existing.id} failed: ${res.status}`);
      else console.log(`  reclassified #${existing.id} "${existing.canonical_name}" → ${entityType}`);
    }
    return existing;
  }
  if (!APPLY) {
    console.log(`  would CREATE ${entityType} entity: "${canonicalName}"`);
    return null;
  }
  const normalized = canonicalName.trim().toLowerCase().replace(/\s+/g, " ");
  const { data: created, error } = await sb
    .from("entities")
    .insert({ canonical_name: canonicalName, normalized_name: normalized, entity_type: entityType, aliases: [] })
    .select("id, entity_type, canonical_name, aliases")
    .single();
  if (error) { console.error(`  create "${canonicalName}" failed: ${error.message}`); return null; }
  console.log(`  created ${entityType} #${created.id} "${canonicalName}"`);
  return created;
}

async function removeAliasFromEntity(entityId, alias) {
  if (!APPLY) return;
  const { data: cur } = await sb.from("entities").select("aliases").eq("id", entityId).single();
  const aliases = (cur?.aliases ?? []).filter((a) => a.toLowerCase() !== alias.toLowerCase());
  await sb.from("entities").update({ aliases }).eq("id", entityId);
}

async function ensurePublishedByEdge(newsletterId, authorId) {
  // Use the worker's edges table directly
  const { data: existing } = await sb
    .from("edges")
    .select("id")
    .eq("from_entity_id", newsletterId)
    .eq("to_entity_id", authorId)
    .eq("relation", "published_by")
    .maybeSingle();
  if (existing) return;
  if (!APPLY) {
    console.log(`  would CREATE edge: newsletter #${newsletterId} --published_by--> person #${authorId}`);
    return;
  }
  const { error } = await sb.from("edges").insert({
    from_entity_id: newsletterId,
    to_entity_id: authorId,
    relation: "published_by",
    support_count: 1,
    confidence: 1.0,
  });
  if (error) console.error(`  published_by edge failed: ${error.message}`);
  else console.log(`  created published_by edge: #${newsletterId} → #${authorId}`);
}

// ─── 5. Remove bad edges where newsletter participates incorrectly ────

const NEWSLETTER_BAD_RELATIONS = new Set([
  "works_on", "uses", "uses_tool", "evaluates", "integrates_with",
  "alternative_to", "collaborates_with", "member_of", "located_in",
  "related_to", "co_occurs_with",
]);

async function removeBadEdges(newsletterEntityIds) {
  if (newsletterEntityIds.length === 0) return 0;
  const ids = newsletterEntityIds;
  const { data: edgesOut } = await sb
    .from("edges")
    .select("id, from_entity_id, to_entity_id, relation")
    .in("from_entity_id", ids);
  const { data: edgesIn } = await sb
    .from("edges")
    .select("id, from_entity_id, to_entity_id, relation")
    .in("to_entity_id", ids);
  const seen = new Set();
  const candidates = [];
  for (const e of [...(edgesOut ?? []), ...(edgesIn ?? [])]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    // Skip published_by + references (the only legit relations for newsletters)
    if (e.relation === "published_by" || e.relation === "references") continue;
    if (NEWSLETTER_BAD_RELATIONS.has(e.relation)) candidates.push(e);
  }
  if (candidates.length === 0) return 0;
  if (!APPLY) {
    console.log(`  would DELETE ${candidates.length} bad newsletter edges`);
    for (const e of candidates.slice(0, 8)) {
      console.log(`    #${e.id}: ${e.from_entity_id} --${e.relation}--> ${e.to_entity_id}`);
    }
    if (candidates.length > 8) console.log(`    …and ${candidates.length - 8} more`);
    return candidates.length;
  }
  const { error } = await sb.from("edges").delete().in("id", candidates.map((e) => e.id));
  if (error) console.error(`  edge delete failed: ${error.message}`);
  return candidates.length;
}

// ─── 6. Re-queue thoughts for extraction ─────────────────────────────

async function requeueExtraction(thoughtIds) {
  if (thoughtIds.length === 0) return 0;
  if (!APPLY) return thoughtIds.length;
  const nowIso = new Date().toISOString();
  const rows = thoughtIds.map((thought_id) => ({
    thought_id,
    status: "pending",
    attempt_count: 0,
    last_error: null,
    queued_at: nowIso,
  }));
  const { error } = await sb.from("entity_extraction_queue").upsert(rows, { onConflict: "thought_id" });
  if (error) { console.error(`  requeue failed: ${error.message}`); return 0; }
  return rows.length;
}

// ─── 7. Mark wiki pages stale for affected entities ──────────────────

async function markWikisStale(entityIds) {
  if (entityIds.length === 0 || !APPLY) return 0;
  const { error, count } = await sb
    .from("wiki_pages")
    .update({ generated_at: null }, { count: "exact" })
    .in("entity_id", entityIds);
  if (error) { console.error(`  wiki stale failed: ${error.message}`); return 0; }
  return count ?? 0;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(APPLY ? "MODE: APPLY" : "MODE: dry-run (use --apply --yes to execute)");
  console.log("");

  // Step 1: identify newsletter thoughts
  console.log("=== Step 1: identify newsletter thoughts ===");
  const thoughts = await findNewsletterThoughts();
  console.log(`Found ${thoughts.length} newsletter-pattern thoughts.`);
  const pubCounts = new Map();
  for (const t of thoughts) {
    const k = t.detected_pub.canonical;
    pubCounts.set(k, (pubCounts.get(k) ?? 0) + 1);
  }
  for (const [pub, count] of [...pubCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}x ${pub}`);
  }
  console.log("");

  if (APPLY && !YES) {
    console.log("--apply requires --yes to actually execute. Add it.");
    return;
  }

  // Step 2: reclassify thoughts
  console.log("=== Step 2: reclassify thoughts to type=newsletter, classification=personal ===");
  const r = await reclassifyThoughts(thoughts);
  console.log(`Reclassified ${r.ok} thoughts, ${r.skip} already correct.`);
  console.log("");

  // Step 3+4: ensure newsletter + author entities. Be conservative —
  // only create entities for publication names that pass the worth-it
  // gate. The other thoughts still get type=newsletter applied, and
  // the worker will create the right entities on re-extraction.
  console.log("=== Step 3+4: ensure newsletter + author entities ===");
  const pubsToProcess = [...pubCounts.keys()];
  const newsletterEntities = [];
  const skippedPubs = [];
  for (const pubName of pubsToProcess) {
    if (!isWorthCreatingAsNewsletter(pubName)) {
      skippedPubs.push(pubName);
      continue;
    }
    const known = KNOWN_PUBLICATIONS.find((p) => p.canonical === pubName);
    const newsletterEntity = await ensureEntity(pubName, "newsletter");
    if (!newsletterEntity) continue;
    newsletterEntities.push(newsletterEntity);
    if (known?.author) {
      const authorEntity = await ensureEntity(known.author, "person", known.author_aliases ?? []);
      if (authorEntity) {
        await ensurePublishedByEdge(newsletterEntity.id, authorEntity.id);
        // Strip the publication name + close variants from the author's aliases —
        // they shouldn't be conflated anymore.
        const aliasesToStrip = [pubName, ...(known.author_aliases ?? [])];
        if (Array.isArray(authorEntity.aliases)) {
          for (const strip of aliasesToStrip) {
            if (strip.toLowerCase() === known.author.toLowerCase()) continue; // don't strip the canonical itself
            if (authorEntity.aliases.some((a) => a.toLowerCase() === strip.toLowerCase()) && /(newsletter|substack)/i.test(strip)) {
              await removeAliasFromEntity(authorEntity.id, strip);
              if (APPLY) console.log(`  removed alias "${strip}" from person #${authorEntity.id}`);
            }
          }
        }
      }
    }
  }
  if (skippedPubs.length > 0) {
    console.log("");
    console.log(`Skipped ${skippedPubs.length} candidate publication names (not publication-shaped — worker will reprocess the thoughts):`);
    for (const s of skippedPubs) console.log(`  - "${s}"`);
  }
  console.log("");

  // Step 5: remove bad edges where newsletter participates incorrectly
  console.log("=== Step 5: remove bad newsletter edges ===");
  const newsletterIds = newsletterEntities.filter((e) => e?.id).map((e) => e.id);
  // Also include author entities so we strip edges like "Nate works_on Project X"
  const authorPersonIds = [];
  for (const pubName of pubsToProcess) {
    const known = KNOWN_PUBLICATIONS.find((p) => p.canonical === pubName);
    if (known?.author) {
      const normalized = known.author.toLowerCase();
      const { data } = await sb.from("entities").select("id").eq("normalized_name", normalized).maybeSingle();
      if (data?.id) authorPersonIds.push(data.id);
    }
  }
  const allTargets = [...new Set([...newsletterIds, ...authorPersonIds])];
  const removed = await removeBadEdges(allTargets);
  console.log(`${APPLY ? "Removed" : "Would remove"} ${removed} bad edges.`);
  console.log("");

  // Step 6: re-queue thoughts for extraction
  console.log("=== Step 6: re-queue affected thoughts for extraction ===");
  const tIds = thoughts.map((t) => t.id);
  const q = await requeueExtraction(tIds);
  console.log(`Re-queued ${q} thoughts.`);
  console.log("");

  // Step 7: mark affected wiki pages stale
  console.log("=== Step 7: mark wiki pages stale ===");
  // Wikis to invalidate: newsletter entities themselves + any entity touched
  // by a removed bad edge. For simplicity, just invalidate all newsletter
  // entity wikis and any wiki touched by a re-queued thought (worker handles).
  const staleCount = await markWikisStale(allTargets);
  console.log(`${APPLY ? "Marked" : "Would mark"} ${staleCount} wiki pages stale.`);
  console.log("");

  console.log(APPLY ? "✓ Cleanup complete. Brain worker will re-extract on next tick." : "✓ Dry-run complete. Re-run with --apply --yes.");
}

main().catch((err) => { console.error(err); process.exit(1); });
