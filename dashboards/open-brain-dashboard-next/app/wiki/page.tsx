"use client";

import { useState, useEffect, useCallback } from "react";

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
}

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

// Simple markdown renderer — no external deps. Handles headings, bold,
// horizontal rules, bullet lists, and paragraph breaks.
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
      const text = line.replace(/^#\s+/, "");
      elements.push(
        <h1 key={key++} className="text-xl font-bold text-text-primary mt-4 mb-2 first:mt-0">
          {text}
        </h1>
      );
    } else if (line.match(/^#{2}\s/)) {
      flushList();
      const text = line.replace(/^##\s+/, "");
      elements.push(
        <h2 key={key++} className="text-base font-semibold text-text-primary mt-4 mb-1.5 border-b border-border pb-1">
          {text}
        </h2>
      );
    } else if (line.match(/^#{3}\s/)) {
      flushList();
      const text = line.replace(/^###\s+/, "");
      elements.push(
        <h3 key={key++} className="text-sm font-semibold text-text-secondary mt-3 mb-1">
          {text}
        </h3>
      );
    } else if (line.match(/^#{4,}\s/)) {
      flushList();
      const text = line.replace(/^#{4,}\s+/, "");
      elements.push(
        <h4 key={key++} className="text-sm font-medium text-text-muted mt-2 mb-1">
          {text}
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

  // Load page list on mount
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
        setSelected(d);
        setEditContent(d.content);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setDetailLoading(false));
  }, []);

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
      // Refresh detail
      setSelected((prev) =>
        prev ? { ...prev, content: editContent, manually_edited: true } : prev
      );
      // Update list item flag
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

  // Group pages: entities first, then topics
  const entityPages = pages.filter((p) => p.type === "entity");
  const topicPages = pages.filter((p) => p.type === "topic");

  return (
    <div className="flex h-[calc(100vh-4rem)] gap-0">
      {/* Left panel — list */}
      <div className="w-72 shrink-0 border-r border-border flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h1 className="text-lg font-semibold text-text-primary">Wiki</h1>
          <p className="text-xs text-text-muted mt-0.5">
            {pages.length} page{pages.length !== 1 ? "s" : ""}
          </p>
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
                <p className="text-xs text-text-muted mt-1">
                  Generated {formatDate(selected.generated_at)} &middot;{" "}
                  {selected.thought_count} thought
                  {selected.thought_count !== 1 ? "s" : ""}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
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
      </p>
    </button>
  );
}
