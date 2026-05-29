#!/usr/bin/env node
/**
 * queue-status.mjs — print entity_extraction_queue depth by status.
 *
 * Quick check anytime the worker is chewing through a backlog and you
 * want to know how much is left without leaving the pane it's running in.
 *
 * Usage:
 *   node --env-file=.env scripts/queue-status.mjs
 *
 * Watch every 5s (PowerShell):
 *   while ($true) { node --env-file=.env scripts/queue-status.mjs; Start-Sleep 5 }
 *
 * Watch every 5s (bash):
 *   watch -n 5 'node --env-file=.env scripts/queue-status.mjs'
 *
 * Output:
 *   Queue (1247 total):
 *     pending       18
 *     processing    1
 *     complete      1224
 *     failed        4
 *     skipped       0
 *   Oldest pending queued 23s ago
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL || process.env.OPEN_BRAIN_URL;
const key = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("SUPABASE_URL / SUPABASE_KEY required"); process.exit(1); }
const sb = createClient(url, key);

const STATUSES = ["pending", "processing", "complete", "failed", "skipped"];

const counts = {};
let total = 0;
for (const status of STATUSES) {
  const { count, error } = await sb
    .from("entity_extraction_queue")
    .select("thought_id", { count: "exact", head: true })
    .eq("status", status);
  if (error) {
    console.error(`status="${status}" query failed: ${error.message}`);
    process.exit(1);
  }
  counts[status] = count ?? 0;
  total += counts[status];
}

console.log(`Queue (${total} total):`);
for (const s of STATUSES) {
  console.log(`  ${s.padEnd(12)} ${counts[s]}`);
}

// Oldest pending row's age — tells you how long the head of the queue has
// been waiting, which is the most useful "is the worker keeping up" signal.
if (counts.pending > 0) {
  const { data: oldest } = await sb
    .from("entity_extraction_queue")
    .select("queued_at")
    .eq("status", "pending")
    .order("queued_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (oldest?.queued_at) {
    const ageMs = Date.now() - new Date(oldest.queued_at).getTime();
    const ageStr = ageMs < 60_000 ? `${Math.round(ageMs / 1000)}s`
      : ageMs < 3600_000 ? `${Math.round(ageMs / 60_000)}m`
      : `${(ageMs / 3600_000).toFixed(1)}h`;
    console.log(`Oldest pending queued ${ageStr} ago`);
  }
}

// Recent failed rows surface real problems (deterministic-failure thoughts
// that hit the attempt cap). Show them so the user can spot if anything's
// genuinely stuck.
if (counts.failed > 0) {
  const { data: failedRows } = await sb
    .from("entity_extraction_queue")
    .select("thought_id, attempt_count, last_error, processed_at")
    .eq("status", "failed")
    .order("processed_at", { ascending: false })
    .limit(3);
  if (failedRows?.length) {
    console.log(`Recent failures:`);
    for (const r of failedRows) {
      const id = r.thought_id.slice(0, 8);
      const err = String(r.last_error || "").slice(0, 80);
      console.log(`  ${id} (${r.attempt_count} attempts): ${err}`);
    }
  }
}
