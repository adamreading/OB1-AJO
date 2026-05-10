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

**Alias auto-absorb + undo**:
- Adding an alias to an entity (`PATCH /entities/:id/aliases { alias }`) loose-normalizes the alias (lowercase, hyphen↔space) and absorbs any other entity whose canonical_name OR existing alias matches. Absorbed entity's `thought_entities` move to the survivor, edges merge, wiki page is deleted, aliases merge in. Response includes `absorbed: [{ id, canonical_name }]` so the dashboard can confirm.
- **Undoing a bad absorb**: there's no audit log to reverse the merge directly. Instead use `PATCH /entities/:id/aliases { alias, action: "remove_and_resplit" }` — this removes the alias AND re-queues every thought currently linked to the entity into `entity_extraction_queue`. The worker re-reads each thought, sees the names in content, and re-derives entities from scratch. Thoughts that mention the removed alias get a fresh entity created (since the alias is gone, no match), splitting the merged data back apart. Response includes `resplit_queued: N`. Surfaced in the wiki dashboard as a "Remove & resplit" button next to each alias.
- After absorb, the survivor's wiki page is marked stale (`generated_at = NULL`) and one of its thoughts re-queued so the next worker tick + wiki compile reflect the merged content.

**Wiki pipeline**:
- Compiler (`generate-wiki.mjs`) always regenerates all pages — `manually_edited` is ignored.
- Curator notes → `wiki_pages.notes` column. Treated as **HIGHEST AUTHORITY** in the regen prompt: explicit override of conflicting thought snippets, drop-the-thought conflict-resolution rule, plus a tail reminder appended to the user message when notes are present (sits in the model's recency window). The wiki UI surfaces this in a violet-bordered "curator note" panel — the only writable surface on the wiki page.
- Citations format: `[#42]` (integer serial_id). Entity cross-links: `/wiki?slug=entity-slug`.
- Wiki output files are gitignored (`wikis/`, `compiled-wiki/`, `output/`).
- Wiki page has two views toggleable in the header:
  - **Graph view** (default) — constellation hero (collapsible 480px↔100px strip) + 2-col body. Left column: parsed Summary / Key Facts / Timeline from the markdown (split on `## H2`). Right column: Relationships (from `/entities/:id/edges`, grouped by `relation`), Open Questions, Curator Note.
  - **List view** — preserves the existing alphabetical sidebar + side-panel detail. Sidebar filter chips are dynamic (one per entity_type returned by `/entity-types`).
- Entity detail header: Rename, Aliases, Merge, Type dropdown (writes `entity_type` to DB), Delete (two-step confirm; removes entity + wiki page).
- `DELETE /entities/:id` — deletes wiki_pages row explicitly (FK is SET NULL), then entity (thought_entities + edges cascade).

**Quality scoring**: `quality_score` defaults to 50. Run `scripts/score-thoughts.mjs` to backfill heuristic scores. The Audit page threshold is configurable in the UI.

**Kanban (Workflow page)**: Uses `@dnd-kit/sortable` with `SortableContext` per column and `onDragOver` in `KanbanBoard` for card-to-card insertion. Status values are: `backlog`, `planning`, `active`, `review`, `done`, `archived`. Cards (`KanbanCard.tsx`) require an `@entity` tag in the header (sourced from `metadata.topics[0]`); if no topic is present, they show muted `— unlinked` instead. This is the most important density signal — never remove it.

**Dashboard design system (OB1 redesign)**:
The Dashboard / Thoughts / Workflow / Wiki pages and the Sidebar were redesigned to a Linear/Vercel-grade look. New pieces to know about:
- **Tokens**: `dashboards/open-brain-dashboard-next/app/globals.css` defines a parallel token layer (`--bg-0..4`, `--fg..fg-4`, `--violet-50..700`, `--ok/warn/crit`, `--r-sm/md/lg/xl`) alongside the legacy `--color-*` tokens. New components use the new tokens; legacy pages keep `--color-*` working. Don't conflate.
- **Atoms**: `components/design/Atoms.tsx` exports `TypeChip`, `Card`, `SegBar`, `Sparkline`, `TypeDonut`, `ImpDots` (1–5 dot importance scale), `ScoreBar` (heuristic worker.js score), and `importanceToFiveScale()` helper. Reuse these instead of re-rolling.
- **ThoughtGraph**: `components/design/ThoughtGraph.tsx` is the constellation graph — sunflower-seed force layout + auto-fit + smart label placement. Props: `nodes`, `edges`, `minWeight`, `hiddenTypes`, `entityTypes` (from `/entity-types`), `selectedId`, `onNodeClick` (override default plain-click), `collapsed`. Used by the dashboard hero AND the wiki graph view.
- **Brand**: `components/design/Brand.tsx` exports `Mark` and `Wordmark` for "Open Brain" / "OB·1".
- **Sidebar** is 6 items in 3 groups (Capture: Today, Review · Brain: Thoughts, Wiki, Workflow · Discover: Actions). Live counts come from `/api/sidebar-counts`.
- **Importance vs Score** are distinct everywhere they appear. Don't conflate them. Importance is 1–5 (or 0–100 legacy mapped via `importanceToFiveScale`); Score is the worker.js heuristic.

**Route consolidation**:
The dashboard absorbed Search, Audit, Duplicates, and Add into the Thoughts page. The old routes are intercepted by `middleware.ts` and redirect to `/thoughts` with prefilters: `/search` → just `/thoughts`, `/audit` → `?score_max=15`, `/duplicates` → `?duplicates=1`, `/ingest` → `?compose=1`. The page directories under `app/audit`, `app/duplicates`, `app/search`, `app/ingest` are deleted — don't recreate them.

**Dynamic entity-type filters (REQUIRED)**:
Anywhere entity types are surfaced in the UI — dashboard legend, wiki graph filter rail, wiki list-view sidebar chips — they must come from `GET /entity-types` (Edge Function) → `/api/entity-types` (Next proxy). The endpoint returns `[{ entity_type, label, color, count }]` with a seed palette for known types (person, project, organization, tool, topic, place) and a deterministic hashed-hue color for any new type. **Never hard-code the type list** — adding a new `entity_type` to the DB must light up a chip everywhere automatically.

**Dashboard REST endpoints (added during redesign)**:
- `GET /entity-types` — distinct entity_types with color + count.
- `GET /sources` — distinct source_type values from thoughts (count desc), powers Source dropdown.
- `GET /constellation?days=&limit=&min_weight=&classification=` — top-N entities by mention count + co-occurrence edges among them. Each node carries its wiki `slug` for click-through.
- `GET /entities/:id/edges` — edges touching the entity, with each row now including `other_slug` so the wiki Relationships card can navigate without a second round-trip.

**Maintainer scripts** (all in `scripts/`):
- `score-thoughts.mjs` — heuristic quality scoring backfill
- `wiki-wipe.mjs` — clear wiki_pages + entity health report
- `reclassify-existing.js` — re-run Work/Personal classification
- `synthesize-persona.mjs` — generate conceptual `topic-adam-*` wiki pages from semantic clusters; requires `OPENROUTER_API_KEY` + Ollama running. CLI: `node --env-file=.env scripts/synthesize-persona.mjs [--list|--lens <name>|--dry-run]`
- `plaud-webhook.js` — Applaud → Open Brain webhook receiver (port 4001). Parses `---ENTRY---` blocks from Plaud's custom template, runs Ollama SKIP/NEW/UPDATE decisions per entry, and captures each to `/capture-pending` (pending human review). For UPDATE decisions, synthesises the merge via Ollama at capture time and stores the merged content in the pending thought — the original is never touched until approved in the Review panel.

**Plaud capture pipeline**:
- `start_brain.ps1` launches 4 processes in a single Windows Terminal window via `psmux` (2×2 pane layout): Dashboard top-left (port 3010), Plaud Webhook top-right (port 4001), Brain Worker bottom-left, Applaud bottom-right (Plaud sync daemon, port 44471). Requires `psmux` + `wt.exe` installed; paths pinned at top of script.
- `metadata.review_status: "pending_review"` is the review gate — thoughts with this flag are NOT inserted into `entity_extraction_queue` and therefore invisible to the wiki, Kanban, and action items pipeline until approved.
- Use `POST /capture-pending` (not `/capture`) for any source that requires human triage before entering the brain.
- `POST /review/approve` batch-approves: NEW decisions queue the thought for extraction + embedding; UPDATE decisions apply the pending thought's merged content to the original target thought, re-queue it, and delete the pending vessel.
- The Review dashboard page (`/review`) shows all `source_type: plaud` thoughts with `review_status: pending_review`. Each row shows an `ollama_decision` badge (`NEW` or `→ #N` for updates), inline editable content/type/classification, per-row Pass/Delete, and bulk Pass/Delete. For UPDATE entries, the original content is available in a collapsible section for comparison before approving.

**Upstream sync — MANDATORY PROCESS**:
The AJO fork tracks `upstream https://github.com/NateBJones-Projects/OB1`. Never manually port upstream changes — always use git properly:
1. `git fetch upstream` — pull latest upstream commits
2. `git log HEAD..upstream/main --oneline` — see what's new
3. Assess each upstream commit: cherry-pick what applies, skip what doesn't (e.g. K8s files, upstream-only docs)
4. For cherry-picks: `git cherry-pick <hash>` (records provenance automatically)
5. For changes already manually applied: `git merge --no-ff -s ours upstream/main -m "[sync] Record upstream merge to <hash> (changes applied in <our-commit>)"`
6. Verify clean with `git log HEAD..upstream/main --oneline` — should be empty

**Never port upstream changes by reading the diff and rewriting them manually** without first doing `git fetch upstream`. The session summary may not preserve the fact that the upstream remote exists — always check `git remote -v` before doing any upstream work.
