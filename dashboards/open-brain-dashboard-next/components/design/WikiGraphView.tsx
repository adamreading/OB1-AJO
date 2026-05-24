"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ThoughtGraph,
  type ConstellationEdge,
  type ConstellationNode,
  type EntityTypeInfo,
} from "./ThoughtGraph";
import { Card, SegBar } from "./Atoms";

interface WikiPageDetail {
  id: number;
  slug: string;
  title: string;
  type: string;
  entity_id: number | null;
  generated_at: string;
  thought_count: number;
  content: string;
  notes?: string | null;
  aliases?: string[];
  metadata?: { entity_type?: string } & Record<string, unknown>;
}

interface EdgeRow {
  edge_id: number;
  relation: string;
  other_id: number;
  other_name: string;
  other_type: string;
  other_slug: string | null;
  support_count: number;
  direction: "out" | "in";
}

interface ReflectionRow {
  id: number;
  thought_id: string;
  reflection_type: string;
  trigger_context: string;
  conclusion: string;
  options: { label: string }[];
  factors: { label: string; weight: number }[];
  confidence: number;
  created_at: string;
  source_thought_serial: number | null;
  source_thought_preview: string;
}

interface WikiGraphViewProps {
  selected: WikiPageDetail | null;
  onSelectSlug: (slug: string) => void;
  onSaveNotes: (notes: string) => Promise<void>;
  onRegenerate?: () => void;
  onOpenThoughts?: () => void;
  /** Entity-management triggers — re-use the same modals the List view opens. */
  onRename?: () => void;
  onAliases?: () => void;
  onEdges?: () => void;
  onAbsorb?: () => void;
  onMerge?: () => void;
  onDelete?: () => Promise<void> | void;
  /** Status of the most recent regen request, surfaced in the Regen button
   *  label so the user gets feedback that the request landed (the actual
   *  article refresh happens out-of-band on the worker, 30-60s later). */
  regenStatus?: "idle" | "queueing" | "queued";
  /** Fired when the inline entity-type dropdown saves a new type. Parent
   *  caches both list + selected detail and updates them. */
  onTypeChanged?: (newType: string) => void;
  /** Two-step delete confirm state, lifted from parent so all modals share state. */
  confirmDelete?: boolean;
  setConfirmDelete?: (v: boolean) => void;
  deleting?: boolean;
}

interface SectionMap {
  // New (post-2026-05-10): TLDR + Detailed narrative
  tldr?: string;
  detailed?: string;
  // Legacy (pre-regen): structured Summary + Key Facts + Timeline. Kept so
  // pages compiled before the prompt change still render correctly until
  // they're regenerated.
  summary?: string;
  keyFacts?: string;
  timeline?: string;
  // Always-structured
  openQuestions?: string;
  rest: { heading: string; body: string }[];
}

