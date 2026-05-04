# AGENTS.md — Agent Instructions for Open Brain

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
- **MCP servers must be remote (Supabase Edge Functions), not local.** Never use `claude_desktop_config.json`, `StdioServerTransport`, or local Node.js servers. All extensions deploy as Edge Functions and are connected via each AI client's custom connector or MCP settings UI. See `AJO_Readme.md` Phase 6 for client-specific connection instructions (Claude, ChatGPT, Perplexity, Copilot, etc.).

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

---

## AJO Fork — Maintainer Notes

This section applies to the AJO maintainer-local layer only. It is not part of the upstream contribution contract.

### Environment Variables

The AJO fork uses different env var names than upstream recipes. Scripts handle both:

| AJO name | Upstream alias | Purpose |
|----------|---------------|---------|
| `SUPABASE_URL` | `OPEN_BRAIN_URL` | Supabase project URL |
| `SUPABASE_KEY` | `OPEN_BRAIN_SERVICE_KEY` | Service role key |
| `OLLAMA_URL` | — | Ollama base URL (e.g. `http://localhost:11434/api`) |
| `OLLAMA_MODEL` | `LLM_MODEL` | Model name (e.g. `qwen3:30b`) |
| `BRAIN_KEY` | — | Dashboard + REST API password |

### Edge Function Deployment

Always deploy with `--use-api --no-verify-jwt`:
```powershell
npx.cmd supabase functions deploy rest-api --use-api --no-verify-jwt
npx.cmd supabase functions deploy open-brain-mcp --use-api --no-verify-jwt
```

### Maintainer Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| Score thoughts | `node --env-file=.env scripts/score-thoughts.mjs` | Heuristic quality scoring (run once after install, then with `--only-default`) |
| Wiki wipe | `node --env-file=.env scripts/wiki-wipe.mjs` | Clear wiki_pages + entity health report |
| Batch wiki | `node --env-file=.env recipes/entity-wiki/generate-wiki.mjs --batch` | Regenerate all wiki pages |
| Autobiography | `node --env-file=.env recipes/wiki-synthesis/scripts/synthesize-wiki.mjs --topic autobiography` | Generate/update personal autobiography wiki page |
| Reclassify | `node --env-file=.env scripts/reclassify-existing.js` | Re-run Work/Personal classification on existing thoughts |

### Quality Score Behaviour

- `quality_score` defaults to 50 at creation. The extraction worker computes `Math.round(confidence × 70 + 20)` during capture, but existing thoughts need a one-time backfill via `score-thoughts.mjs`.
- The heuristic scorer uses: content length (base), word count, vocabulary richness, sentence count, URL/caps/encoding penalties, and metadata bonuses (type, importance, topics, entities, summary).
- The Audit page threshold (default < 30) is configurable in the UI — no code change needed.

### Wiki Pipeline

- `generate-wiki.mjs --batch` always regenerates all pages (the `manually_edited` column is no longer respected by the compiler).
- Curator notes live in the `notes` column and survive regeneration — the compiler reads them and injects them into the LLM prompt.
- Citations use integer `serial_id` format `[#42]`. Entity cross-links use `/wiki?slug=person-name` format.
- After entity merges, wipe and rebuild: `wiki-wipe.mjs` then `generate-wiki.mjs --batch --batch-min-linked 1`.

### Dashboard Proxy Routes (Next.js)

The dashboard proxies to the Edge Function for auth. Key routes added for the wiki:
- `PATCH /api/wiki/[slug]/notes` → Edge Function `PATCH /wiki-pages/:slug/notes`
- `PATCH /api/entities/[id]` → Edge Function `PATCH /entities/:id` (rename)

### Gitignored Local Output

`wikis/`, `compiled-wiki/`, and `output/` directories are gitignored — local wiki file output never reaches the remote.
