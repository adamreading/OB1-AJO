// Find Cowork-scheduled pending-review thoughts that should have been
// type=newsletter / classification=personal but landed as observation/work
// due to the MCP server's old behaviour. Retag in-place.
//
// Detection: content opens with "Newsletter — <Pub>" (the cowork prompt's
// mandatory attribution header). Works regardless of metadata.source value.

import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL || process.env.OPEN_BRAIN_URL;
const KEY = process.env.SUPABASE_KEY || process.env.OPEN_BRAIN_SERVICE_KEY;
const sb = createClient(URL, KEY);

const { data, error } = await sb
  .from("thoughts")
  .select("id, serial_id, type, classification, metadata, source_type, content, created_at")
  .filter("metadata->>review_status", "eq", "pending_review")
  .order("created_at", { ascending: false });

if (error) {
  console.error("Query failed:", error.message);
  process.exit(1);
}

console.log(`Found ${data?.length || 0} total pending-review thoughts.\n`);

const toFix = [];
const newsletterShape = [];

for (const t of data || []) {
  const opener = String(t.content || "").slice(0, 200);
  const looksLikeNewsletter = /^Newsletter[\s—\-]/i.test(opener);

  if (!looksLikeNewsletter) continue;

  const src = t.metadata?.source ?? "(none)";
  newsletterShape.push({ ...t, src, opener });

  const wrongType = t.type !== "newsletter";
  const wrongClass = t.classification !== "personal";
  if (wrongType || wrongClass) toFix.push(t);
}

console.log(`Newsletter-shaped pending-review: ${newsletterShape.length}\n`);
for (const t of newsletterShape) {
  console.log(`  #${t.serial_id}  type=${t.type}  class=${t.classification}  source=${t.src}  source_type=${t.source_type}`);
  console.log(`    "${t.opener.slice(0, 90).replace(/\s+/g, " ")}..."`);
}

console.log(`\nMis-tagged (wrong type or class): ${toFix.length}\n`);

if (process.argv.includes("--apply") && toFix.length > 0) {
  for (const t of toFix) {
    const newMeta = { ...(t.metadata || {}), classification: "personal" };
    const { error: upErr } = await sb
      .from("thoughts")
      .update({ type: "newsletter", classification: "personal", metadata: newMeta })
      .eq("id", t.id);
    if (upErr) {
      console.log(`  x #${t.serial_id}: ${upErr.message}`);
    } else {
      console.log(`  ok #${t.serial_id} retagged`);
    }
  }
  console.log(`\nDone.`);
} else if (toFix.length > 0) {
  console.log(`Dry-run only. Pass --apply to commit.`);
}
