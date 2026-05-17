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

**Wiki article structure (post 2026-05-10)**:
The regen prompt now emits articles as narrative prose, not structured forms. Sections:
  - `## TLDR` — 2-3 sentences. What this entity is, what it does, why it matters.
  - `## Detailed` — Multi-paragraph narrative. Weaves together what would have been Key Facts + Timeline into prose. Word count scaled to material density: `max(300, min(1000, 300 + sqrt(link_count) * 100))`. The target is a CEILING with a "do not pad" rule — the LLM is told to land shorter rather than fabricate context.
  - `## Relationships` — Structured edge data, grouped by relation type. Unchanged.
  - `## Open Questions` — Unresolved gaps from the captures. Unchanged.

Legacy pages compiled before this change still have `## Summary` / `## Key Facts` / `## Timeline`. The dashboard parser (`parseSections` in `WikiGraphView`) recognises both formats — a legacy Summary maps to the same slot as a new TLDR; Key Facts and Timeline render as additional sections until the page is regenerated. Once `wiki-regen-all.mjs` runs, all pages converge on the new structure.

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
The dashboard absorbed Search, Audit, Duplicates, and Add into the Thoughts page. The old routes are intercepted by `proxy.ts` (renamed from `middleware.ts` in Next 16 — same API, just the filename convention changed) and redirect to `/thoughts` with prefilters: `/search` → just `/thoughts`, `/audit` → `?score_max=15`, `/duplicates` → `?duplicates=1`, `/ingest` → `?compose=1`. The page directories under `app/audit`, `app/duplicates`, `app/search`, `app/ingest` are deleted — don't recreate them.

**Dynamic entity-type filters (REQUIRED)**:
Anywhere entity types are surfaced in the UI — dashboard legend, wiki graph filter rail, wiki list-view sidebar chips — they must come from `GET /entity-types` (Edge Function) → `/api/entity-types` (Next proxy). The endpoint returns `[{ entity_type, label, color, count }]` with a seed palette for known types (person, project, organization, tool, topic, place) and a deterministic hashed-hue color for any new type. **Never hard-code the type list** — adding a new `entity_type` to the DB must light up a chip everywhere automatically.

**Dashboard REST endpoints (added during redesign)**:
- `GET /entity-types` — distinct entity_types with color + count. RPC-backed via `entity_types_summary()`.
- `GET /sources` — distinct source_type values from thoughts (count desc), powers Source dropdown. RPC-backed via `sources_summary()`.
- `GET /constellation?days=&limit=&min_weight=&classification=` — top-N entities by mention count + co-occurrence edges among them. Each node carries its wiki `slug` for click-through. RPC-backed (`constellation_top_entities` + `constellation_co_occurrence`).
- `GET /entities` — list / search entities. Backed by `search_entities()` RPC so `?search=` matches canonical_name OR any alias (case-insensitive, ilike). Default returns 200 rows; `?limit=N` up to 5000.
- `GET /entities/:id/edges` — edges touching the entity, with each row now including `other_slug` so the wiki Relationships card can navigate without a second round-trip.
- `GET /wiki-pages?page=N&per_page=M` — paginated explicitly (default per_page=5000, max 10000). Returns `{ data, total, page, per_page }`.
- `GET /health/quotas` — for each cap-bound table, reports current row count vs cap + utilization. Aggregations report cap as null/∞ (RPC-backed, no row cap). Dashboard's `<QuotaBanner />` polls this on mount and surfaces a fixed-top warning at >80% utilization.

**No-cap aggregation principle (REQUIRED)**:
Endpoints that aggregate counts (sources, entity-types, constellation top-N + co-occurrence, entity search) MUST do GROUP BY in Postgres via an RPC. **Never** "fetch a slab of rows and aggregate in JS" — that pattern silently truncates as the brain grows. Migration `20260510000100_aggregation_rpcs.sql` defines the RPCs; `20260510000200_search_entities_rpc.sql` adds alias-aware entity search. Add new aggregation endpoints the same way.

