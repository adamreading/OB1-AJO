#!/usr/bin/env node
/**
 * infer-entity-edges.mjs — cross-thought relationship inference per entity.
 *
 * The worker (local-brain-worker.js) extracts edges from one thought at a time.
 * That means relationships that are only ESTABLISHED across multiple thoughts
 * (e.g. Adam mentions Kate on Tuesday, mentions Taplow on Wednesday — both as
 * "we were home") never produce a Kate↔Taplow edge. The constellation graph
 * then routes everything through the user as a hub.
 *
 * This script reads ALL thoughts mentioning a target entity and asks an LLM
 * what high-confidence relationships that entity has to OTHER entities. New
 * edges are written DIRECTLY to the `edges` table (not thought_entity_edges)
 * with metadata.source='inferred' so they're distinguishable from per-thought
 * extractions. The dashboard renders them dashed.
 *
 * The script never touches an extracted edge — if any edge already exists for
 * the pair in either direction, the inference is skipped. Edge_blocklist is
 * also respected.
 *
 * Usage:
 *   node --env-file=.env scripts/infer-entity-edges.mjs --dry-run
 *   node --env-file=.env scripts/infer-entity-edges.mjs --apply
 *   node --env-file=.env scripts/infer-entity-edges.mjs --apply --entity-id 1234
 *   node --env-file=.env scripts/infer-entity-edges.mjs --apply --type person
 *   node --env-file=.env scripts/infer-entity-edges.mjs --apply --type person,place,organization --limit 50
 *
 * Defaults: --type person,place,organization, --min-thoughts 3
 *
 * Required env: SUPABASE_URL, SUPABASE_KEY
 * Optional env:
 *   OLLAMA_URL              default http://localhost:11434/api
 *   OLLAMA_API_KEY          bearer token for Ollama Cloud (omit for local)
 *   INFER_MODEL             default gpt-oss:120b-cloud,gemma4:26b,qwen3:30b
 *   INFER_RATE_MS           default 800ms between entities
 *   INFER_MAX_THOUGHTS      default 60 — cap on snippets per entity
 *   INFER_SNIPPET_CHARS     default 800 — chars per snippet
 *   INFER_MIN_CONFIDENCE    default 0.6 — drop suggestions below this
 */
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const apply = args.includes("--apply");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
const entityIdIdx = args.indexOf("--entity-id");
const entityIdFilter = entityIdIdx >= 0 ? Number(args[entityIdIdx + 1]) : null;
const typeIdx = args.indexOf("--type");
const typeArg = typeIdx >= 0 ? args[typeIdx + 1] : "person,place,organization";
const targetTypes = typeArg === "all" ? null : typeArg.split(",").map((s) => s.trim()).filter(Boolean);
const minThoughtsIdx = args.indexOf("--min-thoughts");
const minThoughts = minThoughtsIdx >= 0 ? Number(args[minThoughtsIdx + 1]) : 3;

if (!dryRun && !apply) {
  console.error("Specify --dry-run or --apply");
  process.exit(1);
}
if (dryRun && apply) {
  console.error("--dry-run and --apply are mutually exclusive");
  process.exit(1);
}

const url = process.env.SUPABASE_URL || process.env.OPEN_BRAIN_URL;
const key = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ollamaBase = (process.env.OLLAMA_URL || "http://localhost:11434/api").replace(/\/+$/, "");
const ollamaKey = process.env.OLLAMA_API_KEY || null;
const modelChain = (process.env.INFER_MODEL || "gpt-oss:120b-cloud,gemma4:26b,qwen3:30b")
  .split(",").map((s) => s.trim()).filter(Boolean);
const deadModels = new Set();
const rateMs = Number(process.env.INFER_RATE_MS || 800);
const MAX_THOUGHTS = Number(process.env.INFER_MAX_THOUGHTS || 60);
const SNIPPET_CHARS = Number(process.env.INFER_SNIPPET_CHARS || 800);
const MIN_CONFIDENCE = Number(process.env.INFER_MIN_CONFIDENCE || 0.6);

if (!url || !key) { console.error("SUPABASE_URL / SUPABASE_KEY required"); process.exit(1); }

const sb = createClient(url, key);

