#!/usr/bin/env node
/**
 * reconcile-edges.mjs — one-shot pass that replaces existing entity edges
 * with relations derived from a higher-quality LLM reading all thoughts
 * mentioning the pair, rather than per-thought qwen3 extractions.
 *
 * Goal: clean up the legacy edge table before Layer 2 (edge provenance)
 * ships, so Layer 2's decrement-on-reprocess world starts on signal, not
 * noise.
 *
 * For each typed entity-pair (any relation other than co_occurs_with) that
 * has at least one edge in the live DB:
 *   1. Fetch all thoughts mentioning BOTH entities (via thought_entities).
 *   2. Ask Claude Haiku via OpenRouter what ONE relation, if any, best
 *      describes the pair from a fixed taxonomy. The prompt explicitly
 *      handles negation, auditors/users ≠ evaluators, and builders ≠
 *      evaluators (the failure modes the user has hit).
 *   3. If the answer is "none" or the relation is in edge_blocklist, delete
 *      all existing edges for the pair.
 *   4. Otherwise, delete existing edges and insert a single reconciled edge
 *      with the LLM's confidence and a support_count = number of grounding
 *      thoughts.
 *
 * Usage:
 *   node --env-file=.env scripts/reconcile-edges.mjs --dry-run
 *   node --env-file=.env scripts/reconcile-edges.mjs --apply
 *   node --env-file=.env scripts/reconcile-edges.mjs --apply --limit 50
 *   node --env-file=.env scripts/reconcile-edges.mjs --apply --pair 505,441
 *
 * Required env: SUPABASE_URL, SUPABASE_KEY
 * Optional env:
 *   OLLAMA_URL          default http://localhost:11434/api  (or https://ollama.com/api for cloud)
 *   OLLAMA_API_KEY      bearer token for Ollama Cloud (omit for local)
 *   RECONCILE_MODEL     default qwen3:30b (try qwen3-coder:480b-cloud, gpt-oss:120b-cloud, etc)
 *   RECONCILE_RATE_MS   default 1000ms between calls
 *
 * NOTE: the per-thought extraction worker also uses qwen3:30b, but it sees
 * one thought at a time. Reconcile gives the same model multiple thoughts
 * mentioning the pair plus a much stricter prompt — the win comes from
 * *aggregation + prompt*, not raw parameter count. Bump to a larger cloud
 * model only if the local pass leaves obvious failures.
 */
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const apply = args.includes("--apply");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
const pairIdx = args.indexOf("--pair");
const pairFilter = pairIdx >= 0 ? args[pairIdx + 1] : null;

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
// Comma-separated fallback chain. First entry tried first; if it 429s or
// errors, it's skipped for the remainder of the run and the next is tried.
// Default goes cloud → local in decreasing capability order.
const modelChain = (process.env.RECONCILE_MODEL || "gpt-oss:120b-cloud,gemma4:26b,qwen3:30b")
  .split(",").map((s) => s.trim()).filter(Boolean);
const deadModels = new Set();
const rateMs = Number(process.env.RECONCILE_RATE_MS || 1000);

if (!url || !key) { console.error("SUPABASE_URL / SUPABASE_KEY required"); process.exit(1); }

const sb = createClient(url, key);

const VALID_RELATIONS = new Set([
  "works_on", "uses", "collaborates_with", "integrates_with", "alternative_to",
  "evaluates", "member_of", "located_in", "related_to",
]);
const SYMMETRIC = new Set(["co_occurs_with", "related_to", "collaborates_with", "integrates_with", "alternative_to"]);

const SYSTEM_PROMPT = `You analyse a personal knowledge graph. You are given two entities and the thought snippets that mention both of them. Your job is to pick THE SINGLE relation from a fixed taxonomy that best describes their connection — or "none" if the snippets do not establish any defined relationship.

TAXONOMY (pick exactly one of these strings, or "none"):
- works_on          person or org actively building/owning a project or task
- uses              person or org using a tool or technology
- collaborates_with two people working together (symmetric)
- integrates_with   two tools that connect to each other (symmetric)
- alternative_to    two tools/projects that substitute for each other (symmetric)
- evaluates         person assessing a tool/project/idea for adoption or replacement
- member_of         person belonging to an organization
- located_in        organization or place within a geographic place
- related_to        weak link between two topics (symmetric)
- none              the snippets do not establish a defined relation, OR they explicitly negate every candidate relation

CRITICAL RULES:
1. NEGATION IS DISPOSITIVE. If a snippet says "X is NOT alternative_to Y" or "X is complementary to, not a replacement for Y", DO NOT output alternative_to. Either pick a different supported relation or output "none".
2. AUDITORS / USERS ≠ EVALUATORS. People who USE a system to do their work (quality auditors using an audit tool, end users running a system) are not "evaluators" of it. evaluates is reserved for someone deciding whether to ADOPT or REPLACE the thing.
3. BUILDERS ≠ EVALUATORS. People who built, own, or maintain a system are works_on, never evaluates.
4. Output a directional relation only if the snippets EXPLICITLY state the direction. If direction is unclear, prefer related_to or none.
5. If multiple relations could apply, pick the strongest single one supported by the most snippets.

OUTPUT FORMAT — JSON object only, no prose:
{
  "relation": "<one of taxonomy or 'none'>",
  "subject": "A" | "B" | null,
  "confidence": <number 0.0-1.0>,
  "reason": "<one short sentence citing snippet ids that ground the decision>"
}

For symmetric relations, set "subject" to null. For directional relations, "subject" is "A" if A is the source (e.g. A works_on B), else "B".`;

