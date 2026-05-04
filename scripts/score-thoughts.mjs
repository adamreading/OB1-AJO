#!/usr/bin/env node
/**
 * score-thoughts.mjs — Heuristic quality scoring for all thoughts.
 *
 * Scores 0-100 based on: content length, word count, vocabulary richness,
 * sentence structure, URL/noise penalties, and metadata completeness.
 *
 * Usage:
 *   node --env-file=.env scripts/score-thoughts.mjs
 *   node --env-file=.env scripts/score-thoughts.mjs --dry-run
 *   node --env-file=.env scripts/score-thoughts.mjs --only-default
 */

import { createClient } from "@supabase/supabase-js";

const dryRun = process.argv.includes("--dry-run");
// --only-default: only update thoughts still sitting at the 50 default
const onlyDefault = process.argv.includes("--only-default");

const PAGE_SIZE = 500;
const UPSERT_BATCH = 100;

const url = process.env.OPEN_BRAIN_URL || process.env.SUPABASE_URL;
const key =
  process.env.OPEN_BRAIN_SERVICE_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_KEY required in .env");
  process.exit(1);
}

const sb = createClient(url, key);

// ── Scoring formula ───────────────────────────────────────────────────────────

function scoreThought(thought) {
  const content = (thought.content || "").trim();
  const metadata = thought.metadata || {};

  // Base score from content length
  const len = content.length;
  let score;
  if (len <= 10) score = 5;
  else if (len <= 30) score = 15;
  else if (len <= 75) score = 35;
  else if (len <= 200) score = 52;
  else if (len <= 500) score = 65;
  else if (len <= 2000) score = 75;
  else score = 82;

  // Word count
  const words = content.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  if (wordCount < 3) score -= 20;
  else if (wordCount >= 50) score += 10;
  else if (wordCount >= 15) score += 5;

  // Vocabulary richness: unique words / total words
  const unique = new Set(
    words.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean)
  );
  const richness = wordCount > 0 ? unique.size / wordCount : 0;
  if (richness >= 0.7) score += 8;
  else if (richness >= 0.5) score += 4;
  else if (richness < 0.3 && wordCount > 5) score -= 8;

  // Sentence structure
  const sentences = (content.match(/[.!?]+/g) || []).length;
  if (sentences >= 3) score += 6;
  else if (sentences >= 1) score += 3;

  // Penalty: bare URL
  if (/^https?:\/\/\S+$/.test(content)) score -= 35;
  else if (/^https?:\/\//.test(content) && wordCount < 6) score -= 20;

  // Penalty: all-caps noise
  if (len > 10 && content === content.toUpperCase() && /[A-Z]/.test(content))
    score -= 15;

  // Penalty: mostly digits
  const digits = (content.match(/\d/g) || []).length;
  if (len > 5 && digits / len > 0.6) score -= 15;

  // Penalty: binary/encoding garbage (control characters)
  const garbage = (content.match(/[\x00-\x1f\x7f-\x9f]/g) || []).length;
  if (garbage > 3) score -= 25;

  // Metadata bonuses
  if (thought.type && thought.type !== "idea") score += 3;
  if (thought.importance && thought.importance !== 3) score += 3;
  if (Array.isArray(metadata.topics) && metadata.topics.length > 0) score += 5;
  if (
    metadata.entities &&
    typeof metadata.entities === "object" &&
    Object.keys(metadata.entities).length > 0
  )
    score += 5;
  if (metadata.summary && String(metadata.summary).length > 20) score += 4;

  return Math.max(1, Math.min(100, Math.round(score)));
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

let allThoughts = [];
let offset = 0;
process.stdout.write("Fetching thoughts");

while (true) {
  let query = sb
    .from("thoughts")
    .select("id, content, type, importance, quality_score, metadata")
    .range(offset, offset + PAGE_SIZE - 1);

  if (onlyDefault) query = query.eq("quality_score", 50);

  const { data, error } = await query;

  if (error) {
    console.error("\nFetch error:", error.message);
    process.exit(1);
  }
  if (!data || data.length === 0) break;
  allThoughts = allThoughts.concat(data);
  offset += data.length;
  process.stdout.write(".");
  if (data.length < PAGE_SIZE) break;
}

console.log(`\nFetched ${allThoughts.length} thoughts${onlyDefault ? " (default score=50 only)" : ""}.`);

// ── Score ─────────────────────────────────────────────────────────────────────

const scored = allThoughts.map((t) => ({
  id: t.id,
  oldScore: Number(t.quality_score),
  newScore: scoreThought(t),
  preview: (t.content || "").slice(0, 70).replace(/\n/g, " "),
}));

const changed = scored.filter((s) => s.newScore !== s.oldScore);

// Distribution of new scores
const dist = { "<20": 0, "20-29": 0, "30-49": 0, "50-69": 0, "70-89": 0, "90+": 0 };
for (const s of scored) {
  if (s.newScore < 20) dist["<20"]++;
  else if (s.newScore < 30) dist["20-29"]++;
  else if (s.newScore < 50) dist["30-49"]++;
  else if (s.newScore < 70) dist["50-69"]++;
  else if (s.newScore < 90) dist["70-89"]++;
  else dist["90+"]++;
}

console.log("\nNew score distribution:");
for (const [range, count] of Object.entries(dist)) {
  const pct = Math.round((count / scored.length) * 100);
  const bar = "█".repeat(Math.round(pct / 2));
  console.log(`  ${range.padEnd(8)} ${String(count).padStart(5)}  (${String(pct).padStart(2)}%)  ${bar}`);
}
console.log(`\nThoughts to update: ${changed.length} of ${scored.length}`);

if (dryRun) {
  const low = scored.filter((s) => s.newScore < 30).slice(0, 15);
  if (low.length) {
    console.log("\n[dry-run] Sample low-quality thoughts (score < 30):");
    for (const s of low) {
      console.log(`  ${String(s.oldScore).padStart(3)} → ${String(s.newScore).padStart(3)}  "${s.preview}"`);
    }
  }
  const hi = scored.filter((s) => s.newScore >= 80).slice(0, 5);
  if (hi.length) {
    console.log("\n[dry-run] Sample high-quality thoughts (score ≥ 80):");
    for (const s of hi) {
      console.log(`  ${String(s.oldScore).padStart(3)} → ${String(s.newScore).padStart(3)}  "${s.preview}"`);
    }
  }
  console.log("\n[dry-run] No changes written. Re-run without --dry-run to apply.");
  process.exit(0);
}

// ── Upsert ────────────────────────────────────────────────────────────────────

let done = 0;
process.stdout.write("Writing scores");

for (let i = 0; i < changed.length; i += UPSERT_BATCH) {
  const batch = changed.slice(i, i + UPSERT_BATCH);
  await Promise.all(
    batch.map(async (s) => {
      const { error } = await sb
        .from("thoughts")
        .update({ quality_score: s.newScore })
        .eq("id", s.id);
      if (error) throw new Error(`Update failed for ${s.id}: ${error.message}`);
    })
  );
  done += batch.length;
  process.stdout.write(".");
}

console.log(`\nDone. ${done} thoughts scored.`);