// Mirrors the worker's VALID_RELATIONS + SYMMETRIC_RELATIONS in
// scripts/local-brain-worker.js. Keep these in sync if the worker's taxonomy
// changes.
const VALID_RELATIONS = new Set([
  "works_on", "uses", "uses_tool", "collaborates_with", "integrates_with",
  "alternative_to", "evaluates", "member_of", "located_in", "related_to",
  "published_by", "references",
  "knew", "friend_of", "family_of", "mentor_of", "introduced_via",
  "lives_in", "is_part_of", // NEW — added for inferred personal/place edges
]);
const SYMMETRIC = new Set([
  "co_occurs_with", "related_to", "collaborates_with", "integrates_with", "alternative_to",
  "knew", "friend_of", "family_of",
]);

const SYSTEM_PROMPT = `You audit a personal knowledge graph for one ENTITY at a time. Given the entity's name and a list of thought snippets that mention it, extract HIGH-CONFIDENCE relationships from this entity to OTHER entities (people, places, organizations, projects, tools).

OUTPUT: JSON object with shape {"relationships": [{...}, ...]}. Each relationship is:
  {
    "related_entity_name": "<exact canonical name as it appears in the snippets>",
    "relation": "<one of the taxonomy below>",
    "direction": "out" | "in",   // out = ENTITY → related; in = related → ENTITY
    "confidence": 0.0–1.0,
    "evidence_thought_serial_id": <integer from [#N] tag in snippet>,
    "reason": "<one short sentence quoting from the evidence>"
  }

TAXONOMY (pick the MOST SPECIFIC one that applies):
- works_on          person/org → project (actively building/owning)
- uses              person/org → tool/technology
- collaborates_with person ↔ person (symmetric, work context)
- integrates_with   tool ↔ tool (symmetric)
- evaluates         person → tool/project/idea (assessing for adoption)
- member_of         person → organization (NOT place)
- located_in        org/place → place
- lives_in          person → place (residential — home, hometown, where they live)
- is_part_of        place → place (e.g. neighbourhood → town)
- related_to        topic ↔ topic (weak — last resort)
- published_by      newsletter → person (author)
- references        any → newsletter (citation)
- knew              person ↔ person (symmetric, weak default for "they knew each other")
- friend_of         person ↔ person (symmetric, close personal)
- family_of         person ↔ person (symmetric, relative: spouse, parent, sibling, child)
- mentor_of         person → person (taught/guided)
- introduced_via    person → org/place (community where they met someone)

CRITICAL RULES:
1. Direction matters. For directional relations, set "direction" correctly. For symmetric relations (collaborates_with, integrates_with, knew, friend_of, family_of, related_to), direction is irrelevant — set to "out".
2. NEGATION IS DISPOSITIVE. If a snippet says "X is NOT working with Y" or "they stopped collaborating", do NOT emit that relation.
3. BUILDERS ≠ EVALUATORS. People who built/own a project are works_on, not evaluates.
4. AUDITORS / USERS ≠ EVALUATORS. End users of a system are uses (or omit), not evaluates.
5. Only emit a relation if the snippets EXPLICITLY support it. Do not infer from mere co-occurrence — that's the worker's job, not yours.
6. Minimum confidence 0.65 for directional relations. Below that, omit.
7. related_entity_name must EXACTLY match (case-insensitive) a name that appears in the snippets. Don't invent names. If the entity isn't mentioned by name in the snippets, omit.
8. Skip relations to the user themselves (Adam Ososki / Adam) — those already exist trivially.
9. Output ONLY the JSON object — no prose, no code fences, no commentary.

The snippets are tagged [#N] where N is the thought's serial_id. Use that exact integer in evidence_thought_serial_id.`;

