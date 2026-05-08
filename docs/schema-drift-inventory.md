# Schema Drift Inventory

Snapshot taken 2026-05-08 by diffing a live `supabase db dump --schema public` against the migrations in `supabase/migrations/` and the recipe schemas in `schemas/`.

This file lists schema objects that exist in the live AJO database but are **not** declared in any migration or recipe schema in this repo.

**Most are baseline OB1 setup — applied via the Supabase SQL editor before this repo started using migrations.** They are *not* bugs; they're a documentation gap. The "Status" column flags which entries are safe vs suspicious.

> [!IMPORTANT]
> Filed as a post-Layer-2 consolidation task. **Do not act on any of these without an explicit decision** — wholesale "consolidation migration" runs the risk of stepping on something the live system depends on. Rebuild after Layer 2's edge-provenance work has settled.

## Status legend

- 🟢 **baseline** — defined by upstream OB1 getting-started or recipe install scripts; predates this repo's migrations. Safe; expected to be missing from this repo's migration set.
- 🟡 **expected** — added off-migration during AJO development for a known reason; should be back-filled into a migration eventually but is correct as-is.
- 🔴 **suspicious** — found by accident; cause unclear; investigate before keeping.

## Tables

| Table | Status | Notes |
|---|---|---|
| `thoughts` | 🟢 baseline | Core OB1 table. Originally created via `docs/01-getting-started.md` Step 2.6. |
| `thought_versions` | 🟡 expected | Version archive for `update_thought` MCP tool. Likely from an upstream recipe. |
| `fieldy_pending` | 🟢 baseline | Predates the AJO Plaud pipeline. Unused now; candidate for cleanup once `metadata.review_status` flow is fully verified. |
| `ingestion_items` | 🟢 baseline | From the smart-ingest recipe. Used by `/ingest` REST endpoint. |
| `ingestion_jobs` | 🟢 baseline | Same as above — pair with `ingestion_items`. |

## Functions

| Function | Status | Notes |
|---|---|---|
| `match_thoughts(...)` | 🟢 baseline | Embedding similarity RPC from `docs/01-getting-started.md`. Used by wiki compiler's `--semantic-expand` and by the dashboard's semantic search. |
| `upsert_thought(...)` | 🟢 baseline | Content-fingerprint dedup RPC. Used by MCP `capture_thought` and the wiki dossier writer. |
| `update_updated_at()` | 🟢 baseline | Generic timestamp trigger function. Used by `thoughts_updated_at`. |
| `~~trigger_queue_extraction()~~` | 🔴 ~~suspicious~~ | **Removed** in migration `20260508000100_drop_duplicate_extraction_trigger.sql`. Was a duplicate of `queue_entity_extraction()` without the WHERE guard. Origin unknown — no commit history. Most likely added by a previous AI-assisted session as a workaround. |

## Triggers

| Trigger | Status | Notes |
|---|---|---|
| `thoughts_updated_at` | 🟢 baseline | Generic `BEFORE UPDATE` timestamp trigger. Sets `updated_at = now()`. |
| `~~queue_entity_extraction~~` | 🔴 ~~suspicious~~ | **Removed** with `trigger_queue_extraction()` above. Was firing alongside `trg_queue_entity_extraction` and bypassing the fingerprint guard, causing every metadata edit to re-run Ollama. |

## Open questions / consolidation tasks

1. **Backfill these into migrations** — once Layer 2 (edge provenance) ships and the wiki work is stable, write a single "consolidation migration" that codifies the baseline objects so the repo can be reproduced from migrations alone.
2. **`fieldy_pending` cleanup** — verify nothing in the Plaud review flow still touches it, then drop in a follow-up migration.
3. **Why does `thoughts` not appear in any migration in this repo?** — the table was created upstream before this fork started using migrations. The CHECK constraints, indexes, and triggers should be audited against current dashboard/worker assumptions.

## Process change for the future

Going forward, **all schema changes go through `supabase/migrations/`** — no Supabase Studio SQL editor edits. If a change has to be made hot, write the migration first, apply it via `npx supabase db push`, and commit. The `[wiki] Stop deleted entities resurrecting` and `[wiki] Auto-clean stale citations` work from this session both followed this pattern correctly.