async function callLLMOnce(modelName, userPrompt, attemptHint) {
  const headers = { "Content-Type": "application/json" };
  if (ollamaKey) headers["Authorization"] = `Bearer ${ollamaKey}`;
  const fullPrompt = `${SYSTEM_PROMPT}\n\n/no_think\n\n${userPrompt}\n\nReturn ONLY a single JSON object matching the schema. Do not narrate. Do not wrap in code fences. Do not add prose before or after.${attemptHint || ""}`;
  const res = await fetch(`${ollamaBase}/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelName,
      prompt: fullPrompt,
      stream: false,
      format: "json",
      options: { temperature: 0.1, num_predict: 1024 },
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

// Returns { decision, modelUsed }. Walks the chain; on 429 or 5xx, marks the
// model dead for the rest of the session and tries the next. On JSON-parse
// failure with the same model, retries once with a stronger nudge before
// giving up on that model.
async function callLLM(userPrompt) {
  const errors = [];
  for (const modelName of modelChain) {
    if (deadModels.has(modelName)) continue;
    try {
      const decision = await callLLMOnce(modelName, userPrompt, "");
      return { decision, modelUsed: modelName };
    } catch (err) {
      // Retry once for parse failures with same model (often transient truncation).
      if (!err.status) {
        try {
          const decision = await callLLMOnce(modelName, userPrompt,
            "\n\nReminder: your previous attempt was not parseable JSON. Output ONLY {\"relation\":...,\"subject\":...,\"confidence\":...,\"reason\":...} on a single line.");
          return { decision, modelUsed: modelName };
        } catch (err2) {
          errors.push(`${modelName}: ${err2.message}`);
          // Don't mark dead — could be a one-off; keep trying for next pair.
          continue;
        }
      }
      // Status-bearing error (HTTP from Ollama). 429 / 5xx → mark this model
      // dead for the rest of the run; for cloud-key issues 401/403 same.
      if (err.status === 429 || err.status >= 500 || err.status === 401 || err.status === 403) {
        if (!deadModels.has(modelName)) {
          console.log(`[fallback] ${modelName} returned ${err.status} — falling back to next model for the rest of this run.`);
          deadModels.add(modelName);
        }
        errors.push(`${modelName}: ${err.message}`);
        continue;
      }
      // Other status — try next model but don't mark dead.
      errors.push(`${modelName}: ${err.message}`);
    }
  }
  throw new Error(`All models in chain failed:\n  ${errors.join("\n  ")}`);
}

function buildUserPrompt(entityA, entityB, snippets) {
  const aliasesA = (entityA.aliases || []).join(", ") || "—";
  const aliasesB = (entityB.aliases || []).join(", ") || "—";
  const snippetText = snippets.length === 0
    ? "(no snippets mention both entities — answer 'none')"
    : snippets.map((s) => `[#${s.serial_id}] ${String(s.content || "").slice(0, 800)}`).join("\n\n");
  return [
    `ENTITY A: "${entityA.canonical_name}" (${entityA.entity_type}) — aliases: ${aliasesA}`,
    `ENTITY B: "${entityB.canonical_name}" (${entityB.entity_type}) — aliases: ${aliasesB}`,
    "",
    "THOUGHT SNIPPETS (mention both A and B):",
    snippetText,
  ].join("\n");
}

function normalizeKey(fromId, toId, relation) {
  if (SYMMETRIC.has(relation) && fromId > toId) return { from: toId, to: fromId };
  return { from: fromId, to: toId };
}

async function isPairBlocklisted(fromId, toId, relation) {
  const { from, to } = normalizeKey(fromId, toId, relation);
  const { data } = await sb
    .from("edge_blocklist")
    .select("relation")
    .eq("from_entity_id", from)
    .eq("to_entity_id", to)
    .eq("relation", relation)
    .maybeSingle();
  return !!data;
}

async function getAllEdgesForPair(idA, idB) {
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  // Fetch both directions and let caller filter
  const [outRes, inRes] = await Promise.all([
    sb.from("edges").select("id, from_entity_id, to_entity_id, relation, support_count, confidence").eq("from_entity_id", lo).eq("to_entity_id", hi),
    sb.from("edges").select("id, from_entity_id, to_entity_id, relation, support_count, confidence").eq("from_entity_id", hi).eq("to_entity_id", lo),
  ]);
  return [...(outRes.data || []), ...(inRes.data || [])];
}

async function getCoLinkedThoughts(idA, idB, entityA, entityB) {
  // Primary: thought_entities links both ways.
  const { data: aLinks } = await sb.from("thought_entities").select("thought_id").eq("entity_id", idA);
  const { data: bLinks } = await sb.from("thought_entities").select("thought_id").eq("entity_id", idB);
  const aSet = new Set((aLinks || []).map((r) => r.thought_id));
  const both = (bLinks || []).map((r) => r.thought_id).filter((id) => aSet.has(id));
  if (both.length > 0) {
    const { data: thoughts } = await sb.from("thoughts").select("id, serial_id, content").in("id", both);
    return { thoughts: thoughts || [], source: "thought_entities" };
  }

  // Fallback: text search the thought content for both names + aliases.
  // Catches "ghost edges" where one entity's link got dropped on a later
  // re-extraction but the names still appear in the source text together.
  const namesA = [entityA.canonical_name, ...(entityA.aliases || [])].filter(Boolean);
  const namesB = [entityB.canonical_name, ...(entityB.aliases || [])].filter(Boolean);
  if (namesA.length === 0 || namesB.length === 0) return { thoughts: [], source: "none" };

  // Pull candidate set: any thought matching ANY name from A. Then filter
  // client-side for those that also contain a B name. PostgREST text search
  // doesn't easily compose AND-of-OR-of-LIKE, so do this in two steps.
  const orA = namesA.map((n) => `content.ilike.%${n.replace(/[,%_]/g, "")}%`).join(",");
  const { data: candidates } = await sb.from("thoughts")
    .select("id, serial_id, content")
    .or(orA)
    .limit(50);

  const matched = (candidates || []).filter((t) => {
    const c = String(t.content || "").toLowerCase();
    return namesB.some((n) => c.includes(n.toLowerCase()));
  });

  return { thoughts: matched, source: matched.length > 0 ? "text_fallback" : "none" };
}

async function getEntity(id) {
  const { data } = await sb.from("entities").select("id, canonical_name, entity_type, aliases").eq("id", id).maybeSingle();
  return data;
}

async function discoverPairs() {
  if (pairFilter) {
    const [a, b] = pairFilter.split(",").map((s) => Number(s.trim()));
    if (!a || !b) { console.error("--pair requires 'A,B' (numeric ids)"); process.exit(1); }
    return [{ a, b }];
  }
  const { data: edges } = await sb.from("edges").select("from_entity_id, to_entity_id, relation").neq("relation", "co_occurs_with");
  const seen = new Set();
  const pairs = [];
  for (const e of edges || []) {
    const a = Math.min(e.from_entity_id, e.to_entity_id);
    const b = Math.max(e.from_entity_id, e.to_entity_id);
    const key = `${a}:${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ a, b });
  }
  return pairs;
}

async function reconcilePair(pair, idx, total) {
  const [entityA, entityB] = await Promise.all([getEntity(pair.a), getEntity(pair.b)]);
  if (!entityA || !entityB) {
    console.log(`[${idx}/${total}] SKIP missing entity (#${pair.a} or #${pair.b})`);
    return { skipped: true };
  }

  const existingEdges = await getAllEdgesForPair(pair.a, pair.b);
  const existingSummary = existingEdges.map((e) => {
    const dir = SYMMETRIC.has(e.relation) ? "↔" : (e.from_entity_id === pair.a ? "→" : "←");
    return `${dir}${e.relation}(${e.support_count})`;
  }).join(", ");

  const { thoughts, source: tsSource } = await getCoLinkedThoughts(pair.a, pair.b, entityA, entityB);
  const userPrompt = buildUserPrompt(entityA, entityB, thoughts);

  let decision, modelUsed;
  try {
    ({ decision, modelUsed } = await callLLM(userPrompt));
  } catch (err) {
    console.log(`[${idx}/${total}] ERROR ${entityA.canonical_name} ↔ ${entityB.canonical_name}: ${err.message}`);
    return { error: true };
  }

  const reconciled = String(decision?.relation || "none").toLowerCase();
  const isValid = reconciled === "none" || VALID_RELATIONS.has(reconciled);
  if (!isValid) {
    console.log(`[${idx}/${total}] INVALID relation "${reconciled}" — treating as none`);
  }
  const finalRelation = isValid ? reconciled : "none";

  // Determine direction for directional relations
  const subject = decision?.subject;
  let fromId = pair.a, toId = pair.b;
  if (finalRelation !== "none" && !SYMMETRIC.has(finalRelation)) {
    if (subject === "B") { fromId = pair.b; toId = pair.a; }
  }
  if (SYMMETRIC.has(finalRelation)) {
    fromId = Math.min(pair.a, pair.b);
    toId = Math.max(pair.a, pair.b);
  }

  // Blocklist check — never restore an edge the user removed
  let blocklistedSkip = false;
  if (finalRelation !== "none") {
    const blocked = await isPairBlocklisted(fromId, toId, finalRelation);
    if (blocked) {
      blocklistedSkip = true;
    }
  }

  const arrow = finalRelation === "none" ? "❌"
              : SYMMETRIC.has(finalRelation) ? "↔"
              : "→";
  const target = blocklistedSkip ? `${finalRelation} [BLOCKLISTED — keeping as none]` : finalRelation;
  const sourceTag = tsSource === "text_fallback" ? "text-search" : tsSource === "thought_entities" ? "linked" : "none";
  console.log(
    `[${idx}/${total}] ${entityA.canonical_name} ↔ ${entityB.canonical_name}  [${modelUsed}]\n` +
    `         existing: ${existingSummary || "(no typed edges)"} (${thoughts.length} thoughts via ${sourceTag})\n` +
    `         reconciled: ${arrow} ${target} (conf ${decision?.confidence ?? "?"}) — ${decision?.reason ?? ""}`
  );

  const action = (finalRelation === "none" || blocklistedSkip) ? "delete_all" : "replace";

  if (dryRun) return { action, finalRelation, blocklistedSkip };

  // Apply
  // 1. Delete all existing edges for this pair (both directions)
  const lo = Math.min(pair.a, pair.b);
  const hi = Math.max(pair.a, pair.b);
  await sb.from("edges").delete().eq("from_entity_id", lo).eq("to_entity_id", hi);
  await sb.from("edges").delete().eq("from_entity_id", hi).eq("to_entity_id", lo);

  // 2. If a relation is valid AND not blocklisted, insert single reconciled edge
  if (action === "replace") {
    await sb.from("edges").insert({
      from_entity_id: fromId,
      to_entity_id: toId,
      relation: finalRelation,
      support_count: thoughts.length || 1,
      confidence: Math.max(0, Math.min(1, Number(decision?.confidence) || 0.6)),
      metadata: { reconciled_at: new Date().toISOString(), reconciled_by: "reconcile-edges.mjs", reason: decision?.reason },
    });
  }

  return { action, finalRelation };
}

(async () => {
  const allPairs = await discoverPairs();
  const pairs = allPairs.slice(0, limit);
  console.log(`\nReconciling ${pairs.length} entity-pair${pairs.length === 1 ? "" : "s"}${dryRun ? " (dry-run)" : " (LIVE)"} via fallback chain: ${modelChain.join(" → ")}\n`);

  // Safety net: before any --apply touches the live edges table, snapshot it
  // to a timestamped JSON file. If the reconcile produces edges the user
  // doesn't like, restore by re-inserting from the snapshot.
  if (apply) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const snapshotDir = path.join(process.cwd(), "scripts", "edge-snapshots");
    fs.mkdirSync(snapshotDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const snapshotPath = path.join(snapshotDir, `edges-pre-reconcile-${stamp}.json`);
    const { data: snapshot } = await sb.from("edges").select("*");
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
    console.log(`Snapshot of ${snapshot.length} edges saved to ${snapshotPath}\n`);
  }

  const stats = { replaced: 0, deleted_all: 0, skipped: 0, error: 0, blocklisted: 0 };
  const startedAt = Date.now();
  for (let i = 0; i < pairs.length; i++) {
    const result = await reconcilePair(pairs[i], i + 1, pairs.length);
    if (result.error) stats.error++;
    else if (result.skipped) stats.skipped++;
    else if (result.blocklistedSkip) stats.blocklisted++;
    else if (result.action === "replace") stats.replaced++;
    else if (result.action === "delete_all") stats.deleted_all++;
    if (i < pairs.length - 1) await new Promise((r) => setTimeout(r, rateMs));
  }
  const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);

  console.log("\n— Summary —");
  console.log(`  replaced         : ${stats.replaced}  (existing edges replaced with reconciled answer)`);
  console.log(`  deleted_all      : ${stats.deleted_all}  (LLM said no relation; existing edges removed)`);
  console.log(`  blocklisted      : ${stats.blocklisted}  (LLM picked a relation already blocklisted; treated as none)`);
  console.log(`  skipped (missing): ${stats.skipped}`);
  console.log(`  errors           : ${stats.error}`);
  console.log(`  elapsed          : ${elapsedMin} min`);
  if (dryRun) console.log("\n[dry-run] Re-run with --apply to write changes.");
})();
