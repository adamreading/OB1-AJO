# Open Brain Dashboard (Next.js)

<div align="center">

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@alanshurafa](https://github.com/alanshurafa)**

*Reviewed and merged by the Open Brain maintainer team — thank you for building the future of AI memory!*

</div>

A full-featured web dashboard for your Open Brain second brain. Browse, search, capture, and manage thoughts through a modern dark-themed UI. Built with Next.js, React, TypeScript, and Tailwind CSS. Deploy to Vercel or any Node.js host.

## What It Does

Provides 6 primary pages, a "premium dark + violet" design (Linear/Vercel direction), and a constellation graph as the signature visual.

| Page | Description |
|------|-------------|
| **Dashboard** (`/`) | Control-room view — KPI strip with sparklines (total / active / wiki entities / awaiting review), entity-co-occurrence **constellation hero** with min-weight slider + dynamic legend filters, type donut + workflow snapshot, capture box, recent activity. |
| **Thoughts** (`/thoughts`) | Unified browse / search / audit / duplicates view. Semantic vs full-text search toggle, dynamic Source dropdown, Score-range audit slider with low-score row highlighting, "+ New thought" inline composer. Replaces the old Search, Audit, Duplicates, and Add pages. |
| **Workflow** (`/kanban`) | Kanban board for tasks & ideas with drag-and-drop status. Cards force a primary `@entity` tag in the header (sourced from `metadata.topics[0]`) so each card's subject is legible at a glance. |
| **Wiki** (`/wiki`) | Knowledge graph view with **Graph / List** toggle. Graph mode hosts a collapsible constellation hero plus a 2-column body (Summary / Key Facts / Timeline left; Relationships / Open Questions / Curator Note right). Curator Note is the only writable surface — it steers the next regeneration. List mode preserves the existing alphabetical browse view. |
| **Review** (`/review`) | Plaud capture triage — thoughts awaiting human approval before entering the brain. Inline editing, per-row Pass/Delete, bulk Pass/Delete. Content shown 6 lines deep by default with click-to-expand. |
| **Actions** (`/actions`) | Action items extracted from captures, promotable to Kanban tasks. |
| **Login** (`/login`) | API key authentication via encrypted session cookie. |
| **Detail** (`/thoughts/[id]`) | Full thought view with inline editing, delete, linked reflections. Reachable from any thought reference. |

### Sidebar

Six items grouped:

- **Capture** — Today, Review
- **Brain** — Thoughts, Wiki, Workflow
- **Discover** — Actions

Counts shown next to each item come live from `/api/sidebar-counts`. The old routes `/search`, `/audit`, `/duplicates`, `/ingest` redirect via middleware to `/thoughts` with prefilters (`?score_max=15`, `?duplicates=1`, `?compose=1`) so any external link or bookmark still resolves.

### Design system

- **Tokens**: `app/globals.css` defines `--bg-0..4`, `--fg..fg-4`, `--violet-50..700`, `--ok/warn/crit`, `--r-sm/md/lg/xl`. New pages use these; legacy `--color-*` tokens still work for any older surface.
- **Shared atoms**: `components/design/Atoms.tsx` — `TypeChip` (with `source` prop), `Card`, `SegBar`, `Sparkline`, `TypeDonut`, `ImpDots` (1–5), `ScoreBar` (worker.js heuristic).
- **Constellation**: `components/design/ThoughtGraph.tsx` — sunflower-seed force layout + auto-fit zoom + smart 4-position label placement. Props include `selectedId`, `collapsed`, `onNodeClick`, `entityTypes`, `hiddenTypes`. Reused by Dashboard hero AND Wiki graph view.
- **Dynamic entity types**: filter chips and node colors come from `/api/entity-types` so adding a new `entity_type` row lights up a chip everywhere automatically. **Don't hard-code the type list anywhere.**

## Prerequisites

- A working Open Brain setup with the **REST API gateway** (`open-brain-rest`) deployed
- **Node.js 18+** installed
- A **Vercel account** (free tier works) or any Node.js hosting

### Credential Tracker

| Credential | Where to get it | Where it goes |
|------------|----------------|---------------|
| `NEXT_PUBLIC_API_URL` | Your Supabase project URL + `/functions/v1/open-brain-rest` | `.env` or hosting env vars |
| `SESSION_SECRET` | Generate: `openssl rand -hex 32` | `.env` or hosting env vars |


## Steps

### Step 1: Clone the dashboard

```bash
# From the OB1 repo
cd dashboards/open-brain-dashboard
```

Or copy the folder to your own project directory.

### Step 2: Install dependencies

```bash
npm install
```

### Step 3: Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set your values:

```
NEXT_PUBLIC_API_URL=https://YOUR-PROJECT-REF.supabase.co/functions/v1/open-brain-rest
SESSION_SECRET=your-32-char-secret-here
```

### Step 4: Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). You should see the login page.

Enter your Open Brain API key (the `MCP_ACCESS_KEY` from your Supabase Edge Function secrets). After login, the dashboard loads with your stats and recent thoughts.

### Step 5: Deploy to Vercel (optional)

```bash
npx vercel --prod
```

Or connect the folder to Vercel via the dashboard. Set the environment variables (`NEXT_PUBLIC_API_URL`, `SESSION_SECRET`) in your Vercel project settings.

> [!TIP]
> The free Vercel tier is sufficient. The dashboard makes server-side API calls to your Open Brain REST endpoint — there's no heavy compute.

## Expected Outcome

When working correctly:

- **Login page** accepts your Open Brain API key and redirects to the dashboard
- **Dashboard** shows thought count, type distribution chart, top topics, and recent thoughts
- **Browse** displays a paginated table of all thoughts with working type/source/importance filters
- **Search** returns results with similarity scores (semantic mode) or rank scores (full-text mode)
- **Add to Brain** auto-routes short text (< 500 chars, single paragraph) to single capture, and long/structured text to extraction with dry-run preview
- **Detail page** shows full thought content with metadata, inline edit for content/type/importance, and linked reflections

## Workflow Board

The Workflow page adds a visual kanban board for managing `task` and `idea` thoughts through status stages.

### Features

- **Drag-and-drop** between status columns using @dnd-kit (touch-friendly with 200ms hold delay)
- **Collapsible columns** — click the arrow to collapse any column to a slim vertical bar (persisted in localStorage)
- **Auto-adjusting widths** — expanded columns share available space equally, no horizontal scrollbar
- **Inline editing** — tap a card to open the edit modal (status, priority, type, content)
- **Priority dots** — click to change priority (Critical/High/Medium/Low mapped from importance 0-100)
- **Dashboard widget** — summary of active workflow items on the main dashboard
- **Mobile-first** — responsive layout, pinch-to-zoom enabled, full-screen edit modal on small screens

### Status Flow

```
New → Planning → Active → Review → Done → (Archived)
```

Cards auto-archive from Done after 30 days. Archived cards are hidden by default (toggle with "Show archived").

### Database Requirements

The Workflow board requires two additional columns on the `thoughts` table. See the [workflow-status schema](../../schemas/workflow-status/) for the migration SQL.

### MCP Integration

The `progress_task` tool in the Open Brain MCP server allows AI assistants to update task status and priority conversationally:

```
"Move the API redesign task to active"
"Set priority on thought 42 to high"
```

When a new task or idea is captured, the MCP server auto-assigns `status: "new"`.

## REST API Endpoints Required

The dashboard calls these endpoints on your Open Brain REST API:

| Endpoint | Method | Used By |
|----------|--------|---------|
| `/health` | GET | Login validation |
| `/thoughts` | GET | Thoughts page (paginated, filtered) |
| `/thought/:id` | GET, PUT, DELETE | Detail page; inline edit; delete |
| `/search` | POST | Thoughts page semantic + full-text search |
| `/stats` | GET | Dashboard KPIs + type donut |
| `/capture` | POST | Add to Brain (single thought) |
| `/thought/:id/reflection` | GET | Detail page linked reflections |
| `/ingest` | POST | Add to Brain extraction path |
| `/ingestion-jobs` | GET | Job history |
| `/duplicates` | GET | Thoughts page duplicates filter |
| `/thoughts?type=task,idea&status=…` | GET | Workflow board |
| `/thoughts?review_status=pending_review&source_type=plaud` | GET | Review page |
| `/capture-pending` | POST | Plaud webhook — capture pending review |
| `/review/approve` | POST | Review page batch approve |
| `/wiki-pages` | GET | Wiki page list |
| `/wiki-pages/:slug` | GET, PUT | Wiki page detail; manual edit (rare) |
| `/wiki-pages/:slug/notes` | PATCH | Curator note save (highest-authority for next regen) |
| `/entities` | GET | Entity merge / alias / type management |
| `/entities/:id` | PATCH, DELETE | Rename / retype / delete |
| `/entities/:id/edges` | GET | Wiki Relationships card (each edge includes `other_slug`) |
| `/entities/:id/aliases` | PATCH | Alias add / remove |
| `/entities/:id/merge` | POST | Merge two entities |
| `/edges`, `/edge-blocklist` | GET, DELETE | Edit Relationships modal |
| **`/entity-types`** | GET | **Dynamic legend + filter chips** (Dashboard, Wiki). Returns `[{ entity_type, label, color, count }]`. |
| **`/sources`** | GET | **Dynamic Source dropdown** on Thoughts page. |
| **`/constellation?days=&limit=&min_weight=`** | GET | **Dashboard hero + Wiki graph view**. Returns top entities by mention + co-occurrence edges, with each node carrying its wiki `slug`. |
| `/action-items` | GET | Actions page |

The three bolded endpoints were added during the OB1 redesign and must be present for Dashboard / Thoughts / Wiki to render correctly.

> [!NOTE]
> If your Open Brain instance doesn't have all these endpoints (e.g., no smart-ingest or duplicates), those pages will show errors but the core pages (dashboard, browse, search, detail) will still work.



## Authentication

The dashboard uses **iron-session** for encrypted HTTP-only session cookies:

1. User enters their Open Brain API key once at login
2. Key is validated against the `/health` endpoint
3. Key is stored in an encrypted session cookie (not in client-side JS or localStorage)
4. All server-side API calls use the key from the session
5. Sessions expire after 24 hours

No API key is stored in environment variables or exposed to the browser.

## Tech Stack

- **Next.js 16** (App Router, Turbopack)
- **React 19** with TypeScript
- **Tailwind CSS 4** (dark theme) + a parallel design-token layer in `globals.css` for the redesigned pages
- **iron-session 8** (encrypted cookies)
- **@dnd-kit** (drag-and-drop for the Workflow board)
- The constellation graph in `components/design/ThoughtGraph.tsx` is a hand-rolled SVG force layout — no d3-force or external graph library, keeps the bundle slim.
- Zero external runtime dependencies beyond these

## Troubleshooting

1. **"Could not reach API" on login** — Verify `NEXT_PUBLIC_API_URL` is correct and your REST API gateway (`open-brain-rest`) is deployed. Test with: `curl https://YOUR-REF.supabase.co/functions/v1/open-brain-rest/health -H "x-brain-key: YOUR_KEY"`.

2. **"SESSION_SECRET env var is required"** — The app requires a 32+ character secret for cookie encryption. Generate one with `openssl rand -hex 32`.

3. **Build fails with SWC error** — This happens when `node_modules` was installed on a different platform (e.g., Windows modules on Linux). Delete `node_modules` and `package-lock.json`, then run `npm install` on your target platform.

4. **Search returns no results** — Ensure your thoughts have embeddings. Semantic search requires the `embedding` column to be populated. Run an embedding backfill if needed.

5. **Ingest page shows "extracting" forever** — Check that the `smart-ingest` Edge Function is deployed. The ingest feature depends on a separate Edge Function for document extraction.
