"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// ── Types ──────────────────────────────────────────────────────────────────

interface WikiPageSummary {
  id: number;
  slug: string;
  type: string;
  entity_id: number | null;
  title: string;
  generated_at: string;
  thought_count: number;
  manually_edited: boolean;
  aliases?: string[];
  metadata?: Record<string, unknown>;
}

const WORK_TYPES = new Set(["project", "tool", "organization", "org"]);
const PERSONAL_TYPES = new Set(["person", "place"]);

interface WikiPageDetail extends WikiPageSummary {
  content: string;
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

function MarkdownContent({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let listItems: string[] = [];
  let key = 0;

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
    return text
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

  return <div className="wiki-content">{elements}</div>;
}

// ── Alias Modal ────────────────────────────────────────────────────────────

function AliasModal({
  page,
  onClose,
  onAliasAdded,
}: {
  page: WikiPageDetail;
  onClose: () => void;
  onAliasAdded: (alias: string) => void;
}) {
  const [aliases, setAliases] = useState<string[]>(page.aliases ?? []);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
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
          <div className="flex flex-wrap gap-1.5 mb-4">
            {aliases.map((a) => (
              <span
                key={a}
                className="inline-flex items-center px-2 py-0.5 rounded-full bg-bg-elevated border border-border text-xs text-text-secondary"
              >
                {a}
              </span>
            ))}
          </div>
        )}