// Split markdown into named sections by H2 headings. Sections that fit one of
// the named slots are stored against that key; everything else is preserved
// in `rest` for the left column to render after the named blocks.
function parseSections(markdown: string): SectionMap {
  // Defensive: if the stored content contains multiple article drafts
  // (Qwen3 chain-of-thought leakage produces repeated `# {Entity}` H1
  // blocks), keep only the LAST draft so we render the model's final
  // answer. The cleaner in generate-wiki.mjs handles new pages; this
  // protects rendering of pages compiled before that fix shipped.
  let working = markdown;
  const h1Matches = [...markdown.matchAll(/^# [^\n]+$/gm)];
  if (h1Matches.length > 1) {
    const last = h1Matches[h1Matches.length - 1];
    working = markdown.slice(last.index);
  } else {
    const tldrMatches = [...markdown.matchAll(/^## TLDR\b/gm)];
    if (tldrMatches.length > 1) {
      const last = tldrMatches[tldrMatches.length - 1];
      working = markdown.slice(last.index);
    }
  }

  const lines = working.split("\n");
  const sections: { heading: string; body: string[] }[] = [];
  let current: { heading: string; body: string[] } | null = null;
  let preamble: string[] = [];

  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      if (current) sections.push(current);
      current = { heading: m[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push(current);

  const result: SectionMap = { rest: [] };
  // If markdown has any preamble before the first H2, treat it as TLDR
  const preambleText = preamble.join("\n").trim();
  if (preambleText) {
    result.tldr = preambleText.replace(/^#\s+.+$/m, "").trim();
  }

  // Track "rest" by heading so repeated H2s in malformed content collapse
  // to one entry (last wins). Without this, React renders duplicates with
  // the same key and warns.
  const restByHeading = new Map<string, string>();

  for (const s of sections) {
    const h = s.heading.toLowerCase();
    const body = s.body.join("\n").trim();
    if (!body) continue;
    // New format — last wins for consistency with malformed multi-draft input
    if (h === "tldr" || h === "tl;dr" || h.startsWith("tldr")) {
      result.tldr = body;
    } else if (h.startsWith("detailed") || h === "story" || h === "about") {
      result.detailed = body;
    }
    // Legacy
    else if (h.includes("summary")) result.summary = body;
    else if (h.includes("key fact")) result.keyFacts = body;
    else if (h.includes("timeline")) result.timeline = body;
    // Always
    else if (h.includes("open question")) result.openQuestions = body;
    // Skip parsed-markdown "Relationships" — the right-column live edges
    // card is the source-of-truth and they'd otherwise duplicate.
    else if (h.includes("relationship")) continue;
    else restByHeading.set(s.heading, body);
  }
  result.rest = Array.from(restByHeading.entries()).map(([heading, body]) => ({ heading, body }));
  // If neither TLDR nor Summary survived, but we had a preamble, the preamble
  // already populated TLDR. If a legacy page only has Summary, treat Summary
  // as TLDR for rendering — both go in the same slot.
  if (!result.tldr && result.summary) {
    result.tldr = result.summary;
    delete result.summary;
  }
  return result;
}

// Render markdown with #N citation chips, [Entity Name] auto-linking, lists,
// **bold**. Mirrors the existing wiki MarkdownContent but trimmed for
// section bodies rather than full pages.
//
// Plain-text segments are passed through `linkifyEntities` so bare entity
// references like "Adam Ososki" or "Promptinator" become clickable, not just
// the few cases where the LLM emitted markdown links. `selfSlug`, when given,
// is the slug of the entity being viewed — we skip auto-linking it to itself.
function linkifyEntities(
  text: string,
  entityMap: Map<string, string>,
  onWikiLink: (slug: string) => void,
  selfSlug: string | null,
  keyBase: string
): React.ReactNode[] {
  if (!entityMap || entityMap.size === 0 || !text) return [text];
  // Build a regex from entity names sorted longest-first so multi-word matches
  // like "AWS EC2" win over the substring "AWS". Escape regex metachars so a
  // canonical_name with "(" or "." doesn't blow up the pattern.
  const names = Array.from(entityMap.keys())
    .filter((n) => n.length > 1)
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return [text];
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // \b word boundaries on either side. Case-insensitive so we match the user's
  // capitalization in prose ("Adam Ososki", "ADAM OSOSKI", etc.).
  const pattern = new RegExp(`\\b(?:${escaped.join("|")})\\b`, "gi");

  const out: React.ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > lastIdx) out.push(text.slice(lastIdx, m.index));
    const matched = m[0];
    const slug = entityMap.get(matched.toLowerCase());
    if (slug && slug !== selfSlug) {
      out.push(
        <button
          key={`${keyBase}-${i++}`}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onWikiLink(slug);
          }}
          style={{
            color: "var(--violet-300)",
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: "inherit",
            fontWeight: "inherit",
            textDecoration: "underline",
            textUnderlineOffset: 2,
            textDecorationColor: "rgba(157,131,255,0.4)",
          }}
        >
          {matched}
        </button>
      );
    } else {
      out.push(matched);
    }
    lastIdx = m.index + matched.length;
    // Defensive: if regex fails to advance (e.g. zero-width match), break
    if (m.index === pattern.lastIndex) pattern.lastIndex++;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}

function renderMarkdownInline(
  text: string,
  entityMap: Map<string, string>,
  onWikiLink: (slug: string) => void,
  selfSlug: string | null = null
): React.ReactNode {
  const elements: React.ReactNode[] = [];
  const lines = text.split("\n");
  let listBuffer: string[] = [];

  function inline(s: string): React.ReactNode {
    // Process tokens in order. Build out a node array.
    const out: React.ReactNode[] = [];
    let remaining = s;
    let key = 0;
    while (remaining.length > 0) {
      const citationMatch = remaining.match(/^\[(#?\d+(?:\s*,\s*#?\d+)*)\]/);
      // Full markdown link: [Name](url). Optional whitespace between ] and (
      // because the LLM occasionally inserts a space.
      const mdLinkMatch =
        !citationMatch && remaining.match(/^\[([^\]]+)\]\s*\(([^)]+)\)/);
      // Bare bracket fallback: [Name] without (url) — used when the LLM
      // emits an entity reference without the markdown link.
      const linkMatch =
        !citationMatch && !mdLinkMatch && remaining.match(/^\[([^\]]+)\]/);
      const boldMatch =
        !citationMatch &&
        !mdLinkMatch &&
        !linkMatch &&
        remaining.match(/^\*\*([^*]+)\*\*/);

      if (citationMatch) {
        const ids = citationMatch[1]
          .split(/\s*,\s*/)
          .map((x) => x.replace(/^#/, ""));
        ids.forEach((id, i) => {
          out.push(
            <a
              key={`c-${key}-${i}`}
              href={`/thoughts/${id}`}
              onClick={(e) => e.stopPropagation()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "0 5px",
                margin: "0 2px",
                borderRadius: 3,
                background: "var(--bg-3)",
                border: "1px solid var(--line)",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "var(--fg-4)",
                textDecoration: "none",
                verticalAlign: "middle",
              }}
            >
              #{id}
            </a>
          );
          if (i < ids.length - 1) out.push(", ");
        });
        remaining = remaining.slice(citationMatch[0].length);
        key++;
      } else if (mdLinkMatch) {
        const label = mdLinkMatch[1];
        const url = mdLinkMatch[2].trim();
        // /wiki?slug=foo or /wiki/foo → in-page entity navigation
        const slugMatch =
          url.match(/^\/wiki\?slug=([^&#]+)/) ||
          url.match(/^\/wiki\/([^/?#]+)/);
        if (slugMatch && slugMatch[1] !== selfSlug) {
          const slug = decodeURIComponent(slugMatch[1]);
          out.push(
            <button
              key={`md-${key}`}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onWikiLink(slug);
              }}
              style={{
                display: "inline-flex",
                padding: "0px 6px",
                margin: "0 1px",
                borderRadius: 4,
                background: "rgba(157,131,255,0.10)",
                border: "1px solid rgba(157,131,255,0.2)",
                color: "var(--violet-200)",
                fontSize: "inherit",
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          );
        } else if (/^\/thoughts\/(\d+)/.test(url)) {
          // /thoughts/N — render as a thought citation chip
          const id = url.match(/^\/thoughts\/(\d+)/)![1];
          out.push(
            <a
              key={`md-t-${key}`}
              href={`/thoughts/${id}`}
              onClick={(e) => e.stopPropagation()}
              style={{
                display: "inline-flex",
                padding: "0 6px",
                borderRadius: 4,
                background: "rgba(157,131,255,0.10)",
                border: "1px solid rgba(157,131,255,0.2)",
                color: "var(--violet-200)",
                fontSize: "inherit",
                textDecoration: "none",
              }}
            >
              {label}
            </a>
          );
        } else {
          // External / unknown — plain link
          const safe =
            url.startsWith("/") ||
            url.startsWith("https://") ||
            url.startsWith("http://")
              ? url
              : "#";
          out.push(
            <a
              key={`md-x-${key}`}
              href={safe}
              target={safe.startsWith("http") ? "_blank" : undefined}
              rel={safe.startsWith("http") ? "noreferrer" : undefined}
              style={{ color: "var(--violet-300)", textDecoration: "underline" }}
            >
              {label}
            </a>
          );
        }
        remaining = remaining.slice(mdLinkMatch[0].length);
        key++;
      } else if (linkMatch) {
        const inner = linkMatch[1];
        const slug = entityMap.get(inner.trim().toLowerCase());
        if (slug) {
          out.push(
            <button
              key={`l-${key}`}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onWikiLink(slug);
              }}
              style={{
                display: "inline-flex",
                padding: "0px 6px",
                margin: "0 1px",
                borderRadius: 4,
                background: "rgba(157,131,255,0.10)",
                border: "1px solid rgba(157,131,255,0.2)",
                color: "var(--violet-200)",
                fontSize: "inherit",
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              {inner}
            </button>
          );
        } else {
          out.push(linkMatch[0]);
        }
        remaining = remaining.slice(linkMatch[0].length);
        key++;
      } else if (boldMatch) {
        out.push(
          <strong key={`b-${key}`} style={{ color: "var(--fg)" }}>
            {boldMatch[1]}
          </strong>
        );
        remaining = remaining.slice(boldMatch[0].length);
        key++;
      } else {
        // Plain text run — pass through linkifyEntities so bare entity names
        // become clickable links against the entityMap.
        const next = remaining.search(/[\[*]/);
        let chunk: string;
        if (next === -1) {
          chunk = remaining;
          remaining = "";
        } else if (next === 0) {
          chunk = remaining[0];
          remaining = remaining.slice(1);
        } else {
          chunk = remaining.slice(0, next);
          remaining = remaining.slice(next);
        }
        const linked = linkifyEntities(
          chunk,
          entityMap,
          onWikiLink,
          selfSlug,
          `auto-${key++}`
        );
        for (const node of linked) out.push(node);
      }
    }
    return out;
  }

  function flushList() {
    if (listBuffer.length === 0) return;
    elements.push(
      <ul
        key={`ul-${elements.length}`}
        style={{
          margin: "0 0 12px 0",
          padding: 0,
          listStyle: "none",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {listBuffer.map((item, i) => (
          <li
            key={i}
            style={{
              display: "flex",
              gap: 12,
              fontSize: 14,
              color: "var(--fg-2)",
              lineHeight: 1.55,
            }}
          >
            <span
              style={{
                color: "var(--violet-400)",
                fontFamily: "var(--font-mono)",
                flexShrink: 0,
                marginTop: 2,
              }}
            >
              •
            </span>
            <span>{inline(item)}</span>
          </li>
        ))}
      </ul>
    );
    listBuffer = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[-*]\s+/.test(trimmed)) {
      listBuffer.push(trimmed.replace(/^[-*]\s+/, ""));
    } else if (/^###\s+/.test(trimmed)) {
      flushList();
      elements.push(
        <h4
          key={`h-${elements.length}`}
          style={{
            margin: "16px 0 8px",
            fontSize: 13,
            fontWeight: 500,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: "var(--fg-3)",
          }}
        >
          {trimmed.replace(/^###\s+/, "")}
        </h4>
      );
    } else if (trimmed) {
      flushList();
      elements.push(
        <p
          key={`p-${elements.length}`}
          style={{
            margin: "0 0 12px 0",
            fontSize: 14.5,
            lineHeight: 1.65,
            color: "var(--fg-2)",
          }}
        >
          {inline(trimmed)}
        </p>
      );
    }
  }
  flushList();
  return elements;
}

const RELATION_LABELS: Record<string, string> = {
  works_on: "works on",
  works_with: "works with",
  reports_to: "reports to",
  member_of: "member of",
  uses: "uses",
  alternative_to: "alternative to",
  integrates_with: "integrates with",
  collaborates_with: "collaborates with",
  related_to: "related to",
  co_occurs_with: "co-occurs with",
  knew: "knew",
  friend_of: "friend of",
  family_of: "family of",
  mentor_of: "mentor of",
  introduced_via: "met via",
  published_by: "published by",
  references: "references",
};

export function WikiGraphView({
  selected,
  onSelectSlug,
  onSaveNotes,
  onRegenerate,
  onOpenThoughts,
  onRename,
  onAliases,
  onEdges,
  onAbsorb,
  onMerge,
  onDelete,
  regenStatus = "idle",
  onTypeChanged,
  confirmDelete = false,
  setConfirmDelete,
  deleting = false,
}: WikiGraphViewProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [graph, setGraph] = useState<{
    nodes: ConstellationNode[];
    edges: ConstellationEdge[];
  }>({ nodes: [], edges: [] });

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const [graphLoading, setGraphLoading] = useState(true);
  const [minWeight, setMinWeight] = useState(2);
  const [topN, setTopN] = useState<"30" | "60" | "100">("60");
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [entityTypes, setEntityTypes] = useState<EntityTypeInfo[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [edges, setEdges] = useState<EdgeRow[]>([]);
  const [edgesLoading, setEdgesLoading] = useState(false);
  const [reflections, setReflections] = useState<ReflectionRow[]>([]);
  const [reflectionsLoading, setReflectionsLoading] = useState(false);
  const [entityMap, setEntityMap] = useState<Map<string, string>>(new Map());
  // Full searchable index of every wiki-paged entity (id, entity_id, title,
  // slug, aliases). Used by the constellation search box so typing matches
  // canonical_name OR any alias, even for entities not currently in the
  // top-N / focus neighbourhood. Without this, searching for "Peter"
  // would return nothing whenever Peter wasn't already loaded into the graph.
  const [wikiIndex, setWikiIndex] = useState<
    Array<{ entity_id: number; title: string; slug: string; aliases: string[] }>
  >([]);

  // Pull dynamic entity types
  useEffect(() => {
    fetch("/api/entity-types")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.types) setEntityTypes(d.types as EntityTypeInfo[]);
      })
      .catch(() => {});
  }, []);

  // Resolve the search query against the full wiki index (canonical_name AND
  // every alias). Returns the matched entity_ids — these power both the
  // graph filter and the auto-refocus refetch below.
  //
  // Three layers of matching, most-specific first:
  //  1. Full-substring: query appears as a substring of title/alias. Fast,
  //     catches "tom" -> "Tom Falconar".
  //  2. Token-overlap: any individual word in the query (>= 3 chars) appears
  //     as a substring of a title/alias word. Catches "thomas falconar"
  //     against "Tom Falconar" because "falconar" matches. Also catches
  //     "scott pease" against "Dr Scott Pease" because both tokens match
  //     somewhere in the title.
  //  3. Aliases get the same treatment so legal-name <-> nickname mappings
  //     also fuzzy-match. To get "Thomas" -> Tom Falconar, add "Thomas" as
  //     an alias on entity #6 (token-overlap can't bridge "tom" vs "thomas"
  //     since neither contains the other; alias is the right answer).
  const searchMatchIds = useMemo<Set<number>>(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q || wikiIndex.length === 0) return new Set();

    // Tokenize the query — drop short fillers ("of", "an", numerics).
    const queryTokens = q.split(/\s+/).filter((t) => t.length >= 3);

    const matched = new Set<number>();
    for (const p of wikiIndex) {
      const titleLower = p.title.toLowerCase();
      const aliasLowers = p.aliases.map((a) => a.toLowerCase());

      // Layer 1: full substring match
      if (titleLower.includes(q) || aliasLowers.some((a) => a.includes(q))) {
        matched.add(p.entity_id);
        continue;
      }

      // Layer 2: token overlap. Build the page's token set from title +
      // aliases, then check if ANY query token has a substring match in
      // ANY page token. Single-token overlap is enough — "falconar" alone
      // identifies Tom Falconar even when the rest of the query is wrong.
      if (queryTokens.length === 0) continue;
      const pageTokens = [titleLower, ...aliasLowers]
        .flatMap((s) => s.split(/\s+/))
        .filter((t) => t.length >= 3);
      const overlap = queryTokens.some((qt) =>
        pageTokens.some((pt) => pt.includes(qt) || qt.includes(pt))
      );
      if (overlap) matched.add(p.entity_id);
    }
    return matched;
  }, [searchQuery, wikiIndex]);

  // Pick a single best match to re-centre the constellation on. Always set
  // (when there are matches) regardless of whether the match is already
  // visible — re-centring on every search gives consistent UX, and depending
  // on `graph.nodes` here would create an infinite loop because the fetch
  // effect that consumes searchFocusId is exactly what updates graph.nodes.
  // Scoring prefers exact title hits over substring hits over alias-only
  // hits, so "Peter" lands on Peter, not "Peter Seibert" or peterpease.com.
  const searchFocusId = useMemo<number | null>(() => {
    if (searchMatchIds.size === 0) return null;
    const q = searchQuery.trim().toLowerCase();
    let best: { entity_id: number; score: number } | null = null;
    for (const p of wikiIndex) {
      if (!searchMatchIds.has(p.entity_id)) continue;
      const title = p.title.toLowerCase();
      let score = 0;
      if (title === q) score = 100;
      else if (title.startsWith(q)) score = 50;
      else if (title.includes(q)) score = 10;
      else score = 1; // alias-only match
      if (!best || score > best.score) best = { entity_id: p.entity_id, score };
    }
    return best?.entity_id ?? null;
  }, [searchMatchIds, searchQuery, wikiIndex]);

  // Pull constellation. Refetches when:
  //  - top-N chooser changes (slot count)
  //  - selected entity_id changes (focus mode → centre on that entity and
  //    fetch all its co-occurring neighbours, not just the global top-N)
  //  - hiddenTypes changes (type-filter chips → server excludes those types
  //    from selection so freed slots go to entities you actually want)
  //  - searchFocusId changes (alias-aware search auto-centres the
  //    constellation on the best match)
  // The min_weight slider stays a pure client-side dim/filter — it doesn't
  // touch the fetch deps, so dragging it doesn't re-hit the server.
  useEffect(() => {
    let cancelled = false;
    setGraphLoading(true);
    // Focus precedence:
    //   1. searchFocusId — a search match outside the current graph re-centres
    //      so the matched entity actually becomes visible.
    //   2. selected.entity_id — the wiki page the user is reading.
    //   3. (neither) — default top-N by mention count.
    // Focus mode pulls the entity's full history (days=0) so sparsely-mentioned
    // entities (an old friend, a one-meeting project) still surface their
    // neighbourhood. Default mode keeps the 90-day window so the unfocused
    // constellation reflects what's currently hot.
    const effectiveFocusId = searchFocusId ?? selected?.entity_id ?? null;
    const inFocus = effectiveFocusId !== null;
    const params = new URLSearchParams({
      days: inFocus ? "0" : "90",
      limit: topN,
      min_weight: "1",
    });
    if (inFocus) params.set("focus_id", String(effectiveFocusId));
    if (hiddenTypes.size > 0) {
      params.set("excluded_types", Array.from(hiddenTypes).join(","));
    }
    fetch(`/api/constellation?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setGraph({ nodes: data.nodes ?? [], edges: data.edges ?? [] });
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setGraphLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [topN, selected?.entity_id, hiddenTypes, searchFocusId]);

  // Build entity-name → slug map for [Entity Name] resolution in markdown
  // AND the searchable index for the constellation search box.
  useEffect(() => {
    fetch("/api/wiki")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.data) return;
        const map = new Map<string, string>();
        const index: Array<{
          entity_id: number;
          title: string;
          slug: string;
          aliases: string[];
        }> = [];
        for (const p of d.data as {
          entity_id: number | null;
          title: string;
          slug: string;
          aliases?: string[];
        }[]) {
          map.set(p.title.toLowerCase(), p.slug);
          for (const a of p.aliases ?? []) map.set(a.toLowerCase(), p.slug);
          if (p.entity_id != null) {
            index.push({
              entity_id: p.entity_id,
              title: p.title,
              slug: p.slug,
              aliases: p.aliases ?? [],
            });
          }
        }
        setEntityMap(map);
        setWikiIndex(index);
      })
      .catch(() => {});
  }, []);

  // Pull edges for the selected entity
  useEffect(() => {
    if (!selected?.entity_id) {
      setEdges([]);
      return;
    }
    let cancelled = false;
    setEdgesLoading(true);
    fetch(`/api/entities/${selected.entity_id}/edges`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.edges) return;
        setEdges(d.edges as EdgeRow[]);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setEdgesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.entity_id]);

  // Pull reflections attached to any thought linked to this entity
  useEffect(() => {
    if (!selected?.entity_id) {
      setReflections([]);
      return;
    }
    let cancelled = false;
    setReflectionsLoading(true);
    fetch(`/api/entities/${selected.entity_id}/reflections`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.reflections) return;
        setReflections(d.reflections as ReflectionRow[]);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setReflectionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.entity_id]);

  function toggleType(t: string) {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  // Apply search filter to nodes. When searching, keep matches PLUS their
  // first-degree neighbors so the user can see what the matched entity is
  // connected to — searching "gemini" alone with no neighbors is just a
  // single floating node, useless for navigation.
  const filteredNodes = useMemo(() => {
    if (!searchQuery.trim()) return graph.nodes;
    // Use the alias-aware match set against the graph
    const matchIds = new Set(
      graph.nodes.filter((n) => searchMatchIds.has(n.id)).map((n) => n.id)
    );
    if (matchIds.size === 0) return [];
    const keep = new Set(matchIds);
    for (const e of graph.edges) {
      if (matchIds.has(e.source)) keep.add(e.target);
      if (matchIds.has(e.target)) keep.add(e.source);
    }
    return graph.nodes.filter((n) => keep.has(n.id));
  }, [graph.nodes, graph.edges, searchQuery, searchMatchIds]);

  // Active search wins as the visual center. Without this, typing
  // "tom falconar" while the Adam Ososki wiki is open would refetch the
  // constellation centred on Tom (correct) BUT the visual pin would stay
  // on Adam (wrong) because the wiki-page selection took precedence in
  // the renderer. So Tom would appear as a small satellite of Adam,
  // exactly the opposite of what a search-then-find UX expects.
  const selectedNode = useMemo(() => {
    if (searchFocusId !== null) {
      return graph.nodes.find((n) => n.id === searchFocusId) ?? null;
    }
    if (!selected) return null;
    return graph.nodes.find((n) => n.slug === selected.slug) ?? null;
  }, [graph.nodes, selected, searchFocusId]);

  const sections = useMemo(
    () => (selected?.content ? parseSections(selected.content) : null),
    [selected?.content]
  );

  function handleNodeClick(node: ConstellationNode) {
    if (node.slug) onSelectSlug(node.slug);
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 22,
        padding: "8px 0",
      }}
    >
      {/* Constellation hero — collapsible */}
      <div
        style={{
          borderRadius: 16,
          overflow: "hidden",
          background:
            "radial-gradient(ellipse at 50% 30%, rgba(130,97,255,0.10), color-mix(in srgb, var(--bg-1) 60%, transparent))",
          border: "1px solid var(--line)",
          position: "relative",
          transition: "all 0.25s ease",
        }}
      >
        {/* Filter rail */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            flexWrap: "wrap",
            padding: "14px 20px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <span className="eyebrow">Constellation</span>
          <div style={{ width: 1, height: 16, background: "var(--line)" }} />

          {/* Min co-occurrence */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minWidth: 220,
            }}
          >
            <span className="eyebrow">min co-occurrence</span>
            <input
              type="range"
              min={1}
              max={Math.max(
                5,
                Math.min(20, ...graph.edges.map((e) => e.weight + 1))
              )}
              value={minWeight}
              onChange={(e) => setMinWeight(parseInt(e.target.value, 10))}
              style={{ flex: 1, accentColor: "var(--violet-400)" }}
            />
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--fg-2)",
                width: 14,
              }}
            >
              {minWeight}
            </span>
          </div>

          {/* Top-N — server returns top-N entities by mention count */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span className="eyebrow">top</span>
            <SegBar
              options={["30", "60", "100"] as const}
              active={topN}
              onChange={setTopN}
              size="sm"
            />
          </div>

          {/* Type toggle chips */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {entityTypes.map((t) => {
              const hidden = hiddenTypes.has(t.entity_type);
              return (
                <button
                  key={t.entity_type}
                  type="button"
                  onClick={() => toggleType(t.entity_type)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    padding: "4px 9px",
                    borderRadius: 6,
                    background: hidden ? "transparent" : "rgba(255,255,255,0.04)",
                    border: `1px solid ${
                      hidden ? "var(--line)" : "var(--line-strong)"
                    }`,
                    color: hidden ? "var(--fg-4)" : "var(--fg-2)",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    opacity: hidden ? 0.5 : 1,
                    textDecoration: hidden ? "line-through" : "none",
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: t.color,
                      opacity: hidden ? 0.4 : 1,
                    }}
                  />
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* Search */}
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 10px",
              borderRadius: 8,
              background: "var(--bg-3)",
              border: "1px solid var(--line)",
              minWidth: 220,
              fontSize: 12,
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--fg-4)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="6" />
              <path d="m20 20-4-4" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Find an entity…"
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                color: "var(--fg)",
                fontSize: 12,
                fontFamily: "inherit",
              }}
            />
          </div>

          {/* Collapse toggle */}
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            style={{
              padding: "5px 10px",
              borderRadius: 8,
              fontSize: 11,
              background: "var(--bg-2)",
              border: "1px solid var(--line-strong)",
              color: "var(--fg-2)",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
            }}
          >
            {collapsed ? "↧ expand" : "↥ collapse"}
          </button>
        </div>

        {/* Graph canvas */}
        <div
          style={{
            position: "relative",
            transition: "all 0.25s ease",
            padding: collapsed ? "8px 12px" : "12px 12px 24px",
          }}
        >
          {graphLoading ? (
            <div
              style={{
                height: collapsed ? 100 : isMobile ? 320 : 480,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--fg-4)",
                fontSize: 12,
              }}
            >
              Loading constellation…
            </div>
          ) : (
            <ThoughtGraph
              nodes={filteredNodes}
              edges={graph.edges}
              width={isMobile ? 380 : 1100}
              height={collapsed ? 100 : isMobile ? 320 : 480}
              minWeight={minWeight}
              hiddenTypes={hiddenTypes}
              entityTypes={entityTypes}
              selectedId={selectedNode?.id ?? null}
              bypassMinWeightIds={searchMatchIds.size > 0 ? searchMatchIds : undefined}
              onNodeClick={handleNodeClick}
              collapsed={collapsed}
            />
          )}

          {/* Selected pill */}
          {selectedNode && !collapsed && (
            <div
              style={{
                position: "absolute",
                bottom: 14,
                right: 20,
                display: "flex",
                gap: 8,
                alignItems: "center",
                fontSize: 11,
                color: "var(--fg-3)",
                padding: "6px 12px",
                background: "color-mix(in srgb, var(--bg-0) 80%, transparent)",
                borderRadius: 6,
                border: "1px solid var(--line-strong)",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background:
                    entityTypes.find((t) => t.entity_type === selectedNode.type)
                      ?.color ?? "#9d83ff",
                }}
              />
              <span>Selected</span>
              <span style={{ color: "var(--fg)", fontWeight: 500 }}>
                {selectedNode.label}
              </span>
              <span style={{ color: "var(--fg-4)" }}>
                · {selectedNode.mentions} thoughts
                {edges.length > 0 ? ` · ${edges.length} relationships` : ""}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Wiki body */}
      {!selected ? (
        <div
          style={{
            padding: 32,
            textAlign: "center",
            color: "var(--fg-4)",
            fontSize: 13,
            border: "1px solid var(--line)",
            borderRadius: 14,
            background: "var(--bg-2)",
          }}
        >
          Click any entity in the constellation to load its wiki page.
        </div>
      ) : (
        <>
          {/* Body header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              padding: "4px 0",
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <EntityTypePill
                page={selected}
                entityTypes={entityTypes}
                onTypeChanged={onTypeChanged}
              />
              <h2
                style={{
                  margin: 0,
                  fontSize: 28,
                  fontWeight: 600,
                  letterSpacing: "-0.02em",
                  color: "var(--fg)",
                }}
              >
                {selected.title}
              </h2>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--fg-4)",
                }}
              >
                · {selected.thought_count} thought
                {selected.thought_count === 1 ? "" : "s"}
                {selected.generated_at
                  ? ` · last regen ${new Date(selected.generated_at)
                      .toISOString()
                      .slice(5, 10)}`
                  : ""}{" "}
                · slug: {selected.slug}
              </span>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {onOpenThoughts && (
                <button type="button" onClick={onOpenThoughts} style={ghostBtn}>
                  Open thoughts ({selected.thought_count})
                </button>
              )}
              {selected.entity_id != null && onRename && (
                <button type="button" onClick={onRename} style={ghostBtn} title="Rename entity">
                  Rename
                </button>
              )}
              {selected.entity_id != null && onAliases && (
                <button
                  type="button"
                  onClick={onAliases}
                  style={ghostBtn}
                  title="Manage aliases"
                >
                  Aliases
                  {(selected.aliases ?? []).length > 0
                    ? ` (${selected.aliases!.length})`
                    : ""}
                </button>
              )}
              {selected.entity_id != null && onEdges && (
                <button
                  type="button"
                  onClick={onEdges}
                  style={ghostBtn}
                  title="Edit relationships — remove wrong edges and blocklist them"
                >
                  Edges
                </button>
              )}
              {selected.entity_id != null && onAbsorb && (
                <button
                  type="button"
                  onClick={onAbsorb}
                  style={ghostBtn}
                  title="Absorb a duplicate into this entity"
                >
                  Absorb
                </button>
              )}
              {selected.entity_id != null && onMerge && (
                <button
                  type="button"
                  onClick={onMerge}
                  style={ghostBtn}
                  title="Merge this entity into another — this entity is deleted"
                >
                  Merge
                </button>
              )}
              {onRegenerate && (
                <button
                  type="button"
                  onClick={onRegenerate}
                  disabled={regenStatus !== "idle"}
                  title="Re-queue the entity's most recent thought so the local worker regenerates this article on its next drain (~30-60s)."
                  style={{
                    ...ghostBtn,
                    opacity: regenStatus === "idle" ? 1 : 0.6,
                    cursor: regenStatus === "idle" ? "pointer" : "not-allowed",
                  }}
                >
                  {regenStatus === "queueing"
                    ? "Queueing…"
                    : regenStatus === "queued"
                      ? "Queued ✓ (refresh in ~60s)"
                      : "Regenerate"}
                </button>
              )}
              {selected.entity_id != null && onDelete && (
                confirmDelete ? (
                  <span style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      onClick={() => onDelete()}
                      disabled={deleting}
                      style={{
                        padding: "7px 12px",
                        borderRadius: 8,
                        border: "1px solid rgba(255,80,80,0.6)",
                        background: "var(--crit)",
                        color: "#fff",
                        fontSize: 12,
                        fontWeight: 500,
                        cursor: deleting ? "not-allowed" : "pointer",
                        fontFamily: "inherit",
                        opacity: deleting ? 0.6 : 1,
                      }}
                    >
                      {deleting ? "Deleting…" : "Confirm delete"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete?.(false)}
                      style={ghostBtn}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete?.(true)}
                    title="Delete entity and wiki page"
                    style={{
                      ...ghostBtn,
                      borderColor: "rgba(255,80,80,0.3)",
                      color: "rgba(255,150,150,0.9)",
                    }}
                  >
                    Delete
                  </button>
                )
              )}
            </div>
          </div>

          {/* Two-column body */}
          <div
            className="mobile-stack"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 380px",
              gap: 16,
              alignItems: "flex-start",
            }}
          >
            {/* Left — Summary, Key Facts, Timeline */}
            <div
              style={{
                background: "var(--bg-2)",
                border: "1px solid var(--line)",
                borderRadius: 14,
                padding: "24px 28px",
                display: "flex",
                flexDirection: "column",
                gap: 24,
              }}
            >
              {sections?.tldr && (
                <Section title="TLDR">
                  {renderMarkdownInline(sections.tldr, entityMap, onSelectSlug, selected.slug)}
                </Section>
              )}
              {sections?.detailed && (
                <Section title="Detailed">
                  {renderMarkdownInline(sections.detailed, entityMap, onSelectSlug, selected.slug)}
                </Section>
              )}
              {/* Reflections live here in the left column, immediately after
                  Detailed and before any rest sections / legacy structure.
                  The right-column Relationships card is the live graph view;
                  Reflections is the user's own commentary attached to thoughts
                  linked to this entity, so it pairs naturally with the prose. */}
              <ReflectionsCard
                reflections={reflections}
                loading={reflectionsLoading}
              />
              {/* Legacy structure — shown for pages compiled before the
                  TLDR/Detailed prompt change. Will disappear after regen. */}
              {sections?.keyFacts && (
                <Section title="Key Facts">
                  {renderMarkdownInline(sections.keyFacts, entityMap, onSelectSlug, selected.slug)}
                </Section>
              )}
              {sections?.timeline && (
                <Section title="Timeline">
                  {renderMarkdownInline(sections.timeline, entityMap, onSelectSlug, selected.slug)}
                </Section>
              )}
              {sections?.rest.map((s) => (
                <Section key={s.heading} title={s.heading}>
                  {renderMarkdownInline(s.body, entityMap, onSelectSlug, selected.slug)}
                </Section>
              ))}
              {!sections?.tldr &&
                !sections?.detailed &&
                !sections?.keyFacts &&
                !sections?.timeline &&
                sections?.rest.length === 0 && (
                  <span style={{ color: "var(--fg-4)", fontSize: 13 }}>
                    No structured content yet — wait for the next regeneration.
                  </span>
                )}
            </div>

            {/* Right — Relationships (live graph), Open Questions, Curator Note.
                Reflections moved to the left column (after Detailed) — Adam's
                preference, and the live graph Relationships here is the
                source-of-truth (the LLM's parsed-markdown Relationships used
                to render here too but was a derivative duplicate). */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <RelationshipsCard
                edges={edges}
                loading={edgesLoading}
                entityTypes={entityTypes}
                onSelectSlug={onSelectSlug}
              />

              {sections?.openQuestions && (
                <Card padding={20} title="Open Questions" eyebrow="UNRESOLVED">
                  {renderMarkdownInline(
                    sections.openQuestions,
                    entityMap,
                    onSelectSlug,
                    selected.slug
                  )}
                </Card>
              )}

              <CuratorNotePanel
                note={selected.notes ?? ""}
                onSave={onSaveNotes}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const ghostBtn: React.CSSProperties = {
  padding: "7px 12px",
  borderRadius: 8,
  border: "1px solid var(--line-strong)",
  background: "var(--bg-2)",
  color: "var(--fg-2)",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "inherit",
};

// Inline entity-type pill. Acts as a static chip when the page has no
// entity_id (e.g. legacy topic wiki rows). For entity-backed pages it
// becomes an editable select that PATCHes /api/entities/:id with the
// new entity_type and bubbles the change up so the parent's pages list
// + selected detail stay in sync. Mirrors the List view's
// EntityTypeSelect but styled to match the Graph view's pill aesthetic.
function EntityTypePill({
  page,
  entityTypes,
  onTypeChanged,
}: {
  page: WikiPageDetail;
  entityTypes: EntityTypeInfo[];
  onTypeChanged?: (newType: string) => void;
}) {
  const currentType =
    (page.metadata?.entity_type as string | undefined) ?? page.type;
  const [pendingType, setPendingType] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const displayType = pendingType ?? currentType;
  const meta = entityTypes.find((t) => t.entity_type === displayType);
  const color = meta?.color ?? "#7adcdc";

  async function handleChange(newType: string) {
    if (!page.entity_id || newType === currentType) return;
    setPendingType(newType);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/entities/${page.entity_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_type: newType }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        const msg = d.error || `HTTP ${res.status}`;
        const dupe = msg.includes("duplicate key") || msg.includes("unique constraint");
        throw new Error(
          dupe
            ? `A "${newType}" entity with this name already exists — use Merge to combine them`
            : msg
        );
      }
      onTypeChanged?.(newType);
      setPendingType(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setPendingType(null);
    } finally {
      setSaving(false);
    }
  }

  // Topic / non-entity pages have no entity_id — render as a static pill so
  // we don't pretend they're editable.
  if (!page.entity_id) {
    return (
      <span
        style={{
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          padding: "3px 9px",
          borderRadius: 4,
          background: `color-mix(in srgb, ${color} 15%, transparent)`,
          color,
          border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
        }}
      >
        {displayType}
      </span>
    );
  }

  return (
    <span
      title={error ?? "Click to change entity type"}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
      }}
    >
      <select
        value={displayType}
        onChange={(e) => handleChange(e.target.value)}
        disabled={saving}
        style={{
          appearance: "none",
          WebkitAppearance: "none",
          MozAppearance: "none",
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          padding: "3px 18px 3px 9px",
          borderRadius: 4,
          background: `color-mix(in srgb, ${color} 15%, transparent)`,
          color,
          border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
          cursor: saving ? "wait" : "pointer",
          outline: "none",
          opacity: saving ? 0.6 : 1,
        }}
      >
        {entityTypes.length === 0 ? (
          <option value={displayType}>{displayType}</option>
        ) : (
          entityTypes.map((t) => (
            <option key={t.entity_type} value={t.entity_type}>
              {t.entity_type}
            </option>
          ))
        )}
      </select>
      <span
        style={{
          pointerEvents: "none",
          position: "absolute",
          right: 6,
          fontSize: 8,
          color,
          opacity: 0.7,
        }}
      >
        ▾
      </span>
      {error && (
        <span
          style={{
            marginLeft: 8,
            fontSize: 10,
            color: "#ff9b9b",
          }}
        >
          ! {error}
        </span>
      )}
    </span>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      <h3
        style={{
          margin: 0,
          fontSize: 13,
          fontWeight: 500,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--fg-3)",
        }}
      >
        {title}
      </h3>
      <div>{children}</div>
    </section>
  );
}

function RelationshipsCard({
  edges,
  loading,
  entityTypes,
  onSelectSlug,
}: {
  edges: EdgeRow[];
  loading: boolean;
  entityTypes: EntityTypeInfo[];
  onSelectSlug: (slug: string) => void;
}) {
  // Group edges by relation
  const groups = useMemo(() => {
    const m = new Map<string, EdgeRow[]>();
    for (const e of edges) {
      const arr = m.get(e.relation) ?? [];
      arr.push(e);
      m.set(e.relation, arr);
    }
    return Array.from(m.entries()).sort(
      (a, b) => b[1].length - a[1].length
    );
  }, [edges]);

  if (loading) {
    return (
      <Card padding={20} title="Relationships" eyebrow="GRAPH">
        <span style={{ color: "var(--fg-4)", fontSize: 12 }}>Loading…</span>
      </Card>
    );
  }
  if (edges.length === 0) {
    return (
      <Card padding={20} title="Relationships" eyebrow="GRAPH">
        <span style={{ color: "var(--fg-4)", fontSize: 12 }}>
          No relationships yet — they appear after the next extraction pass.
        </span>
      </Card>
    );
  }

  return (
    <Card padding={20} title="Relationships" eyebrow="GRAPH">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {groups.map(([relation, rows], i) => (
          <div
            key={relation}
            style={
              i > 0
                ? { paddingTop: 12, borderTop: "1px solid var(--line)" }
                : undefined
            }
          >
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              {RELATION_LABELS[relation] ?? relation.replace(/_/g, " ")}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {rows.slice(0, 10).map((r) => {
                const color =
                  entityTypes.find((t) => t.entity_type === r.other_type)
                    ?.color ?? "#9d83ff";
                return (
                  <button
                    key={r.edge_id}
                    type="button"
                    onClick={() => r.other_slug && onSelectSlug(r.other_slug)}
                    disabled={!r.other_slug}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: "var(--bg-3)",
                      border: "1px solid var(--line)",
                      cursor: r.other_slug ? "pointer" : "default",
                      fontFamily: "inherit",
                      width: "100%",
                      textAlign: "left",
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: color,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 13,
                        color: "var(--fg-2)",
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.other_name}
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 10.5,
                        color: "var(--fg-4)",
                      }}
                    >
                      ×{r.support_count}
                    </span>
                    {r.other_slug && (
                      <span style={{ color: "var(--fg-4)", fontSize: 12 }}>
                        →
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

const REFLECTION_TYPE_META: Record<string, { label: string; tone: string }> = {
  decision_trace: { label: "Decision", tone: "rgba(157,131,255,0.18)" },
  lesson_trace: { label: "Lesson", tone: "rgba(80,200,200,0.18)" },
  retrospective: { label: "Retro", tone: "rgba(255,180,80,0.18)" },
  hypothesis: { label: "Hypothesis", tone: "rgba(255,150,80,0.18)" },
  general: { label: "Reflection", tone: "rgba(255,255,255,0.06)" },
};

function ReflectionsCard({
  reflections,
  loading,
}: {
  reflections: ReflectionRow[];
  loading: boolean;
}) {
  // Group by reflection_type
  const groups = useMemo(() => {
    const m = new Map<string, ReflectionRow[]>();
    for (const r of reflections) {
      const k = r.reflection_type ?? "general";
      const arr = m.get(k) ?? [];
      arr.push(r);
      m.set(k, arr);
    }
    // Order: lessons first, then decisions, then retros, hypotheses, general
    const order = ["lesson_trace", "decision_trace", "retrospective", "hypothesis", "general"];
    return Array.from(m.entries()).sort(
      (a, b) => order.indexOf(a[0]) - order.indexOf(b[0])
    );
  }, [reflections]);

  if (loading) {
    return (
      <Card padding={20} title="Reflections" eyebrow="LESSONS · DECISIONS">
        <span style={{ color: "var(--fg-4)", fontSize: 12 }}>Loading…</span>
      </Card>
    );
  }
  if (reflections.length === 0) {
    return (
      <Card padding={20} title="Reflections" eyebrow="LESSONS · DECISIONS">
        <span style={{ color: "var(--fg-4)", fontSize: 12 }}>
          No reflections attached to thoughts about this entity yet. Add one
          from any thought&apos;s detail page, or via an AI client&apos;s{" "}
          <code style={{ fontSize: 11 }}>add_reflection</code> tool.
        </span>
      </Card>
    );
  }

  return (
    <Card padding={20} title="Reflections" eyebrow="LESSONS · DECISIONS">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {groups.map(([type, rows], i) => {
          const meta = REFLECTION_TYPE_META[type] ?? REFLECTION_TYPE_META.general;
          return (
            <div
              key={type}
              style={
                i > 0
                  ? { paddingTop: 12, borderTop: "1px solid var(--line)" }
                  : undefined
              }
            >
              <div className="eyebrow" style={{ marginBottom: 8 }}>
                {meta.label} · {rows.length}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {rows.slice(0, 10).map((r) => (
                  <a
                    key={r.id}
                    href={
                      r.source_thought_serial != null
                        ? `/thoughts/${r.source_thought_serial}`
                        : "#"
                    }
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      padding: "10px 12px",
                      borderRadius: 8,
                      background: meta.tone,
                      border: "1px solid var(--line)",
                      textDecoration: "none",
                      color: "var(--fg)",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 13,
                        color: "var(--fg)",
                        lineHeight: 1.45,
                      }}
                    >
                      {r.conclusion || (
                        <span style={{ color: "var(--fg-4)", fontStyle: "italic" }}>
                          (no conclusion yet)
                        </span>
                      )}
                    </div>
                    {r.trigger_context && (
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--fg-3)",
                          lineHeight: 1.4,
                        }}
                      >
                        Trigger: {r.trigger_context}
                      </div>
                    )}
                    <div
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        color: "var(--fg-4)",
                        display: "flex",
                        gap: 10,
                      }}
                    >
                      {r.source_thought_serial != null && (
                        <span>#{r.source_thought_serial}</span>
                      )}
                      <span>conf {Number(r.confidence ?? 1).toFixed(2)}</span>
                      <span>{(r.created_at ?? "").slice(0, 10)}</span>
                    </div>
                  </a>
                ))}
                {rows.length > 10 && (
                  <span style={{ fontSize: 11, color: "var(--fg-4)" }}>
                    +{rows.length - 10} more…
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function CuratorNotePanel({
  note,
  onSave,
}: {
  note: string;
  onSave: (notes: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(note);
  }, [note]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        borderRadius: 14,
        padding: 20,
        background:
          "linear-gradient(180deg, rgba(157,131,255,0.08), rgba(130,97,255,0.02))",
        border: "1px solid rgba(157,131,255,0.25)",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            padding: "3px 8px",
            borderRadius: 4,
            background: "rgba(157,131,255,0.15)",
            color: "var(--violet-200)",
            border: "1px solid rgba(157,131,255,0.3)",
          }}
        >
          curator note
        </span>
        <span style={{ fontSize: 11, color: "var(--fg-3)" }}>
          only writable surface
        </span>
        <span
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--fg-4)",
            }}
          >
            weight
          </span>
          <div style={{ display: "flex", gap: 2 }}>
            {[1, 2, 3, 4, 5].map((i) => (
              <span
                key={i}
                style={{
                  width: 5,
                  height: 11,
                  background: "var(--violet-400)",
                  borderRadius: 1,
                }}
              />
            ))}
          </div>
          <span
            style={{
              fontSize: 10,
              color: "var(--violet-300)",
              fontFamily: "var(--font-mono)",
            }}
          >
            HIGHEST
          </span>
        </span>
      </div>

      {!editing && note && (
        <div
          style={{
            padding: "12px 14px",
            borderRadius: 10,
            background: "var(--bg-2)",
            border: "1px solid var(--line-strong)",
            fontSize: 13,
            color: "var(--fg)",
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
          }}
        >
          {note}
        </div>
      )}

      {!editing && !note && (
        <div
          style={{
            padding: "12px 14px",
            borderRadius: 10,
            background: "var(--bg-1)",
            border: "1px dashed var(--line-strong)",
            fontSize: 12.5,
            color: "var(--fg-4)",
          }}
        >
          No curator note. Add one to steer the next regeneration — corrections,
          context, or facts the snippets miss.
        </div>
      )}

      {editing && (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={5}
          placeholder="Correct or update this article. Notes override conflicting info on next regenerate."
          style={{
            background: "var(--bg-1)",
            border: "1px solid var(--line-strong)",
            borderRadius: 10,
            padding: "10px 12px",
            color: "var(--fg)",
            fontSize: 13,
            lineHeight: 1.55,
            fontFamily: "inherit",
            resize: "vertical",
            outline: "none",
          }}
        />
      )}

      {error && (
        <div
          style={{
            fontSize: 11,
            color: "#ff9b9b",
            padding: "4px 0",
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            fontFamily: "var(--font-mono)",
            color: "var(--fg-4)",
          }}
        >
          {editing ? "⌘↵ to save" : note ? "click Edit to update" : ""}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          {editing ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setDraft(note);
                  setError(null);
                }}
                style={{
                  padding: "5px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--line)",
                  background: "transparent",
                  color: "var(--fg-3)",
                  fontSize: 11.5,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                style={{
                  padding: "5px 11px",
                  borderRadius: 6,
                  border: "none",
                  background: "var(--violet-500)",
                  color: "#fff",
                  fontSize: 11.5,
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  opacity: saving ? 0.6 : 1,
                }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              style={{
                padding: "5px 11px",
                borderRadius: 6,
                border: "none",
                background: "var(--violet-500)",
                color: "#fff",
                fontSize: 11.5,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {note ? "Edit" : "+ Add note"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