async function callLLMOnce(modelName, userPrompt, attemptHint) {
  const headers = { "Content-Type": "application/json" };
  if (ollamaKey) headers["Authorization"] = `Bearer ${ollamaKey}`;
  const fullPrompt = `${SYSTEM_PROMPT}\n\n/no_think\n\n${userPrompt}\n\nReturn ONLY a single JSON object with a "relationships" array. No prose, no code fences.${attemptHint || ""}`;
  const res = await fetch(`${ollamaBase}/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelName,
      prompt: fullPrompt,
      stream: false,
      format: "json",
      options: { temperature: 0.1, num_predict: 2048, num_ctx: 32768 },
    }),
  });
  if (!res.ok) {
    const txt = (await res.text()).slice(0, 300);
    const err = new Error(`Ollama ${res.status}: ${txt}`);
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  const raw = String(body?.response || body?.thinking || "").trim();
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON object in LLM response: ${cleaned.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

async function callLLM(userPrompt) {
  const errors = [];
  for (const modelName of modelChain) {
    if (deadModels.has(modelName)) continue;
    try {
      const result = await callLLMOnce(modelName, userPrompt, "");
      return { result, modelUsed: modelName };
    } catch (err) {
      if (!err.status) {
        try {
          const result = await callLLMOnce(modelName, userPrompt,
            "\n\nReminder: output ONLY {\"relationships\": [...]} as a single line of JSON.");
          return { result, modelUsed: modelName };
        } catch (err2) {
          errors.push(`${modelName}: ${err2.message}`);
          continue;
        }
      }
      if (err.status === 429 || err.status >= 500 || err.status === 401 || err.status === 403) {
        if (!deadModels.has(modelName)) {
          console.log(`[fallback] ${modelName} returned ${err.status} — falling back to next model for the rest of this run.`);
          deadModels.add(modelName);
        }
        errors.push(`${modelName}: ${err.message}`);
        continue;
      }
      errors.push(`${modelName}: ${err.message}`);
    }
  }
  throw new Error(`All models failed:\n  ${errors.join("\n  ")}`);
}

async function fetchTargetEntities() {
  if (entityIdFilter) {
    const { data, error } = await sb
      .from("entities")
      .select("id, canonical_name, entity_type, aliases")
      .eq("id", entityIdFilter)
      .maybeSingle();
    if (error || !data) {
      console.error(`Entity #${entityIdFilter} not found`);
      process.exit(1);
    }
    return [data];
  }
  // Filter by type AND require at least min_thoughts linked thoughts. Done as
  // two queries: pull candidate entities, then for each get count of
  // thought_entities rows. With ~650 entities this is fine; for a bigger brain
  // we'd push this into an RPC.
  let q = sb.from("entities").select("id, canonical_name, entity_type, aliases").order("id", { ascending: true });
  if (targetTypes && targetTypes.length > 0) q = q.in("entity_type", targetTypes);
  const { data: candidates, error } = await q;
  if (error) { console.error("Entity fetch failed:", error.message); process.exit(1); }
  const filtered = [];
  for (const e of candidates || []) {
    const { count } = await sb
      .from("thought_entities")
      .select("thought_id", { count: "exact", head: true })
      .eq("entity_id", e.id);
    if ((count || 0) >= minThoughts) {
      filtered.push({ ...e, _thought_count: count });
    }
    if (filtered.length >= limit) break;
  }
  return filtered;
}

async function fetchEntityThoughts(entityId) {
  // Pull thought IDs for this entity, then fetch the thoughts. Ordered by
  // most recent so the snippet pool favours current context.
  const { data: links } = await sb
    .from("thought_entities")
    .select("thought_id")
    .eq("entity_id", entityId)
    .limit(MAX_THOUGHTS * 2); // overfetch to allow stable ordering after thought-join
  const thoughtIds = (links || []).map((r) => r.thought_id);
  if (thoughtIds.length === 0) return [];
  const { data: thoughts } = await sb
    .from("thoughts")
    .select("id, serial_id, content, created_at, metadata")
    .in("id", thoughtIds)
    .order("created_at", { ascending: false })
    .limit(MAX_THOUGHTS);
  return thoughts || [];
}