        <p className="text-xs text-text-muted mb-2">
          Aliases are matched during entity extraction — adding one here prevents future duplicates.
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

// ── Merge Modal ────────────────────────────────────────────────────────────

function MergeModal({
  source,
  pages,
  onClose,
  onMerged,
}: {
  source: WikiPageDetail;
  pages: WikiPageSummary[];
  onClose: () => void;
  onMerged: (targetSlug: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<WikiPageSummary | null>(null);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = pages.filter(
    (p) =>
      p.entity_id &&
      p.entity_id !== source.entity_id &&
      (search === "" ||
        p.title.toLowerCase().includes(search.toLowerCase()) ||
        (p.aliases ?? []).some((a) => a.toLowerCase().includes(search.toLowerCase())))
  );

  const handleMerge = async () => {
    if (!target || !source.entity_id || !target.entity_id) return;
    setMerging(true);
    setError(null);
    try {
      const res = await fetch(`/api/entities/${source.entity_id}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_id: target.entity_id }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || `HTTP ${res.status}`);
      }
      onMerged(target.slug);
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
            Merge &ldquo;{source.title}&rdquo; into&hellip;
          </h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-secondary transition-colors text-lg leading-none">
            ×
          </button>
        </div>

        <p className="text-xs text-text-muted mb-3">
          All thoughts, edges, and aliases move to the target. The source entity is permanently deleted.
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
            candidates.slice(0, 20).map((p) => (
              <button
                key={p.slug}
                onClick={() => setTarget(p)}
                className={`w-full text-left px-3 py-2 border-b border-border/50 last:border-0 transition-colors text-sm ${
                  target?.slug === p.slug
                    ? "bg-violet-surface text-violet"
                    : "hover:bg-bg-hover text-text-primary"
                }`}
              >
                {p.title}
                <span className="ml-1.5 text-xs text-text-muted">{p.type}</span>
              </button>
            ))
          )}
        </div>

        {target && (
          <p className="text-xs text-amber-400 mb-3">
            ⚠ &ldquo;{source.title}&rdquo; will be deleted. Everything moves to &ldquo;{target.title}&rdquo;.
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
            {merging ? "Merging…" : target ? `Merge into ${target.title}` : "Select a target first"}
          </button>
        </div>

        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function WikiPage() {
  const [pages, setPages] = useState<WikiPageSummary[]>([]);
  const [selected, setSelected] = useState<WikiPageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showAliasModal, setShowAliasModal] = useState(false);
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [contextFilter, setContextFilter] = useState<"all" | "work" | "personal">("all");

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

  const loadDetail = useCallback((slug: string) => {
    setDetailLoading(true);
    setEditing(false);
    setSaveError(null);
    fetch(`/api/wiki/${encodeURIComponent(slug)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: WikiPageDetail) => {
        // Carry aliases from the list (detail endpoint doesn't return them)
        const listEntry = pages.find((p) => p.slug === slug);
        setSelected({ ...d, aliases: listEntry?.aliases ?? [] });
        setEditContent(d.content);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setDetailLoading(false));
  }, [pages]);

  const handleSave = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/wiki/${encodeURIComponent(selected.slug)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || `HTTP ${res.status}`);
      }
      setSelected((prev) =>
        prev ? { ...prev, content: editContent, manually_edited: true } : prev
      );
      setPages((prev) =>
        prev.map((p) =>
          p.slug === selected.slug ? { ...p, manually_edited: true } : p
        )
      );
      setEditing(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [selected, editContent]);

  const handleMerged = useCallback((targetSlug: string) => {
    setShowMergeModal(false);
    setLoading(true);
    fetch("/api/wiki")
      .then((r) => r.json())
      .then((d: { data: WikiPageSummary[] }) => {
        setPages(d.data || []);
        setLoading(false);
        loadDetail(targetSlug);
      })
      .catch(() => setLoading(false));
  }, [loadDetail]);

  const handleAliasAdded = useCallback((alias: string) => {
    // Keep list aliases in sync so search works immediately
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

  // Filter by search query and context
  const q = search.trim().toLowerCase();
  const filteredPages = pages.filter((p) => {
    if (q && !p.title.toLowerCase().includes(q) &&
        !(p.aliases ?? []).some((a) => a.toLowerCase().includes(q))) return false;
    if (contextFilter !== "all") {
      const et = (p.metadata?.entity_type as string | undefined) ?? p.type;
      if (contextFilter === "work" && !WORK_TYPES.has(et)) return false;
      if (contextFilter === "personal" && !PERSONAL_TYPES.has(et)) return false;
    }
    return true;
  });

  const entityPages = filteredPages.filter((p) => p.type === "entity");
  const topicPages = filteredPages.filter((p) => p.type === "topic");

  return (
    <>
      {showAliasModal && selected && (
        <AliasModal
          page={selected}
          onClose={() => setShowAliasModal(false)}
          onAliasAdded={handleAliasAdded}
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

      <div className="flex h-[calc(100vh-4rem)] gap-0">
        {/* Left panel — list */}
        <div className="w-72 shrink-0 border-r border-border flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h1 className="text-lg font-semibold text-text-primary">Wiki</h1>
            <p className="text-xs text-text-muted mt-0.5">
              {pages.length} page{pages.length !== 1 ? "s" : ""}
            </p>
            <div className="flex bg-bg-surface border border-border rounded-lg p-1 mt-2">
              {(["all", "work", "personal"] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setContextFilter(c)}
                  className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                    contextFilter === c
                      ? c === "work"
                        ? "bg-work text-white"
                        : c === "personal"
                        ? "bg-personal text-white"
                        : "bg-violet text-white"
                      : "text-text-muted hover:text-text-secondary"
                  }`}
                >
                  {c.charAt(0).toUpperCase() + c.slice(1)}
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

          <div className="flex-1 overflow-y-auto">
            {loading && (
              <div className="flex items-center gap-2 px-4 py-6 text-text-muted text-sm">
                <div className="w-4 h-4 border-2 border-violet/30 border-t-violet rounded-full animate-spin" />
                Loading…
              </div>
            )}

            {error && !loading && (
              <p className="px-4 py-6 text-sm text-danger">{error}</p>
            )}

            {!loading && !error && pages.length === 0 && (
              <p className="px-4 py-6 text-sm text-text-muted">
                No wiki pages yet. Run the entity wiki compiler to generate pages.
              </p>
            )}

            {!loading && !error && pages.length > 0 && filteredPages.length === 0 && (
              <p className="px-4 py-6 text-sm text-text-muted">
                No matches for &ldquo;{search}&rdquo;
              </p>
            )}

            {entityPages.length > 0 && (
              <div>
                <div className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted border-b border-border bg-bg-surface sticky top-0">
                  Entities ({entityPages.length})
                </div>
                {entityPages.map((p) => (
                  <WikiListItem
                    key={p.slug}
                    page={p}
                    active={selected?.slug === p.slug}
                    onClick={() => loadDetail(p.slug)}
                  />
                ))}
              </div>
            )}

            {topicPages.length > 0 && (
              <div>
                <div className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted border-b border-border bg-bg-surface sticky top-0">
                  Topics ({topicPages.length})
                </div>
                {topicPages.map((p) => (
                  <WikiListItem
                    key={p.slug}
                    page={p}
                    active={selected?.slug === p.slug}
                    onClick={() => loadDetail(p.slug)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right panel — detail */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {detailLoading && (
            <div className="flex items-center gap-2 px-6 py-8 text-text-muted text-sm">
              <div className="w-4 h-4 border-2 border-violet/30 border-t-violet rounded-full animate-spin" />
              Loading…
            </div>
          )}

          {!detailLoading && !selected && (
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
                    <h2 className="text-xl font-bold text-text-primary truncate">
                      {selected.title}
                    </h2>
                    <TypeBadge page={selected} />
                    {selected.manually_edited && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30">
                        edited
                      </span>
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
                        onClick={() => setShowAliasModal(true)}
                        title="Manage aliases"
                        className="px-3 py-1.5 text-sm bg-bg-elevated border border-border rounded-lg text-text-secondary hover:bg-bg-hover transition-colors"
                      >
                        Aliases {(selected.aliases ?? []).length > 0 ? `(${selected.aliases!.length})` : ""}
                      </button>
                      <button
                        onClick={() => setShowMergeModal(true)}
                        title="Merge into another entity"
                        className="px-3 py-1.5 text-sm bg-bg-elevated border border-border rounded-lg text-text-secondary hover:bg-bg-hover transition-colors"
                      >
                        Merge
                      </button>
                    </>
                  )}
                  {editing ? (
                    <>
                      <button
                        onClick={() => {
                          setEditing(false);
                          setEditContent(selected.content);
                          setSaveError(null);
                        }}
                        className="px-3 py-1.5 text-sm bg-bg-elevated border border-border rounded-lg text-text-secondary hover:bg-bg-hover transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleSave}
                        disabled={saving}
                        className="px-3 py-1.5 text-sm bg-violet text-white rounded-lg hover:bg-violet/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {saving ? "Saving…" : "Save"}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => {
                        setEditContent(selected.content);
                        setEditing(true);
                      }}
                      className="px-3 py-1.5 text-sm bg-bg-elevated border border-border rounded-lg text-text-secondary hover:bg-bg-hover transition-colors"
                    >
                      Edit
                    </button>
                  )}
                </div>
              </div>

              {saveError && (
                <div className="px-6 py-2 bg-danger/10 border-b border-danger/20 text-sm text-danger">
                  {saveError}
                </div>
              )}

              {/* Content area */}
              <div className="flex-1 overflow-y-auto px-6 py-4">
                {editing ? (
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="w-full h-full min-h-[400px] bg-bg-elevated border border-border rounded-lg p-4 text-sm text-text-primary font-mono resize-none focus:outline-none focus:ring-1 focus:ring-violet"
                    spellCheck={false}
                  />
                ) : (
                  <MarkdownContent content={selected.content} />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
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
        <div className="flex items-center gap-1 shrink-0">
          {page.manually_edited && (
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Manually edited" />
          )}
          <TypeBadge page={page} />
        </div>
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
