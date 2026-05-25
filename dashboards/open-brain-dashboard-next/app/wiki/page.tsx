"use client";

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import { WikiGraphView } from "@/components/design/WikiGraphView";

// ── Types ──────────────────────────────────────────────────────────────────

interface WikiPageSummary {
  id: number;
  slug: string;
  type: string;
  entity_id: number | null;
  title: string;
  generated_at: string;
  thought_count: number;
  aliases?: string[];
  metadata?: Record<string, unknown>;
}

const ENTITY_TYPE_FILTERS = [
  { value: "all",          label: "All" },
  { value: "person",       label: "Person" },
  { value: "organization", label: "Org" },
  { value: "project",      label: "Project" },
  { value: "tool",         label: "Tool" },
  { value: "place",        label: "Place" },
  { value: "topic",        label: "Topic" },
] as const;

type EntityTypeFilter = typeof ENTITY_TYPE_FILTERS[number]["value"];

function getEntityType(p: WikiPageSummary): string {
  const et = (p.metadata?.entity_type as string | undefined) ?? p.type;
  return et === "org" ? "organization" : et;
}

interface WikiPageDetail extends WikiPageSummary {
  content: string;
  notes?: string | null;
  metadata: Record<string, unknown>;
  updated_at: string;
  created_at: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

const TYPE_BADGE_COLORS: Record<string, string> = {
  person: "bg-violet/15 text-violet border border-violet/30",
  project: "bg-blue-500/15 text-blue-400 border border-blue-500/30",
  tool: "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30",
  organization: "bg-amber-500/15 text-amber-400 border border-amber-500/30",
  org: "bg-amber-500/15 text-amber-400 border border-amber-500/30",
  topic: "bg-rose-500/15 text-rose-400 border border-rose-500/30",
  place: "bg-sky-500/15 text-sky-400 border border-sky-500/30",
  entity: "bg-text-muted/15 text-text-muted border border-border",
};

function TypeBadge({ page }: { page: WikiPageSummary }) {
  const label =
    page.type === "entity"
      ? (page as WikiPageDetail & { metadata?: { entity_type?: string } })
          ?.metadata?.entity_type as string | undefined ?? "entity"
      : page.type;
  const colorClass =
    TYPE_BADGE_COLORS[label] ?? TYPE_BADGE_COLORS["entity"];
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${colorClass}`}
    >
      {label}
    </span>
  );
}

function MarkdownContent({
  content,
  onWikiLink,
  entityMap,
  selfSlug,
}: {
  content: string;
  onWikiLink?: (slug: string) => void;
  entityMap?: Map<string, string>;
  selfSlug?: string;
}) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let listItems: string[] = [];
  let key = 0;

  // Build the auto-link regex once per render. Names sorted longest-first so
  // multi-word matches ("AWS EC2") win over substring matches ("AWS").
  const autolinkPattern = (() => {
    if (!entityMap || entityMap.size === 0) return null;
    const names = Array.from(entityMap.keys())
      .filter((n) => n.length > 1)
      .sort((a, b) => b.length - a.length);
    if (names.length === 0) return null;
    const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "gi");
  })();

  // Auto-link bare entity names in HTML, but skip text already inside <a> tags
  // so we don't produce nested anchors. Self-references are also skipped.
  function autolinkEntities(html: string): string {
    if (!autolinkPattern || !entityMap) return html;
    const anchorRe = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
    const linkText = (chunk: string) =>
      chunk.replace(autolinkPattern, (matched) => {
        const slug = entityMap.get(matched.toLowerCase());
        if (!slug || slug === selfSlug) return matched;
        return `<a href="/wiki?slug=${slug}" data-wiki-slug="true" class="text-violet hover:underline">${matched}</a>`;
      });
    let out = "";
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = anchorRe.exec(html)) !== null) {
      out += linkText(html.slice(last, m.index)) + m[0];
      last = m.index + m[0].length;
    }
    return out + linkText(html.slice(last));
  }

  function flushList() {
    if (listItems.length === 0) return;
    elements.push(
      <ul key={key++} className="list-disc list-inside space-y-0.5 mb-3 text-text-secondary text-sm">
        {listItems.map((item, i) => (
          <li key={i} dangerouslySetInnerHTML={{ __html: inlineFormat(item) }} />
        ))}
      </ul>
    );
    listItems = [];
  }

  function inlineFormat(text: string): string {
    return autolinkEntities(rawInlineFormat(text));
  }

  function rawInlineFormat(text: string): string {
    return text
      // Markdown links [text](url) — relative paths and https/http only
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => {
        const safe =
          u.startsWith("/") || u.startsWith("https://") || u.startsWith("http://")
            ? u
            : "#";
        // Wiki cross-links open in the same SPA; thought links navigate normally
        const extra = u.startsWith("/wiki?slug=") ? ' data-wiki-slug="true"' : '';
        return `<a href="${safe}"${extra} class="text-violet hover:underline">${t}</a>`;
      })
      // Thought citation links — single [#NN]/[NN] AND multi [#164, #167, #170].
      // Single regex pass so the second replace can't re-match the first's output
      // and produce nested anchor tags. The LLM sometimes groups citations into
      // one bracket; each id becomes its own link, joined by commas.
      .replace(/\[(#?\d+(?:\s*,\s*#?\d+)*)\]/g, (_match, inner) => {
        const ids = inner.split(/\s*,\s*/).map((s: string) => s.replace(/^#/, ""));
        return ids
          .map((id: string) => `<a href="/thoughts/${id}" class="text-violet/70 hover:text-violet hover:underline text-xs font-mono">[#${id}]</a>`)
          .join(ids.length > 1 ? ", " : "");
      })
      // Legacy UUID citations [xxxxxxxx-xxxx-...] — styled but not linked (rebuild will replace with integer format)
      .replace(/\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi, '<span class="text-text-muted text-xs font-mono">[$1]</span>')
      // Bare entity-name brackets like [M365 Copilot] or [AWS EC2] that the LLM
      // emitted without the markdown link form. Auto-resolve to a wiki link
      // when the inner text matches a known entity title or alias. Misses
      // (random brackets) are returned as-is so we don't over-link prose.
      .replace(/\[([^\]]+)\]/g, (match, inner) => {
        if (!entityMap) return match;
        const slug = entityMap.get(String(inner).trim().toLowerCase());
        if (!slug) return match;
        return `<a href="/wiki?slug=${slug}" data-wiki-slug="true" class="text-violet hover:underline">${inner}</a>`;
      })
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`(.+?)`/g, "<code class=\"bg-bg-elevated px-1 rounded text-xs\">$1</code>");
  }

  for (const raw of lines) {
    const line = raw;
    if (line.match(/^#{1}\s/)) {
      flushList();
      elements.push(
        <h1 key={key++} className="text-xl font-bold text-text-primary mt-4 mb-2 first:mt-0">
          {line.replace(/^#\s+/, "")}
        </h1>
      );
    } else if (line.match(/^#{2}\s/)) {
      flushList();
      elements.push(
        <h2 key={key++} className="text-base font-semibold text-text-primary mt-4 mb-1.5 border-b border-border pb-1">
          {line.replace(/^##\s+/, "")}
        </h2>
      );
    } else if (line.match(/^#{3}\s/)) {
      flushList();
      elements.push(
        <h3 key={key++} className="text-sm font-semibold text-text-secondary mt-3 mb-1">
          {line.replace(/^###\s+/, "")}
        </h3>
      );
    } else if (line.match(/^#{4,}\s/)) {
      flushList();
      elements.push(
        <h4 key={key++} className="text-sm font-medium text-text-muted mt-2 mb-1">
          {line.replace(/^#{4,}\s+/, "")}
        </h4>
      );
    } else if (line.match(/^[-*]\s+/)) {
      listItems.push(line.replace(/^[-*]\s+/, ""));
    } else if (line.match(/^---+$/) || line.match(/^\*\*\*+$/)) {
      flushList();
      elements.push(<hr key={key++} className="border-border my-3" />);
    } else if (line.trim() === "") {
      flushList();
      elements.push(<div key={key++} className="mb-2" />);
    } else {
      flushList();
      elements.push(
        <p
          key={key++}
          className="text-sm text-text-secondary mb-2 leading-relaxed"
          dangerouslySetInnerHTML={{ __html: inlineFormat(line) }}
        />
      );
    }
  }
  flushList();

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (href.startsWith("/wiki?slug=")) {
      e.preventDefault();
      const slug = new URLSearchParams(href.slice("/wiki?".length)).get("slug");
      if (slug && onWikiLink) onWikiLink(slug);
    }
  }

  return <div className="wiki-content" onClick={handleClick}>{elements}</div>;
}

// ── Entity Type Select ────────────────────────────────────────────────────

function EntityTypeSelect({
  page,
  onTypeChanged,
}: {
  page: WikiPageDetail;
  onTypeChanged: (newType: string) => void;
}) {
  const currentType =
    (page.metadata?.entity_type as string | undefined) ?? page.type;
  // Local optimistic value so the select doesn't snap back during async save
  const [pendingType, setPendingType] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const displayType = pendingType ?? currentType;
  const colorClass =
    TYPE_BADGE_COLORS[displayType] ?? TYPE_BADGE_COLORS["entity"];

  const handleChange = async (newType: string) => {
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
        const d = await res.json().catch(() => ({}));
        const msg = (d as { error?: string }).error || `HTTP ${res.status}`;
        const isDupe = msg.includes("duplicate key") || msg.includes("unique constraint");
        throw new Error(isDupe ? `A "${newType}" entity with this name already exists — use Merge to combine them` : msg);
      }
      onTypeChanged(newType);
      setPendingType(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setPendingType(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative inline-flex items-center">
      <select
        value={displayType}
        onChange={(e) => handleChange(e.target.value)}
        disabled={saving || !page.entity_id}
        title={error ?? "Change entity type"}
        className={`appearance-none inline-flex items-center pl-1.5 pr-5 py-0.5 rounded text-[10px] font-medium cursor-pointer focus:outline-none focus:ring-1 focus:ring-violet disabled:opacity-60 ${colorClass}`}
      >
        {ENTITY_TYPE_FILTERS.filter((f) => f.value !== "all").map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-1 text-[8px] opacity-60">▾</span>
      {saving && (
        <span className="absolute -right-4 text-[10px] text-text-muted animate-pulse">…</span>
      )}
      {error && (
        <span className="ml-1 text-[10px] text-danger" title={error}>! {error}</span>
      )}
    </div>
  );
}

// ── Alias Modal ────────────────────────────────────────────────────────────

function AliasModal({
  page,
  onClose,
  onAliasAdded,
  onAliasRemoved,
}: {
  page: WikiPageDetail;
  onClose: () => void;
  onAliasAdded: (alias: string) => void;
  onAliasRemoved: (alias: string) => void;
}) {
  const [aliases, setAliases] = useState<string[]>(page.aliases ?? []);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleAdd = useCallback(async () => {
    const alias = input.trim();
    if (!alias) return;
    if (aliases.includes(alias)) { setInput(""); return; }
    if (!page.entity_id) { setError("No entity linked to this page"); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/entities/${page.entity_id}/aliases`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || `HTTP ${res.status}`);
      }
      const { aliases: updated } = await res.json() as { aliases: string[] };
      setAliases(updated);
      setInput("");
      onAliasAdded(alias);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add alias");
    } finally {
      setSaving(false);
    }
  }, [input, aliases, page.entity_id, onAliasAdded]);

  const handleRemove = useCallback(
    async (alias: string, resplit: boolean) => {
      if (!page.entity_id) return;
      // Resplit is destructive-ish (re-extracts every linked thought) — confirm
      // first so it's not a one-click misclick.
      if (resplit) {
        const ok = window.confirm(
          `Remove "${alias}" AND re-extract every thought linked to this entity?\n\n` +
            `This is the way to undo a bad auto-absorb. The worker will re-read each thought ` +
            `and recreate any entity that the alias was masking. Edges and the wiki page will ` +
            `regenerate from scratch on the next worker run.`
        );
        if (!ok) return;
      }
      setRemoving(alias);
      setError(null);
      try {
        const res = await fetch(`/api/entities/${page.entity_id}/aliases`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            alias,
            action: resplit ? "remove_and_resplit" : "remove",
          }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error((d as { error?: string }).error || `HTTP ${res.status}`);
        }
        const data = (await res.json()) as {
          aliases: string[];
          resplit_queued?: number;
        };
        setAliases(data.aliases);
        onAliasRemoved(alias);
        if (resplit && data.resplit_queued) {
          setError(
            `Re-queued ${data.resplit_queued} thoughts. Worker will reprocess them shortly.`
          );
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to remove alias");
      } finally {
        setRemoving(null);
      }
    },
    [page.entity_id, onAliasRemoved]
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-bg-surface border border-border rounded-xl shadow-xl w-full max-w-sm mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-text-primary">
            Aliases — {page.title}
          </h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-secondary transition-colors text-lg leading-none">
            ×
          </button>
        </div>

        {aliases.length === 0 ? (
          <p className="text-xs text-text-muted mb-4">No aliases yet.</p>
        ) : (
          <div className="flex flex-col gap-1.5 mb-4">
            {aliases.map((a) => (
              <div
                key={a}
                className="inline-flex items-center gap-2 px-2 py-1 rounded-lg bg-bg-elevated border border-border text-xs text-text-secondary"
              >
                <span className="flex-1">{a}</span>
                <button
                  onClick={() => handleRemove(a, false)}
                  disabled={removing === a}
                  className="text-text-muted hover:text-text-secondary transition-colors disabled:opacity-50 px-1"
                  title={`Remove "${a}" — keeps absorbed thoughts attached`}
                >
                  Remove
                </button>
                <button
                  onClick={() => handleRemove(a, true)}
                  disabled={removing === a}
                  className="text-text-muted hover:text-warning transition-colors disabled:opacity-50 px-1 border-l border-border pl-2"
                  title={`Remove "${a}" AND re-extract every thought — use this to undo a bad auto-absorb`}
                >
                  {removing === a ? "…" : "Remove & resplit"}
                </button>
              </div>
            ))}
          </div>
        )}

        <p className="text-xs text-text-muted mb-2">
          Aliases are matched during entity extraction — adding one here prevents future duplicates.
          {" "}
          <span className="text-text-muted/80">
            <strong>Remove & resplit</strong> undoes a bad absorb by re-extracting every linked thought.
          </span>
        </p>

        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
            placeholder="e.g. Tom, T.F., SCL"
            className="flex-1 bg-bg-elevated border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-violet"
          />
          <button
            onClick={handleAdd}
            disabled={saving || !input.trim()}
            className="px-3 py-1.5 text-sm bg-violet text-white rounded-lg hover:bg-violet/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? "…" : "Add"}
          </button>
        </div>

        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </div>
    </div>
  );
}

// ── Edit Relationships Modal ───────────────────────────────────────────────
//
// Lists every edge touching this entity (both directions). The ✕ button on
// each row deletes the edge AND adds it to edge_blocklist so the worker
// won't recreate it the next time a thought mentioning both entities is
// processed. This is the user-facing fix for "edits make wrong edges worse".

interface EdgeRow {
  id: number;
  from_entity_id: number;
  to_entity_id: number;
  relation: string;
  support_count: number;
  confidence: number | null;
  direction: "out" | "in";
  symmetric: boolean;
  other: { id: number; canonical_name: string; entity_type: string };
}

interface RecentBlockEntry {
  from_entity_id: number;
  to_entity_id: number;
  relation: string;
  other_name: string;
  blocked_at: string;
}

function EdgesModal({
  page,
  onClose,
  onEdgeRemoved,
}: {
  page: WikiPageDetail;
  onClose: () => void;
  onEdgeRemoved: () => void;
}) {
  const [edges, setEdges] = useState<EdgeRow[] | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Recent-undo state — populated on mount if there were any blocklist
  // entries on this entity in the last 30 minutes. Catches the "panic
  // delete" pattern where the user nuked a bunch of edges thinking they
  // were on a different entity.
  const [recentBlocks, setRecentBlocks] = useState<RecentBlockEntry[]>([]);
  const [undoLoading, setUndoLoading] = useState(false);
  const [undoStatus, setUndoStatus] = useState<string | null>(null);

  const entityType =
    ((page.metadata as { entity_type?: string } | undefined)?.entity_type) ?? page.type;

  useEffect(() => {
    if (!page.entity_id) return;
    fetch(`/api/entities/${page.entity_id}/edges`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: { edges: EdgeRow[] }) => setEdges(d.edges || []))
      .catch((e: Error) => setError(e.message));
    // Look for recent block activity on this entity (last 30 min). If any
    // show up, surface the "undo last session" button so a panic-delete
    // run is one click to reverse.
    fetch(`/api/entities/${page.entity_id}/recent-blocks?minutes=30`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { entries?: RecentBlockEntry[] } | null) => {
        if (d?.entries) setRecentBlocks(d.entries);
      })
      .catch(() => {});
  }, [page.entity_id]);

  const handleUndoRecent = useCallback(async () => {
    if (!page.entity_id) return;
    setUndoLoading(true);
    setUndoStatus(null);
    try {
      const res = await fetch(
        `/api/entities/${page.entity_id}/undo-recent-blocks?minutes=30`,
        { method: "POST" }
      );
      const d = (await res.json().catch(() => ({}))) as {
        error?: string;
        restored?: number;
        requeued?: number;
      };
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setUndoStatus(
        `Restored ${d.restored ?? 0} edges, re-queued ${d.requeued ?? 0} thoughts. Worker will rebuild in ~30-60s.`
      );
      setRecentBlocks([]);
      onEdgeRemoved(); // bump parent so it refetches edges
    } catch (e) {
      setError(e instanceof Error ? e.message : "Undo failed");
    } finally {
      setUndoLoading(false);
    }
  }, [page.entity_id, onEdgeRemoved]);

  const handleRemove = useCallback(async (edge: EdgeRow) => {
    if (!page.entity_id) return;
    setRemoving(edge.id);
    setError(null);
    try {
      const res = await fetch(`/api/edges`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_entity_id: edge.from_entity_id,
          to_entity_id: edge.to_entity_id,
          relation: edge.relation,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || `HTTP ${res.status}`);
      }
      setEdges((prev) => (prev || []).filter((e) => e.id !== edge.id));
      onEdgeRemoved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setRemoving(null);
    }
  }, [page.entity_id, onEdgeRemoved]);

  // Group edges by relation for readable display
  const grouped = (edges || []).reduce<Record<string, EdgeRow[]>>((acc, e) => {
    (acc[e.relation] = acc[e.relation] || []).push(e);
    return acc;
  }, {});
  const relations = Object.keys(grouped).sort((a, b) =>
    grouped[b].reduce((s, e) => s + (e.support_count || 0), 0) -
    grouped[a].reduce((s, e) => s + (e.support_count || 0), 0)
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-bg-surface border border-border rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Prominent entity header — answers "which entity am I editing?"
            so the user never confuses one entity for another mid-session.
            Wrong-target panic deletes turned out to be a real failure mode
            (May 2026: user nuked 94 edges on Adam Ososki thinking they
            were on PostgreSQL). */}
        <div className="p-5 border-b border-border">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-violet/15 border border-violet/30 text-violet-200 font-mono">
                  {entityType}
                </span>
                <span className="text-[10px] text-text-muted font-mono">
                  #{page.entity_id}
                </span>
              </div>
              <h3 className="text-xl font-semibold text-text-primary truncate">
                {page.title}
              </h3>
              <p className="text-xs text-text-muted mt-1">
                Editing relationships for this entity
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-text-muted hover:text-text-secondary transition-colors text-2xl leading-none shrink-0"
            >
              ×
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <p className="text-xs text-text-muted mb-4">
            Removing an edge here also blocklists it. The worker will not recreate this relationship from extraction even if future thoughts mention both entities together. Use this for relationships the LLM keeps inferring incorrectly.
          </p>

          {/* Undo-recent banner. Shows when there have been recent
              blocklist entries on THIS entity in the last 30 minutes —
              the signature of a panic-delete burst. One click restores
              them all (deletes the blocklist rows + re-queues the
              entity's thoughts so the worker rebuilds edges). */}
          {recentBlocks.length > 0 && (
            <div className="mb-4 p-3 rounded-lg border border-violet/40 bg-violet/10">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-violet-200 mb-1">
                    Recent activity: {recentBlocks.length}{" "}
                    {recentBlocks.length === 1 ? "edge" : "edges"} removed
                    on this entity in the last 30 minutes
                  </p>
                  <p className="text-[11px] text-text-muted">
                    e.g. {recentBlocks
                      .slice(0, 3)
                      .map((b) => `${b.relation} → ${b.other_name}`)
                      .join(", ")}
                    {recentBlocks.length > 3 ? `, +${recentBlocks.length - 3} more` : ""}
                  </p>
                </div>
                <button
                  onClick={handleUndoRecent}
                  disabled={undoLoading}
                  className="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium bg-violet/20 hover:bg-violet/30 border border-violet/50 text-violet-100 transition-colors disabled:opacity-60"
                  title="Delete the recent blocklist entries and re-queue this entity's thoughts so the worker rebuilds the edges"
                >
                  {undoLoading ? "Restoring…" : "↶ Undo last session"}
                </button>
              </div>
              {undoStatus && (
                <p className="mt-2 text-[11px] text-violet-200">{undoStatus}</p>
              )}
            </div>
          )}

          {edges === null && !error && (
            <p className="text-xs text-text-muted">Loading edges…</p>
          )}
          {edges && edges.length === 0 && (
            <p className="text-xs text-text-muted">No relationships on this entity yet.</p>
          )}

          {relations.map((rel) => (
            <div key={rel} className="mb-4">
              <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-1.5">{rel}</h4>
              <div className="flex flex-col gap-1">
                {grouped[rel].map((e) => (
                  <div
                    key={e.id}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-bg-elevated border border-border"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-text-muted text-xs shrink-0" title={e.symmetric ? "Symmetric relation" : `${e.direction === "out" ? "outgoing" : "incoming"}`}>
                        {e.symmetric ? "↔" : e.direction === "out" ? "→" : "←"}
                      </span>
                      <span className="text-sm text-text-primary truncate" title={e.other.canonical_name}>
                        {e.other.canonical_name}
                      </span>
                      <span className="text-xs text-text-muted shrink-0">
                        ({e.other.entity_type}, {e.support_count} {e.support_count === 1 ? "thought" : "thoughts"})
                      </span>
                    </div>
                    <button
                      onClick={() => handleRemove(e)}
                      disabled={removing === e.id}
                      className="px-2 py-0.5 rounded text-xs text-danger/70 hover:text-danger hover:bg-danger/10 transition-colors disabled:opacity-50 shrink-0"
                      title="Remove this edge and add to blocklist so it doesn't come back"
                    >
                      {removing === e.id ? "…" : "✕ remove"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        </div>
      </div>
    </div>
  );
}

// ── Rename Modal ───────────────────────────────────────────────────────────

function RenameModal({
  page,
  onClose,
  onRenamed,
}: {
  page: WikiPageDetail;
  onClose: () => void;
  onRenamed: (newName: string) => void;
}) {
  const [name, setName] = useState(page.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleRename = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === page.title) { onClose(); return; }
    if (!page.entity_id) { setError("No entity linked to this page"); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/entities/${page.entity_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canonical_name: trimmed }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || `HTTP ${res.status}`);
      }
      onRenamed(trimmed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rename failed");
    } finally {
      setSaving(false);
    }
  }, [name, page.title, page.entity_id, onClose, onRenamed]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-bg-surface border border-border rounded-xl shadow-xl w-full max-w-sm mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-text-primary">Rename entity</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-secondary transition-colors text-lg leading-none">×</button>
        </div>

        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleRename(); if (e.key === "Escape") onClose(); }}
          className="w-full bg-bg-elevated border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-violet mb-3"
        />

        <p className="text-xs text-text-muted mb-4">
          The wiki page title updates immediately. Content regenerates on the next compile run.
        </p>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm bg-bg-elevated border border-border rounded-lg text-text-secondary hover:bg-bg-hover transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleRename}
            disabled={saving || !name.trim() || name.trim() === page.title}
            className="px-3 py-1.5 text-sm bg-violet text-white rounded-lg hover:bg-violet/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? "Renaming…" : "Rename"}
          </button>
        </div>

        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </div>
    </div>
  );
}

// ── Merge Modal ────────────────────────────────────────────────────────────

interface OrphanEntity {
  id: number;
  canonical_name: string;
  entity_type: string;
  aliases?: string[];
}

interface MergeCandidate {
  entity_id: number;
  title: string;
  type: string;
  slug?: string;
  aliases?: string[];
  noWiki?: boolean;
}

function MergeModal({
  source,
  pages,
  onClose,
  onMerged,
  mode = "merge",
}: {
  source: WikiPageDetail;
  pages: WikiPageSummary[];
  onClose: () => void;
  onMerged: (targetSlug?: string) => void;
  mode?: "merge" | "absorb";
}) {
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<MergeCandidate | null>(null);
  const [orphans, setOrphans] = useState<OrphanEntity[]>([]);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Search-on-input: every keystroke (debounced 200ms) refetches orphan
  // entities from the DB with the search filter applied. No client-side
  // truncation — every entity that matches comes back regardless of how
  // many entities exist in total.
  useEffect(() => {
    const handle = setTimeout(() => {
      const params = new URLSearchParams({ no_wiki: "true" });
      if (search.trim()) params.set("search", search.trim());
      // When no search term, cap returned rows to keep the initial render
      // payload sane. Once the user types, server-side ilike narrows the set.
      params.set("limit", search.trim() ? "500" : "100");
      fetch(`/api/entities?${params}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d) return;
          setOrphans((d.entities as OrphanEntity[]) ?? []);
        })
        .catch(() => {});
    }, 200);
    return () => clearTimeout(handle);
  }, [search]);

  const wikiCandidates: MergeCandidate[] = pages
    .filter((p) => p.entity_id && p.entity_id !== source.entity_id)
    .map((p) => ({
      entity_id: p.entity_id!,
      title: p.title,
      type: getEntityType(p),
      slug: p.slug,
      aliases: p.aliases,
    }));

  const orphanCandidates: MergeCandidate[] = orphans
    .filter((o) => o.id !== source.entity_id)
    .map((o) => ({
      entity_id: o.id,
      title: o.canonical_name,
      type: o.entity_type,
      aliases: o.aliases,
      noWiki: true,
    }));

  // Deduplicate by lowercase title: orphan entries (direct from entities table,
  // guaranteed live) take precedence over wiki entries (wiki_pages.entity_id
  // can be stale if the entity was merged/deleted after the page was compiled).
  const byTitle = new Map<string, MergeCandidate>();
  for (const c of [...orphanCandidates, ...wikiCandidates]) {
    const key = c.title.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, c);
  }

  const candidates = Array.from(byTitle.values()).filter(
    (c) =>
      search === "" ||
      c.title.toLowerCase().includes(search.toLowerCase()) ||
      (c.aliases ?? []).some((a) => a.toLowerCase().includes(search.toLowerCase()))
  );

  const handleMerge = async () => {
    if (!target || !source.entity_id) return;
    setMerging(true);
    setError(null);
    try {
      // absorb: picked entity (target) is deleted, source wiki page survives
      // merge:  source wiki page is deleted, picked entity (target) survives
      const deleteId = mode === "absorb" ? target.entity_id : source.entity_id;
      const survivingId = mode === "absorb" ? source.entity_id : target.entity_id;
      const survivingSlug = mode === "absorb" ? source.slug : target.slug;
      const res = await fetch(`/api/entities/${deleteId}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_id: survivingId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || `HTTP ${res.status}`);
      }
      onMerged(survivingSlug);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Merge failed");
    } finally {
      setMerging(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-bg-surface border border-border rounded-xl shadow-xl w-full max-w-md mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-text-primary">
            {mode === "absorb"
              ? <>Absorb a duplicate into &ldquo;{source.title}&rdquo;&hellip;</>
              : <>Merge &ldquo;{source.title}&rdquo; into&hellip;</>}
          </h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-secondary transition-colors text-lg leading-none">
            ×
          </button>
        </div>

        <p className="text-xs text-text-muted mb-3">
          {mode === "absorb"
            ? "Pick a duplicate entity — its thoughts, edges, and aliases move here and it is permanently deleted."
            : "All thoughts, edges, and aliases move to the target. The source entity is permanently deleted."}
        </p>

        <input
          type="text"
          autoFocus
          value={search}
          onChange={(e) => { setSearch(e.target.value); setTarget(null); }}
          placeholder="Search entities…"
          className="w-full bg-bg-elevated border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-violet mb-2"
        />

        <div className="max-h-48 overflow-y-auto border border-border rounded-lg mb-3">
          {candidates.length === 0 ? (
            <p className="px-3 py-4 text-xs text-text-muted text-center">No matching entities</p>
          ) : (
            candidates.slice(0, 20).map((c) => (
              <button
                key={`${c.noWiki ? "orphan" : "wiki"}-${c.entity_id}`}
                onClick={() => setTarget(c)}
                className={`w-full text-left px-3 py-2 border-b border-border/50 last:border-0 transition-colors text-sm ${
                  target?.entity_id === c.entity_id
                    ? "bg-violet-surface text-violet"
                    : "hover:bg-bg-hover text-text-primary"
                }`}
              >
                {c.title}
                <span className="ml-1.5 text-xs text-text-muted">{c.type}</span>
                {c.noWiki && (
                  <span className="ml-1.5 text-[10px] text-amber-400/70">(no wiki)</span>
                )}
              </button>
            ))
          )}
        </div>

        {target && (
          <p className="text-xs text-amber-400 mb-3">
            {mode === "absorb"
              ? <>⚠ &ldquo;{target.title}&rdquo; will be deleted. Everything moves to &ldquo;{source.title}&rdquo;.</>
              : <>⚠ &ldquo;{source.title}&rdquo; will be deleted. Everything moves to &ldquo;{target.title}&rdquo;.</>}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm bg-bg-elevated border border-border rounded-lg text-text-secondary hover:bg-bg-hover transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleMerge}
            disabled={!target || merging}
            className="px-3 py-1.5 text-sm bg-danger text-white rounded-lg hover:bg-danger/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {merging
              ? "Merging…"
              : target
                ? mode === "absorb" ? `Absorb "${target.title}" here` : `Merge into ${target.title}`
                : "Select a duplicate first"}
          </button>
        </div>

        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

function WikiPageInner() {
  const searchParams = useSearchParams();
  const [pages, setPages] = useState<WikiPageSummary[]>([]);
  const [selected, setSelected] = useState<WikiPageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  // List-load error (shown in the list panel). Detail errors live in
  // `detailError` so a stale slug 404 doesn't obscure the list.
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showAliasModal, setShowAliasModal] = useState(false);
  const [showEdgesModal, setShowEdgesModal] = useState(false);
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [showAbsorbModal, setShowAbsorbModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [typeFilter, setTypeFilter] = useState<EntityTypeFilter>("all");
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesContent, setNotesContent] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Wiki regen state: idle / queueing (request in flight) / queued
  // (worker accepted it, refresh in ~60s to see the new article).
  const [regenStatus, setRegenStatus] = useState<"idle" | "queueing" | "queued">("idle");
  const [view, setView] = useState<"graph" | "list">("graph");

  useEffect(() => {
    setLoading(true);
    fetch("/api/wiki")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: { data: WikiPageSummary[] }) => {
        setPages(d.data || []);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Auto-select entry from ?slug= query param (used by wiki cross-links)
  const slugParam = searchParams.get("slug");
  useEffect(() => {
    if (slugParam && pages.length > 0 && (!selected || selected.slug !== slugParam)) {
      const match = pages.find((p) => p.slug === slugParam);
      if (match) loadDetail(match.slug);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slugParam, pages]);

  const loadDetail = useCallback((slug: string) => {
    setDetailLoading(true);
    setDetailError(null);
    setEditingNotes(false);
    setNotesError(null);
    window.history.replaceState(null, "", `/wiki?slug=${encodeURIComponent(slug)}`);
    fetch(`/api/wiki/${encodeURIComponent(slug)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: WikiPageDetail) => {
        const listEntry = pages.find((p) => p.slug === slug);
        setSelected({ ...d, aliases: listEntry?.aliases ?? [] });
        setNotesContent(d.notes ?? "");
      })
      .catch((e: Error) => {
        // Detail errors stay in the detail panel — don't poison the list.
        // Most common: stale ?slug= in URL pointing at a page that was
        // deleted (e.g. via merge/absorb). Clear `selected` so the user
        // can pick a different one.
        setDetailError(e.message);
        setSelected(null);
      })
      .finally(() => setDetailLoading(false));
  }, [pages]);

  const handleSaveNotes = useCallback(async () => {
    if (!selected) return;
    setSavingNotes(true);
    setNotesError(null);
    try {
      const res = await fetch(`/api/wiki/${encodeURIComponent(selected.slug)}/notes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notesContent }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || `HTTP ${res.status}`);
      }
      setSelected((prev) => prev ? { ...prev, notes: notesContent || null } : prev);
      setEditingNotes(false);
    } catch (e) {
      setNotesError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingNotes(false);
    }
  }, [selected, notesContent]);

  const handleMerged = useCallback((targetSlug?: string) => {
    setShowMergeModal(false);
    setLoading(true);
    fetch("/api/wiki")
      .then((r) => r.json())
      .then((d: { data: WikiPageSummary[] }) => {
        setPages(d.data || []);
        setLoading(false);
        if (targetSlug) loadDetail(targetSlug);
        else setSelected(null);
      })
      .catch(() => setLoading(false));
  }, [loadDetail]);

  const handleAliasAdded = useCallback((alias: string) => {
    setPages((prev) =>
      prev.map((p) =>
        p.slug === selected?.slug
          ? { ...p, aliases: [...(p.aliases ?? []), alias] }
          : p
      )
    );
    setSelected((prev) =>
      prev ? { ...prev, aliases: [...(prev.aliases ?? []), alias] } : prev
    );
  }, [selected?.slug]);

  const handleAliasRemoved = useCallback((alias: string) => {
    setPages((prev) =>
      prev.map((p) =>
        p.slug === selected?.slug
          ? { ...p, aliases: (p.aliases ?? []).filter((a) => a !== alias) }
          : p
      )
    );
    setSelected((prev) =>
      prev ? { ...prev, aliases: (prev.aliases ?? []).filter((a) => a !== alias) } : prev
    );
  }, [selected?.slug]);

  const handleRenamed = useCallback((newName: string) => {
    setShowRenameModal(false);
    setPages((prev) =>
      prev.map((p) => (p.slug === selected?.slug ? { ...p, title: newName } : p))
    );
    setSelected((prev) => (prev ? { ...prev, title: newName } : prev));
  }, [selected?.slug]);

  const handleTypeChanged = useCallback((newType: string) => {
    setSelected((prev) =>
      prev ? { ...prev, metadata: { ...prev.metadata, entity_type: newType } } : prev
    );
    setPages((prev) =>
      prev.map((p) =>
        p.slug === selected?.slug
          ? { ...p, metadata: { ...(p.metadata ?? {}), entity_type: newType } }
          : p
      )
    );
  }, [selected?.slug]);

  // Regen — queues one of the entity's thoughts back through the
  // entity-extraction queue so the local worker re-extracts and then
  // regenerates the wiki article on its next queue drain. Useful for
  // one-off fixes when the LLM produced a corrupt article (e.g. a
  // token loop in the TLDR). Async — the article won't change in
  // place; the user has to refresh in 30-60s to see the new version.
  const handleRegenerate = useCallback(async () => {
    if (!selected?.slug) return;
    setRegenStatus("queueing");
    try {
      const res = await fetch(
        `/api/wiki/${encodeURIComponent(selected.slug)}/regen`,
        { method: "POST" }
      );
      const d = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setRegenStatus("queued");
      // Reset status after a window so the button is re-usable.
      setTimeout(() => setRegenStatus("idle"), 60_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Regen failed");
      setRegenStatus("idle");
    }
  }, [selected?.slug]);

  const handleDeleteEntity = useCallback(async () => {
    if (!selected?.entity_id) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/entities/${selected.entity_id}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || `HTTP ${res.status}`);
      }
      setPages((prev) => prev.filter((p) => p.slug !== selected.slug));
      setSelected(null);
      setConfirmDelete(false);
      window.history.replaceState(null, "", "/wiki");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }, [selected]);

  const q = search.trim().toLowerCase();
  const filteredPages = pages.filter((p) => {
    if (q && !p.title.toLowerCase().includes(q) &&
        !(p.aliases ?? []).some((a) => a.toLowerCase().includes(q))) return false;
    if (typeFilter !== "all" && getEntityType(p) !== typeFilter) return false;
    return true;
  });

  const entityPages = filteredPages.filter((p) => p.type === "entity");
  const topicPages = filteredPages.filter((p) => p.type === "topic");

  // Lowercase title/alias → slug, for auto-resolving bare [Entity Name] brackets
  // that the wiki compiler emits without markdown link syntax. Built once per
  // pages-list change so render cost is constant.
  const entityMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of pages) {
      map.set(p.title.toLowerCase(), p.slug);
      for (const alias of p.aliases ?? []) {
        if (alias) map.set(alias.toLowerCase(), p.slug);
      }
    }
    return map;
  }, [pages]);

  // Save curator notes — used by both views.
  // Returns the server's response so the CuratorNotePanel can surface the
  // regen status (`queued` | `no_entity` | `no_thoughts` | `failed`).
  // Saving now auto-enqueues a wiki regen on the server side; clicking
  // "Regenerate" separately is only needed if the auto-enqueue reported
  // a failure.
  const saveNotes = useCallback(
    async (notes: string): Promise<{ regen_status?: string; message?: string }> => {
      if (!selected) return {};
      const res = await fetch(`/api/wiki/${encodeURIComponent(selected.slug)}/notes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || `HTTP ${res.status}`);
      }
      const data = (await res.json().catch(() => ({}))) as { regen_status?: string; message?: string };
      setSelected((prev) => (prev ? { ...prev, notes: notes || null } : prev));
      setNotesContent(notes);
      return data;
    },
    [selected]
  );

  // Graph view: full-bleed, dark canvas, constellation hero + 2-col body
  if (view === "graph") {
    return (
      <div
        className="ob1-fullbleed from-legacy"
        style={{ background: "var(--bg-0)", minHeight: "100vh" }}
      >
        <div
          className="mobile-pad"
          style={{
            padding: "32px 40px 56px",
            display: "flex",
            flexDirection: "column",
            gap: 22,
          }}
        >
          {/* Header */}
          <div
            className="mobile-wrap"
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 24,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div className="eyebrow" style={{ marginBottom: 8 }}>
                Brain · Wiki
              </div>
              <h1
                className="mobile-h1"
                style={{
                  margin: 0,
                  fontSize: 30,
                  fontWeight: 600,
                  letterSpacing: "-0.025em",
                  color: "var(--fg)",
                }}
              >
                {pages.length} entit{pages.length === 1 ? "y" : "ies"} in your knowledge graph
              </h1>
              <p
                style={{
                  margin: "6px 0 0",
                  color: "var(--fg-3)",
                  fontSize: 14,
                  maxWidth: 660,
                }}
              >
                Articles are auto-generated from your thoughts. You can&apos;t edit them
                directly — drop a curator note instead and it&apos;ll steer the next
                regeneration.
              </p>
            </div>
            <ViewToggle view={view} setView={setView} />
          </div>

          <WikiGraphView
            selected={selected}
            onSelectSlug={loadDetail}
            onSaveNotes={saveNotes}
            onRename={() => setShowRenameModal(true)}
            onAliases={() => setShowAliasModal(true)}
            onEdges={() => setShowEdgesModal(true)}
            onAbsorb={() => setShowAbsorbModal(true)}
            onMerge={() => setShowMergeModal(true)}
            onDelete={handleDeleteEntity}
            onRegenerate={handleRegenerate}
            regenStatus={regenStatus}
            onTypeChanged={handleTypeChanged}
            confirmDelete={confirmDelete}
            setConfirmDelete={setConfirmDelete}
            deleting={deleting}
          />
        </div>

        {/* Entity-management modals — same set the List view uses. */}
        {showAliasModal && selected && (
          <AliasModal
            page={selected}
            onClose={() => setShowAliasModal(false)}
            onAliasAdded={handleAliasAdded}
            onAliasRemoved={handleAliasRemoved}
          />
        )}
        {showEdgesModal && selected && (
          <EdgesModal
            page={selected}
            onClose={() => setShowEdgesModal(false)}
            onEdgeRemoved={() => { /* edge list refreshes locally; article regen comes on next worker tick */ }}
          />
        )}
        {showMergeModal && selected && (
          <MergeModal
            source={selected}
            pages={pages}
            onClose={() => setShowMergeModal(false)}
            onMerged={handleMerged}
          />
        )}
        {showAbsorbModal && selected && (
          <MergeModal
            source={selected}
            pages={pages}
            mode="absorb"
            onClose={() => setShowAbsorbModal(false)}
            onMerged={handleMerged}
          />
        )}
        {showRenameModal && selected && (
          <RenameModal
            page={selected}
            onClose={() => setShowRenameModal(false)}
            onRenamed={handleRenamed}
          />
        )}
      </div>
    );
  }

  return (
    <>
      {showAliasModal && selected && (
        <AliasModal
          page={selected}
          onClose={() => setShowAliasModal(false)}
          onAliasAdded={handleAliasAdded}
          onAliasRemoved={handleAliasRemoved}
        />
      )}

      {showEdgesModal && selected && (
        <EdgesModal
          page={selected}
          onClose={() => setShowEdgesModal(false)}
          onEdgeRemoved={() => { /* edge list refreshes locally; article regen comes on next worker tick */ }}
        />
      )}

      {showMergeModal && selected && (
        <MergeModal
          source={selected}
          pages={pages}
          onClose={() => setShowMergeModal(false)}
          onMerged={handleMerged}
        />
      )}

      {showAbsorbModal && selected && (
        <MergeModal
          source={selected}
          pages={pages}
          mode="absorb"
          onClose={() => setShowAbsorbModal(false)}
          onMerged={handleMerged}
        />
      )}

      {showRenameModal && selected && (
        <RenameModal
          page={selected}
          onClose={() => setShowRenameModal(false)}
          onRenamed={handleRenamed}
        />
      )}

      <div className="flex h-[calc(100vh-4rem)] gap-0">
        {/* Left panel — list. On mobile, hide once a page is selected so the
            detail pane takes the full viewport. Tap the back arrow in the
            detail header to return. */}
        <div className={`${selected ? "hidden md:flex" : "flex"} w-full md:w-72 shrink-0 md:border-r border-border flex-col overflow-hidden`}>
          <div className="px-4 py-3 border-b border-border">
            <div className="flex items-center justify-between gap-2 mb-1">
              <h1 className="text-lg font-semibold text-text-primary">Wiki</h1>
              <ViewToggle view={view} setView={setView} />
            </div>
            <p className="text-xs text-text-muted mt-0.5">
              {pages.length} page{pages.length !== 1 ? "s" : ""}
            </p>
            <div className="flex flex-wrap gap-1 mt-2">
              {ENTITY_TYPE_FILTERS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => setTypeFilter(f.value)}
                  className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-all ${
                    typeFilter === f.value
                      ? "bg-violet text-white"
                      : "bg-bg-surface border border-border text-text-muted hover:text-text-secondary"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Search */}
          <div className="px-3 py-2 border-b border-border">
            <div className="relative">
              <svg
                className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted pointer-events-none"
                fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"
              >
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search names & aliases…"
                className="w-full bg-bg-elevated border border-border rounded-lg pl-7 pr-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-violet"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary"
                >
                  ×
                </button>
              )}
            </div>
          </div>

          <VirtualWikiList
            loading={loading}
            error={error}
            pagesTotal={pages.length}
            search={search}
            entityPages={entityPages}
            topicPages={topicPages}
            selectedSlug={selected?.slug}
            onSelect={loadDetail}
          />
        </div>

        {/* Right panel — detail. On mobile, only render when a page is
            selected (otherwise the list pane fills the viewport). */}
        <div className={`${selected ? "flex" : "hidden md:flex"} flex-1 flex-col overflow-hidden`}>
          {detailLoading && (
            <div className="flex items-center gap-2 px-6 py-8 text-text-muted text-sm">
              <div className="w-4 h-4 border-2 border-violet/30 border-t-violet rounded-full animate-spin" />
              Loading…
            </div>
          )}

          {!detailLoading && !selected && detailError && (
            <div className="flex-1 flex items-center justify-center px-6 py-8">
              <div className="max-w-sm text-center">
                <p className="text-sm text-danger mb-2">
                  Couldn&apos;t load that wiki page ({detailError}).
                </p>
                <p className="text-xs text-text-muted mb-3">
                  The slug in the URL may point to a page that was merged or
                  deleted. Pick another from the list.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setDetailError(null);
                    window.history.replaceState(null, "", "/wiki");
                  }}
                  className="px-3 py-1.5 text-xs bg-bg-elevated border border-border rounded-lg text-text-secondary hover:bg-bg-hover transition-colors"
                >
                  Clear URL
                </button>
              </div>
            </div>
          )}

          {!detailLoading && !selected && !detailError && (
            <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
              Select a wiki page from the list
            </div>
          )}

          {!detailLoading && selected && (
            <>
              {/* Header */}
              <div className="px-6 py-4 border-b border-border flex items-start justify-between gap-4 shrink-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => setSelected(null)}
                      className="md:hidden inline-flex items-center justify-center w-7 h-7 rounded-md bg-bg-elevated border border-border text-text-secondary hover:bg-bg-hover transition-colors shrink-0"
                      title="Back to list"
                      aria-label="Back to list"
                    >
                      ←
                    </button>
                    <h2 className="text-xl font-bold text-text-primary truncate">
                      {selected.title}
                    </h2>
                    {selected.entity_id ? (
                      <EntityTypeSelect key={selected.slug} page={selected} onTypeChanged={handleTypeChanged} />
                    ) : (
                      <TypeBadge page={selected} />
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <p className="text-xs text-text-muted">
                      Generated {formatDate(selected.generated_at)} &middot;{" "}
                      {selected.thought_count} thought
                      {selected.thought_count !== 1 ? "s" : ""}
                    </p>
                    {(selected.aliases ?? []).length > 0 && (
                      <div className="flex items-center gap-1 flex-wrap">
                        {(selected.aliases ?? []).map((a) => (
                          <span
                            key={a}
                            className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-bg-elevated border border-border text-[10px] text-text-muted"
                          >
                            {a}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {selected.entity_id && (
                    <>
                      <button
                        onClick={() => setShowRenameModal(true)}
                        title="Rename entity"
                        className="px-3 py-1.5 text-sm bg-bg-elevated border border-border rounded-lg text-text-secondary hover:bg-bg-hover transition-colors"
                      >
                        Rename
                      </button>
                      <button
                        onClick={() => setShowAliasModal(true)}
                        title="Manage aliases"
                        className="px-3 py-1.5 text-sm bg-bg-elevated border border-border rounded-lg text-text-secondary hover:bg-bg-hover transition-colors"
                      >
                        Aliases {(selected.aliases ?? []).length > 0 ? `(${selected.aliases!.length})` : ""}
                      </button>
                      <button
                        onClick={() => setShowEdgesModal(true)}
                        title="Edit relationships — remove wrong edges and blocklist them"
                        className="px-3 py-1.5 text-sm bg-bg-elevated border border-border rounded-lg text-text-secondary hover:bg-bg-hover transition-colors"
                      >
                        Edges
                      </button>
                      <button
                        onClick={() => setShowAbsorbModal(true)}
                        title="Absorb a duplicate into this entity — the duplicate is deleted, its data moves here"
                        className="px-3 py-1.5 text-sm bg-bg-elevated border border-border rounded-lg text-text-secondary hover:bg-bg-hover transition-colors"
                      >
                        Absorb
                      </button>
                      <button
                        onClick={() => setShowMergeModal(true)}
                        title="Merge this entity into another — this entity is deleted"
                        className="px-3 py-1.5 text-sm bg-bg-elevated border border-border rounded-lg text-text-secondary hover:bg-bg-hover transition-colors"
                      >
                        Merge
                      </button>
                      <button
                        onClick={handleRegenerate}
                        disabled={regenStatus !== "idle"}
                        title="Re-queue the entity's most recent thought so the local worker regenerates this wiki article on its next drain (~30-60s). Use for one-off LLM glitches."
                        className="px-3 py-1.5 text-sm bg-bg-elevated border border-border rounded-lg text-text-secondary hover:bg-bg-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {regenStatus === "queueing"
                          ? "Queueing…"
                          : regenStatus === "queued"
                            ? "Queued ✓ (refresh in ~60s)"
                            : "Regenerate"}
                      </button>
                      {confirmDelete ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={handleDeleteEntity}
                            disabled={deleting}
                            className="px-3 py-1.5 text-sm bg-danger text-white rounded-lg hover:bg-danger/90 transition-colors disabled:opacity-50"
                          >
                            {deleting ? "Deleting…" : "Confirm delete"}
                          </button>
                          <button
                            onClick={() => setConfirmDelete(false)}
                            className="px-3 py-1.5 text-sm bg-bg-elevated border border-border rounded-lg text-text-secondary hover:bg-bg-hover transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDelete(true)}
                          title="Delete entity and wiki page"
                          className="px-3 py-1.5 text-sm bg-bg-elevated border border-danger/30 rounded-lg text-danger/70 hover:text-danger hover:border-danger/60 transition-colors"
                        >
                          Delete
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Content area */}
              <div className="flex-1 overflow-y-auto px-6 py-4">
                <MarkdownContent content={selected.content} onWikiLink={loadDetail} entityMap={entityMap} selfSlug={selected.slug} />

                {/* Curator notes section */}
                <div className="mt-6 border-t border-border pt-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                      Curator Notes
                    </span>
                    {!editingNotes && (
                      <button
                        onClick={() => {
                          setNotesContent(selected.notes ?? "");
                          setNotesError(null);
                          setEditingNotes(true);
                        }}
                        className="text-xs text-text-muted hover:text-text-secondary transition-colors"
                      >
                        {selected.notes ? "Edit" : "Add note"}
                      </button>
                    )}
                  </div>

                  {editingNotes ? (
                    <>
                      <textarea
                        value={notesContent}
                        onChange={(e) => setNotesContent(e.target.value)}
                        placeholder="Add corrections, context, or reminders for the wiki compiler…"
                        rows={4}
                        className="w-full bg-bg-elevated border border-border rounded-lg p-3 text-sm text-text-primary placeholder:text-text-muted resize-none focus:outline-none focus:ring-1 focus:ring-violet"
                        autoFocus
                      />
                      {notesError && (
                        <p className="mt-1 text-xs text-danger">{notesError}</p>
                      )}
                      <div className="flex justify-end gap-2 mt-2">
                        <button
                          onClick={() => { setEditingNotes(false); setNotesError(null); }}
                          className="px-3 py-1.5 text-xs bg-bg-elevated border border-border rounded-lg text-text-secondary hover:bg-bg-hover transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleSaveNotes}
                          disabled={savingNotes}
                          className="px-3 py-1.5 text-xs bg-violet text-white rounded-lg hover:bg-violet/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {savingNotes ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </>
                  ) : selected.notes ? (
                    <p className="text-sm text-text-secondary whitespace-pre-wrap leading-relaxed">
                      {selected.notes}
                    </p>
                  ) : (
                    <p className="text-xs text-text-muted italic">
                      No curator notes — add context, corrections, or reminders that the wiki compiler will incorporate on next regeneration.
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

export default function WikiPage() {
  return (
    <Suspense fallback={null}>
      <WikiPageInner />
    </Suspense>
  );
}

// Virtualized wiki list. Flattens entity + topic groups into a single
// indexed row array (group headers + items), then renders only the rows
// inside the scroll viewport via @tanstack/react-virtual. Memory + render
// cost stay constant whether the user has 50 or 50,000 wiki pages.
type VirtualRow =
  | { kind: "header"; label: string; count: number }
  | { kind: "item"; page: WikiPageSummary };

function VirtualWikiList({
  loading,
  error,
  pagesTotal,
  search,
  entityPages,
  topicPages,
  selectedSlug,
  onSelect,
}: {
  loading: boolean;
  error: string | null;
  pagesTotal: number;
  search: string;
  entityPages: WikiPageSummary[];
  topicPages: WikiPageSummary[];
  selectedSlug?: string;
  onSelect: (slug: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);

  const rows = useMemo<VirtualRow[]>(() => {
    const out: VirtualRow[] = [];
    if (entityPages.length > 0) {
      out.push({ kind: "header", label: "Entities", count: entityPages.length });
      for (const p of entityPages) out.push({ kind: "item", page: p });
    }
    if (topicPages.length > 0) {
      out.push({ kind: "header", label: "Topics", count: topicPages.length });
      for (const p of topicPages) out.push({ kind: "item", page: p });
    }
    return out;
  }, [entityPages, topicPages]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (rows[i]?.kind === "header" ? 32 : 60),
    overscan: 8,
  });

  const filtered = entityPages.length + topicPages.length;
  const empty =
    !loading && !error && pagesTotal > 0 && filtered === 0;

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto">
      {loading && (
        <div className="flex items-center gap-2 px-4 py-6 text-text-muted text-sm">
          <div className="w-4 h-4 border-2 border-violet/30 border-t-violet rounded-full animate-spin" />
          Loading…
        </div>
      )}
      {error && !loading && (
        <p className="px-4 py-6 text-sm text-danger">{error}</p>
      )}
      {!loading && !error && pagesTotal === 0 && (
        <p className="px-4 py-6 text-sm text-text-muted">
          No wiki pages yet. Run the entity wiki compiler to generate pages.
        </p>
      )}
      {empty && (
        <p className="px-4 py-6 text-sm text-text-muted">
          No matches for &ldquo;{search}&rdquo;
        </p>
      )}
      {!loading && !error && rows.length > 0 && (
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: "relative",
            width: "100%",
          }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            return (
              <div
                key={vi.key}
                ref={virtualizer.measureElement}
                data-index={vi.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                {row.kind === "header" ? (
                  <div className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted border-b border-border bg-bg-surface">
                    {row.label} ({row.count})
                  </div>
                ) : (
                  <WikiListItem
                    page={row.page}
                    active={selectedSlug === row.page.slug}
                    onClick={() => onSelect(row.page.slug)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ViewToggle({
  view,
  setView,
}: {
  view: "graph" | "list";
  setView: (v: "graph" | "list") => void;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        padding: 3,
        gap: 2,
        background: "var(--bg-3)",
        border: "1px solid var(--line)",
        borderRadius: 8,
      }}
    >
      {(["graph", "list"] as const).map((v) => {
        const active = view === v;
        return (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              fontSize: 11,
              color: active ? "var(--fg)" : "var(--fg-3)",
              background: active
                ? "rgba(130,97,255,0.18)"
                : "transparent",
              border: active
                ? "1px solid rgba(157,131,255,0.25)"
                : "1px solid transparent",
              fontWeight: active ? 500 : 400,
              cursor: "pointer",
              fontFamily: "inherit",
              textTransform: "capitalize",
            }}
          >
            {v}
          </button>
        );
      })}
    </div>
  );
}

function WikiListItem({
  page,
  active,
  onClick,
}: {
  page: WikiPageSummary;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-4 py-3 border-b border-border/50 transition-colors ${
        active
          ? "bg-violet-surface border-l-2 border-l-violet"
          : "hover:bg-bg-hover"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className={`text-sm font-medium truncate ${
            active ? "text-violet" : "text-text-primary"
          }`}
        >
          {page.title}
        </span>
        <TypeBadge page={page} />
      </div>
      <p className="text-xs text-text-muted mt-0.5">
        {page.thought_count} thought{page.thought_count !== 1 ? "s" : ""}
        {(page.aliases ?? []).length > 0 && (
          <span className="ml-1 text-text-muted/60">
            · {page.aliases!.join(", ")}
          </span>
        )}
      </p>
    </button>
  );
}