function buildUserPrompt(entity, thoughts) {
  const aliases = (entity.aliases || []).join(", ") || "—";
  const lines = [
    `ENTITY: "${entity.canonical_name}" (${entity.entity_type})`,
    `Aliases: ${aliases}`,
    "",
    `THOUGHT SNIPPETS (${thoughts.length}):`,
    "",
  ];
  for (const t of thoughts) {
    const snippet = String(t.content || "").replace(/\s+/g, " ").slice(0, SNIPPET_CHARS);
    lines.push(`[#${t.serial_id}] ${snippet}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function resolveRelatedEntity(name) {
  // Use search_entities RPC — alias-aware ilike on canonical_name + aliases.
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  const { data, error } = await sb.rpc("search_entities", { p_search: trimmed, p_limit: 5 });
  if (error || !data || data.length === 0) return null;
  // Prefer exact canonical_name match (case-insensitive); otherwise return null
  // if ambiguous to avoid mis-merging.
  const exact = data.find((r) => String(r.canonical_name || "").toLowerCase() === trimmed.toLowerCase());
  if (exact) return exact;
  if (data.length === 1) return data[0];
  return { ambiguous: true, candidates: data };
}

function normalizePair(idA, idB, relation) {
  if (SYMMETRIC.has(relation) && idA > idB) return { from: idB, to: idA };
  return { from: idA, to: idB };
}

async function edgeExists(fromId, toId, relation) {
  // Check both directions regardless of relation symmetry — extracted edges
  // always win, so if ANY edge exists for the pair we skip.
  const lo = Math.min(fromId, toId);
  const hi = Math.max(fromId, toId);
  const [a, b] = await Promise.all([
    sb.from("edges").select("id, relation, metadata").eq("from_entity_id", lo).eq("to_entity_id", hi).maybeSingle(),
    sb.from("edges").select("id, relation, metadata").eq("from_entity_id", hi).eq("to_entity_id", lo).maybeSingle(),
  ]);
  return Boolean(a.data) || Boolean(b.data);
}

async function isBlocklisted(fromId, toId, relation) {
  const { from, to } = normalizePair(fromId, toId, relation);
  const { data } = await sb
    .from("edge_blocklist")
    .select("relation")
    .eq("from_entity_id", from)
    .eq("to_entity_id", to)
    .eq("relation", relation)
    .maybeSingle();
  return !!data;
}

async function processEntity(entity, idx, total) {
  const thoughts = await fetchEntityThoughts(entity.id);
  if (thoughts.length === 0) {
    console.log(`[${idx}/${total}] #${entity.id} ${entity.canonical_name} — no thoughts, skip`);
    return { skipped: true };
  }

  const userPrompt = buildUserPrompt(entity, thoughts);

  let result, modelUsed;
  try {
    ({ result, modelUsed } = await callLLM(userPrompt));
  } catch (err) {
    console.log(`[${idx}/${total}] #${entity.id} ${entity.canonical_name} — LLM error: ${err.message}`);
    return { error: true };
  }

  const relationships = Array.isArray(result?.relationships) ? result.relationships : [];
  console.log(`[${idx}/${total}] #${entity.id} ${entity.canonical_name} (${entity.entity_type}) [${modelUsed}] — ${relationships.length} suggestion(s) from ${thoughts.length} thoughts`);

  const stats = { proposed: 0, written: 0, skipped_low_conf: 0, skipped_no_match: 0, skipped_ambiguous: 0, skipped_existing: 0, skipped_blocklisted: 0, skipped_invalid: 0, errors: 0 };

  for (const rel of relationships) {
    const name = String(rel?.related_entity_name || "").trim();
    const relation = String(rel?.relation || "").trim().toLowerCase();
    const direction = String(rel?.direction || "out").trim().toLowerCase();
    const conf = Number(rel?.confidence);
    const evidenceSerial = Number(rel?.evidence_thought_serial_id) || null;
    const reason = String(rel?.reason || "").slice(0, 280);

    if (!VALID_RELATIONS.has(relation)) {
      console.log(`    ✗ "${name}" — invalid relation "${relation}"`);
      stats.skipped_invalid++;
      continue;
    }
    if (!Number.isFinite(conf) || conf < MIN_CONFIDENCE) {
      console.log(`    ✗ "${name}" ${relation} (conf=${conf}) — below threshold`);
      stats.skipped_low_conf++;
      continue;
    }

    const resolved = await resolveRelatedEntity(name);
    if (!resolved) {
      console.log(`    ✗ "${name}" ${relation} — no entity match`);
      stats.skipped_no_match++;
      continue;
    }
    if (resolved.ambiguous) {
      console.log(`    ? "${name}" ${relation} — ambiguous: ${resolved.candidates.map((c) => `#${c.id}/${c.canonical_name}`).join(", ")}`);
      stats.skipped_ambiguous++;
      continue;
    }
    if (resolved.id === entity.id) {
      // Self-reference; skip silently.
      continue;
    }

    // Direction: ENTITY → resolved or resolved → ENTITY.
    let fromId = direction === "in" ? resolved.id : entity.id;
    let toId = direction === "in" ? entity.id : resolved.id;
    if (SYMMETRIC.has(relation)) {
      fromId = Math.min(entity.id, resolved.id);
      toId = Math.max(entity.id, resolved.id);
    }

    if (await edgeExists(fromId, toId, relation)) {
      console.log(`    = "${resolved.canonical_name}" — edge already exists, skip`);
      stats.skipped_existing++;
      continue;
    }
    if (await isBlocklisted(fromId, toId, relation)) {
      console.log(`    ⊘ "${resolved.canonical_name}" ${relation} — blocklisted`);
      stats.skipped_blocklisted++;
      continue;
    }

    const arrow = SYMMETRIC.has(relation) ? "↔" : "→";
    console.log(`    + #${fromId} ${arrow} #${toId} ${relation} (conf=${conf.toFixed(2)}) [#${evidenceSerial}] — ${reason}`);
    stats.proposed++;

    if (apply) {
      const { error: insErr } = await sb.from("edges").insert({
        from_entity_id: fromId,
        to_entity_id: toId,
        relation,
        support_count: 1,
        confidence: Math.max(0, Math.min(1, conf)),
        metadata: {
          source: "inferred",
          inferred_at: new Date().toISOString(),
          inferred_by: "infer-entity-edges.mjs",
          source_entity_id: entity.id,
          evidence_thought_serial_id: evidenceSerial,
          reasoning: reason,
          model_used: modelUsed,
        },
      });
      // ON CONFLICT not specified — the unique key on (from, to, relation) will
      // 23505 if a row appears between our existence check and insert. We
      // swallow that single error class and count it as 'existing'.
      if (insErr) {
        if (String(insErr.code) === "23505") {
          stats.skipped_existing++;
          stats.proposed--;
        } else {
          console.log(`      ! insert failed: ${insErr.message}`);
          stats.errors++;
          stats.proposed--;
        }
      } else {
        stats.written++;
      }
    }
  }

  return { stats };
}

(async () => {
  const entities = await fetchTargetEntities();
  console.log(`\nInferring edges for ${entities.length} entit${entities.length === 1 ? "y" : "ies"} (types: ${targetTypes ? targetTypes.join(",") : "all"}, min-thoughts: ${minThoughts})${dryRun ? " [dry-run]" : " [LIVE]"} via model chain: ${modelChain.join(" → ")}\n`);

  if (apply) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const snapshotDir = path.join(process.cwd(), "scripts", "edge-snapshots");
    fs.mkdirSync(snapshotDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const snapshotPath = path.join(snapshotDir, `edges-pre-infer-${stamp}.json`);
    const { data: snapshot } = await sb.from("edges").select("*");
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
    console.log(`Snapshot of ${snapshot.length} edges saved to ${snapshotPath}\n`);
  }

  const grand = { proposed: 0, written: 0, skipped_low_conf: 0, skipped_no_match: 0, skipped_ambiguous: 0, skipped_existing: 0, skipped_blocklisted: 0, skipped_invalid: 0, errors: 0, entities_skipped: 0 };
  const start = Date.now();
  for (let i = 0; i < entities.length; i++) {
    const res = await processEntity(entities[i], i + 1, entities.length);
    if (res.skipped) grand.entities_skipped++;
    else if (res.stats) {
      for (const k of Object.keys(res.stats)) grand[k] = (grand[k] || 0) + res.stats[k];
    }
    if (i < entities.length - 1) await new Promise((r) => setTimeout(r, rateMs));
  }
  const elapsedMin = ((Date.now() - start) / 60000).toFixed(1);

  console.log("\n— Summary —");
  console.log(`  proposed         : ${grand.proposed}`);
  if (apply) console.log(`  written          : ${grand.written}`);
  console.log(`  skipped: low conf: ${grand.skipped_low_conf}`);
  console.log(`  skipped: no match: ${grand.skipped_no_match}`);
  console.log(`  skipped: ambig.  : ${grand.skipped_ambiguous}`);
  console.log(`  skipped: existing: ${grand.skipped_existing}`);
  console.log(`  skipped: blocked : ${grand.skipped_blocklisted}`);
  console.log(`  skipped: invalid : ${grand.skipped_invalid}`);
  console.log(`  entities skipped : ${grand.entities_skipped}`);
  console.log(`  errors           : ${grand.errors}`);
  console.log(`  elapsed          : ${elapsedMin} min`);
  if (dryRun) console.log("\n[dry-run] Re-run with --apply to write changes.");
})();