**MergeModal search-on-input**:
The wiki page's merge/absorb picker (`MergeModal` in `app/wiki/page.tsx`) refetches `/api/entities?search=…&no_wiki=true` on every keystroke (debounced 200ms) instead of pre-loading and filtering client-side. Alias matches work because the underlying RPC checks both `canonical_name` and any alias. Don't revert to fetch-once-and-filter.

**Wiki list virtual scroll**:
The wiki List view uses `@tanstack/react-virtual` (`VirtualWikiList` in `app/wiki/page.tsx`). Entity + topic groups are flattened into a single indexed row array (headers + items); only rows in the viewport render. Render cost stays flat regardless of page count.

**Constellation interactivity**:
- 30/60/100 top-N chooser next to the min-weight slider. Wiki defaults to 60 (it's the nav surface there); Dashboard defaults to 30 (hero context). Refetches on change.
- Search filters the displayed nodes to matches PLUS their first-degree neighbors (so "search → see neighborhood" instead of one floating dot).
- Click → wiki nav (or in-page select on Wiki view via `onNodeClick`); shift/cmd-click → focus mode (filters to neighborhood).
- Auto-fit sizing scales node radii up when fewer entities are shown so the canvas always fills usefully.

**Dashboard edits trigger entity re-extraction**:
`PUT /thought/:id` recomputes `content_fingerprint` when content changes, archives the prior `thought_versions` row, force-upserts an `entity_extraction_queue` row with `status=pending`, and re-embeds in the background. Same applies to MCP `update_thought`. Without the fingerprint recompute the DB trigger sees a no-op and the worker never re-extracts.

**Auto-link bare entity names in wiki articles**:
The LLM emits `[Name](/wiki?slug=…)` only in the Relationships section; everywhere else (Summary / Key Facts / Timeline / Open Questions) it writes entity names as plain prose. Both renderers (Graph view's `WikiGraphView` `renderMarkdownInline` AND the legacy `MarkdownContent` in `app/wiki/page.tsx`) auto-link bare entity-name occurrences against the entityMap. Word-boundaries, longest-first sorting, case-insensitive, skips self-references and existing `<a>` tags. Don't break this.

**Themes cover the whole UI**:
`ThemeProvider` swaps both legacy `--color-*` tokens AND the new `--bg-*`, `--fg-*`, `--line` design tokens via `theme.designVars`. Six themes: Coal (default), Midnight, Slate, Ocean, Forest, Light. Each has a `scheme: "dark" | "light"` field that sets `color-scheme` on the root. Constellation hero gradients and overlay pills use `color-mix(in srgb, var(--bg-0) 80%, transparent)` so they track the theme.

**Mobile / portrait support (≤ 768px viewport)**:
The dashboard auto-adapts to phone-portrait via CSS media queries — there is no user toggle. Two routes are used in combination:
- **CSS-only** (preferred for layout) — `app/globals.css` defines a `@media (max-width: 768px)` block with utility classes that override inline styles via `!important`. Sprinkle these alongside the inline `style={{}}` props the redesigned components use heavily:
  - `mobile-stack` — forces `grid-template-columns: 1fr` (collapses any multi-col grid)
  - `mobile-half` — forces `1fr 1fr` (2-col for KPI strips)
  - `mobile-pad` / `mobile-pad-tight` — tighter outer padding + top room (64px) for the mobile topbar
  - `mobile-h1` / `mobile-h2` — shrinks oversized heroes (22px / 18px)
  - `mobile-wrap` — adds `flex-wrap` to a row that needs to spill
  - `mobile-hide` — drop on mobile (decorative hairlines, oversized table headers)
  - `mobile-scroll-x` — let a wide flex row scroll horizontally
  - `mobile-cards` — convert `<tr>`/grid rows to stacked cards
  - `mobile-touch` — bumps button/anchor `min-height` to 36px for thumbs
  - `kanban-col-mobile` + `kanban-scroll-mobile` — turn the Workflow board into horizontally-snapped 280px columns
- **JS `matchMedia`** for numeric prop cases — the constellation `<ThoughtGraph>` `width`/`height` cannot be set via CSS. Each redesigned page that hosts one keeps an `isMobile` state hooked to `window.matchMedia("(max-width: 768px)")`. Dashboard hero shrinks 1100×600 → 600×360; Wiki graph view shrinks to 380×320. Don't conflate the two routes — CSS for layout, JS only when a numeric prop crosses the boundary.
- The Sidebar is `<aside>` and is `display: none !important;` on mobile by default; the mobile topbar in `SidebarShell.tsx` provides a hamburger that toggles `isOpen` → Tailwind's `!flex` (higher specificity than the tag selector) to slide the panel in.
- The Wiki **List view** switches to single-pane on mobile: the list pane is `hidden md:flex` once `selected != null`, the detail pane is `hidden md:flex` until then. A back-arrow button in the detail header (`md:hidden`) returns to the list. The Graph view stays single-flow on all viewports — `mobile-stack` collapses the 2-col body.

**Sidebar collapse + Work/Personal page filter**:
- Click the OB·1 logo → sidebar collapses to 64px icon-only (state in localStorage). `--sidebar-width` CSS var on root drives the main content margin so it reflows.
- Work/Personal segment on Dashboard + Thoughts uses `router.replace()` (not just `window.history.replaceState`) so the server component re-renders and KPIs/donut/workflow/recent reflow against the new classification.

**Maintainer scripts** (all in `scripts/`):
- `score-thoughts.mjs` — heuristic quality scoring backfill
- `wiki-wipe.mjs` — clear wiki_pages + entity health report
- `reclassify-existing.js` — re-run Work/Personal classification
- `synthesize-persona.mjs` — generate conceptual `topic-adam-*` wiki pages from semantic clusters; requires `OPENROUTER_API_KEY` + Ollama running. CLI: `node --env-file=.env scripts/synthesize-persona.mjs [--list|--lens <name>|--dry-run]`

**Plaud capture pipeline (current, local-curator — 2026-05-17 onward)**:
Plaud ingestion runs locally on the 5090 via Applaud + a curator-oriented webhook. The Cowork-scheduled-Claude pivot from 2026-05-16 was abandoned (Claude API tokens ~10% of a 5h block per scheduled run, unsustainable at hourly cadence). The local pipeline costs £0 ongoing — Qwen3:30b (Ollama) does the curator reasoning; REST endpoints do the OB writes.

**Flow:**
1. Plaud user manually applies the "Open Brain Ready Thought Extractor" template in the Plaud UI after reviewing/correcting the transcript. The template (GPT-5.5 in Plaud) emits `---ENTRY---` / `---END---` blocks with five headers: `TYPE`, `CONTEXT`, `ENTITIES` (comma-separated canonical names), `SEARCH_HINTS` (` | ` separated phrases), then the body, then `ACTIONS:`.
2. Applaud daemon (`http://127.0.0.1:44471`) polls Plaud's API and fires `POST /webhook` to `http://127.0.0.1:4001` (`scripts/plaud-webhook.js`) when a `transcript_ready` event fires. Payload includes `recording.id`, `recording.filename`, `files.summary` (file path), and `content.summary_markdown`.
3. The webhook is a CURATOR, not a blind capturer. Per entry it:
   - Applies `processor_prompt/entity_corrections.json` (lowercase whole-word STT corrections — `Click→Qlik`, `Bundler→Funder`, `Biblia→BVRLA`, plus `flag_only` rules for ambiguous names that are surfaced as open questions rather than auto-replaced).
   - Searches OB via REST `/search?q=<hint>&classification=<context>` per `SEARCH_HINTS` phrase, dedup by serial_id.
   - Looks up canonical wiki anchors via REST `/wiki-pages/<slug>` for each entity (probes `person-`, `organization-`, `project-`, `tool-`, `topic-`, `place-` prefixes).
   - Hands all that context to Qwen3 via `scripts/plaud-curator-prompt.md` (hot-reloaded between requests). Curator returns a single-line JSON: `{decision, target_id, merged_content, confidence, reasoning, open_question}`.
   - Acts on the decision: `IGNORE` (logged, skipped); `UPDATE` (POST `/capture-pending` with `ollama_decision="UPDATE"`, `update_target_id`, `original_content`, plus the LLM-merged body); `CAPTURE` (POST `/capture-pending` with `ollama_decision="NEW"`).
4. Open questions are appended to `processor_prompt/OPEN_QUESTIONS.md` when: a `flag_only` correction was triggered; OR the curator's confidence dropped below 0.6 and it raised one. Never inject caveats into thought bodies — that's the whole point of the queue.
5. After processing all entries in a payload, the webhook scans `OPEN_QUESTIONS.md` for `Status: answered` entries and applies each via REST `/capture-pending` as an UPDATE, then rewrites Status to `resolved`.
6. Run state lives in `processor_prompt/cursor.json` — `processed_file_ids[]` for dedup, plus a `run_log[]` capped at 50 entries. All writes are atomic (write-temp + rename).

**Critical: every write is via `/capture-pending` (not `/capture`).** Adam triages everything in the dashboard `/review` panel. No auto-merge into the brain.

**`processor_prompt/` directory (gitignored — contains personal data):**
- `entity_corrections.json` — list of `{wrong, canonical, context, flag_only?}` STT correction rules. `_meta.match_rules` controls case sensitivity. Add new entries when fresh hallucinations appear; set `flag_only: true` for ambiguous names.
- `OPEN_QUESTIONS.md` — `## QNNN — <title>` blocks with `Status: open|answered|resolved|dismissed`, `Target thought: #N`, `Question:`, `Why it matters:`, `Answer:`. The webhook reads + writes this file.
- `cursor.json` — `{processed_file_ids[], last_processed_at, skip_rules{min_duration_ms, title_skip_keywords[], required_blessing_tab_name}, run_log[]}`. `required_blessing_tab_name` defaults to "Open Brain Ready Thought Extractor" but is effectively informational — the webhook actually blesses by presence of `---ENTRY---` blocks in `summary_markdown`.
- `processor_prompt.md` — the canonical Plaud template prompt (reference only — Adam updates Plaud's template editor manually; not loaded at runtime).

**MCP `auto_review` flag stays as a fallback path:** `capture_thought` and `update_thought` still accept `auto_review: true` for any chat client (Claude Desktop, etc.) that wants to push into the review queue without going through the webhook. Same behaviour as `/capture-pending` underneath. The webhook bypasses MCP and calls REST directly — simpler for a programmatic client.

The review gate and approve handler are unchanged:
- `metadata.review_status: "pending_review"` keeps the thought out of `entity_extraction_queue` until approved.
- `POST /review/approve` batch-approves: NEW → queues extraction + embedding; UPDATE → applies merged content to target, re-queues, deletes pending vessel.
- The Review dashboard page (`/review`) shows `source_type: plaud` thoughts with the `ollama_decision` badge (`NEW` or `→ #N`), inline editable content/type/classification, per-row + bulk Pass/Delete, original content collapsible for UPDATE rows.
- `/capture-pending` is also used by external callers (n8n, Zapier) that don't go through the webhook.

**Upstream sync — MANDATORY PROCESS**:
The AJO fork tracks `upstream https://github.com/NateBJones-Projects/OB1`. Never manually port upstream changes — always use git properly:
1. `git fetch upstream` — pull latest upstream commits
2. `git log HEAD..upstream/main --oneline` — see what's new
3. Assess each upstream commit: cherry-pick what applies, skip what doesn't (e.g. K8s files, upstream-only docs)
4. For cherry-picks: `git cherry-pick <hash>` (records provenance automatically)
5. For changes already manually applied: `git merge --no-ff -s ours upstream/main -m "[sync] Record upstream merge to <hash> (changes applied in <our-commit>)"`
6. Verify clean with `git log HEAD..upstream/main --oneline` — should be empty

**Never port upstream changes by reading the diff and rewriting them manually** without first doing `git fetch upstream`. The session summary may not preserve the fact that the upstream remote exists — always check `git remote -v` before doing any upstream work.
