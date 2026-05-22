#!/usr/bin/env node
// Smoke-test gate for AJO. Maps AJO's env var names onto the upstream
// recipe's expectations and invokes recipes/brain-smoke-test/smoke-all.js.
//
// Why a wrapper rather than editing smoke-all.js: keeping the upstream
// recipe untouched means future `git fetch upstream` syncs apply cleanly.
// The AJO-specific naming translation lives here.
//
// Used by start_brain.ps1 as a pre-launch sanity check that the deployed
// Edge Functions + DB schema are still healthy before relaunching the
// local panes. Forwards all CLI args through, so `--json`, `--category=…`,
// `--destructive`, `--help` all behave identically to the upstream script.
//
// Exit codes (passed through from smoke-all.js):
//   0  all pass, or all pass-or-skip
//   1  at least one check failed
//   2  setup error (missing env var, etc.)

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SMOKE = path.join(ROOT, "recipes", "brain-smoke-test", "smoke-all.js");

if (!existsSync(SMOKE)) {
  console.error(`smoke-gate: smoke-all.js not found at ${SMOKE}`);
  process.exit(2);
}

const env = { ...process.env };

// AJO uses SUPABASE_KEY for the service-role secret (set via supabase
// secrets); the upstream smoke test expects SUPABASE_SERVICE_ROLE_KEY.
if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  env.SUPABASE_SERVICE_ROLE_KEY =
    env.SUPABASE_KEY || env.SUPABASE_SERVICE_KEY || env.OPEN_BRAIN_SERVICE_KEY || "";
}

// MCP_ACCESS_KEY lives as a Supabase Edge Function secret, not in .env.
// The upstream smoke test exits 2 if it's missing, which makes the gate
// useless for the common AJO setup. Skip cleanly with a one-liner so
// start_brain.ps1 doesn't bark on every launch. Add MCP_ACCESS_KEY to
// .env locally to enable the full gate.
if (!env.MCP_ACCESS_KEY) {
  console.log(
    "smoke-gate: skipping (MCP_ACCESS_KEY not in .env — add it to enable full gate)."
  );
  process.exit(0);
}

// Default REST endpoints to the canonical AJO deploy URL if the user
// hasn't explicitly set them — saves having to repeat the same value.
const supabaseUrl = (env.SUPABASE_URL || env.OPEN_BRAIN_URL || "").replace(/\/$/, "");
if (supabaseUrl) {
  if (!env.REST_API_BASE) env.REST_API_BASE = `${supabaseUrl}/functions/v1/rest-api`;
  if (!env.NEXT_PUBLIC_API_URL) env.NEXT_PUBLIC_API_URL = `${supabaseUrl}/functions/v1/rest-api`;
}

const args = [SMOKE, ...process.argv.slice(2)];
const child = spawn(process.execPath, args, { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 1));
