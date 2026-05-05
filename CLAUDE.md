# CLAUDE.md — Agent Instructions for Open Brain

This file helps AI coding tools (Claude Code, Codex, Cursor, etc.) work effectively in this repo.

## What This Repo Is

Open Brain is a persistent AI memory system — one database (Supabase + pgvector), one MCP protocol, any AI client. This repo contains the extensions, recipes, schemas, dashboards, integrations, and skills that the community builds on top of the core Open Brain setup.

**License:** FSL-1.1-MIT. No commercial derivative works. Keep this in mind when generating code or suggesting dependencies.

## Repo Structure

```
extensions/     — Curated, ordered learning path (6 builds). Do NOT add without maintainer approval.
primitives/     — Reusable concept guides (must be referenced by 2+ extensions). Curated.
recipes/        — Standalone capability builds. Open for community contributions.
schemas/        — Database table extensions. Open.
dashboards/     — Frontend templates (Vercel/Netlify). Open.
integrations/   — MCP extensions, webhooks, capture sources. Open.
skills/         — Reusable AI client skills and prompt packs. Open.
docs/           — Setup guides, FAQ, companion prompts.
resources/      — Official companion files and packaged exports.
```

Every contribution lives in its own subfolder under the right category and must include `README.md` + `metadata.json`.

## Guard Rails

- **Never modify the core `thoughts` table structure.** Adding columns is fine; altering or dropping existing ones is not.
- **No credentials, API keys, or secrets in any file.** Use environment variables.
- **No binary blobs** over 1MB. No `.exe`, `.dmg`, `.zip`, `.tar.gz`.
- **No `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, or unqualified `DELETE FROM`** in SQL files.
- **MCP servers must be remote (Supabase Edge Functions), not local.** Never use `claude_desktop_config.json`, `StdioServerTransport`, or local Node.js servers. All extensions deploy as Edge Functions and connect via Claude Desktop's custom connectors UI (Settings → Connectors → Add custom connector → paste URL). See `docs/01-getting-started.md` Step 7 for the pattern.

## PR Standards

- **Title format:** `[category] Short description` (e.g., `[recipes] Email history import via Gmail API`, `[skills] Panning for Gold standalone skill pack`)
- **Branch convention:** `contrib/<github-username>/<short-description>`
- **Commit prefixes:** `[category]` matching the contribution type
- Every PR must pass the automated review checks in `.github/workflows/ob1-review.yml` before human review
- See `CONTRIBUTING.md` for the full review process, metadata.json template, and README requirements

## Key Files

- `CONTRIBUTING.md` — Source of truth for contribution rules, metadata format, and the review process
- `.github/workflows/ob1-review.yml` — Automated PR review
- `.github/metadata.schema.json` — JSON schema for metadata.json validation
- `.github/PULL_REQUEST_TEMPLATE.md` — PR description template
- `LICENSE.md` — FSL-1.1-MIT terms

## Local GSD Execution Layer

This repo also has a maintainer-local GSD layer in `.planning/`.

- If `.planning/` exists, use it for local brownfield planning and phased execution.
- Start with `.planning/STATE.md`, then read `.planning/PROJECT.md`, `.planning/ROADMAP.md`, and the relevant `.planning/codebase/*.md` documents.
- Keep `.planning/` local. It is gitignored intentionally and is not part of the public contribution contract or upstream PR scope.
- Public contributor rules still come from `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, and the committed repo files.

## AJO Fork — Key Facts for AI Assistants

When working in this repo as the AJO maintainer, be aware:

**Environment variables**: Scripts use `SUPABASE_URL` / `SUPABASE_KEY` (AJO names). Upstream recipes use `OPEN_BRAIN_URL` / `OPEN_BRAIN_SERVICE_KEY`. All AJO scripts handle both via fallback. Always run scripts with `node --env-file=.env`.

**Edge Function deployment**: Always `npx.cmd supabase functions deploy <name> --use-api --no-verify-jwt`. Never omit these flags.

**Thoughts table IDs**: The `id` column is UUID (DB primary key). `serial_id` is an auto-increment integer. The dashboard and all citations use `serial_id`. The Edge Function `mapThought()` exposes `serial_id` as `id` to the dashboard.

**Wiki pipeline**:
- Compiler (`generate-wiki.mjs`) always regenerates all pages — `manually_edited` is ignored.
- Curator notes → `wiki_pages.notes` column. Compiler reads this and injects it into the LLM prompt. Never overwritten.
- Citations format: `[#42]` (integer serial_id). Entity cross-links: `/wiki?slug=entity-slug`.
- Wiki output files are gitignored (`wikis/`, `compiled-wiki/`, `output/`).
- Wiki sidebar filter is by entity type (All / Person / Org / Project / Tool / Place / Topic).
- Entity detail header: Rename, Aliases, Merge, Type dropdown (writes `entity_type` to DB), Delete (two-step confirm; removes entity + wiki page).
- `DELETE /entities/:id` — deletes wiki_pages row explicitly (FK is SET NULL), then entity (thought_entities + edges cascade).

**Quality scoring**: `quality_score` defaults to 50. Run `scripts/score-thoughts.mjs` to backfill heuristic scores. The Audit page threshold is configurable in the UI.

**Kanban**: Uses `@dnd-kit/sortable` with `SortableContext` per column and `onDragOver` in `KanbanBoard` for card-to-card insertion. Status values are: `backlog`, `planning`, `active`, `review`, `done`, `archived`.

**Maintainer scripts** (all in `scripts/`):
- `score-thoughts.mjs` — heuristic quality scoring backfill
- `wiki-wipe.mjs` — clear wiki_pages + entity health report
- `reclassify-existing.js` — re-run Work/Personal classification

**Upstream sync — MANDATORY PROCESS**:
The AJO fork tracks `upstream https://github.com/NateBJones-Projects/OB1`. Never manually port upstream changes — always use git properly:
1. `git fetch upstream` — pull latest upstream commits
2. `git log HEAD..upstream/main --oneline` — see what's new
3. Assess each upstream commit: cherry-pick what applies, skip what doesn't (e.g. K8s files, upstream-only docs)
4. For cherry-picks: `git cherry-pick <hash>` (records provenance automatically)
5. For changes already manually applied: `git merge --no-ff -s ours upstream/main -m "[sync] Record upstream merge to <hash> (changes applied in <our-commit>)"`
6. Verify clean with `git log HEAD..upstream/main --oneline` — should be empty

**Never port upstream changes by reading the diff and rewriting them manually** without first doing `git fetch upstream`. The session summary may not preserve the fact that the upstream remote exists — always check `git remote -v` before doing any upstream work.
