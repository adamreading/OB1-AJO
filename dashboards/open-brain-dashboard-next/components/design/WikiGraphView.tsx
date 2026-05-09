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
  /** Two-step delete confirm state, lifted from parent so all modals share state. */
  confirmDelete?: boolean;
  setConfirmDelete?: (v: boolean) => void;
  deleting?: boolean;
}

interface SectionMap {
  summary?: string;
  keyFacts?: string;
  timeline?: string;
  openQuestions?: string;
  rest: { heading: string; body: string }[];
}

// Split markdown into named sections by H2 headings. Sections that fit one of
// the named slots (Summary, Key Facts, Timeline, Open Questions) are stored
// against that key; everything else is preserved in `rest` for the left
// column to render after the named blocks.
function parseSections(markdown: string): SectionMap {
  const lines = markdown.split("\n");
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
  // If markdown has any preamble before the first H2, treat it as Summary
  const preambleText = preamble.join("\n").trim();
  if (preambleText && !result.summary) {
    result.summary = preambleText.replace(/^#\s+.+$/m, "").trim();
  }

  for (const s of sections) {
    const h = s.heading.toLowerCase();
    const body = s.body.join("\n").trim();
    if (!body) continue;
    if (h.includes("summary") && !result.summary) result.summary = body;
    else if (h.includes("key fact")) result.keyFacts = body;
    else if (h.includes("timeline")) result.timeline = body;
    else if (h.includes("open question")) result.openQuestions = body;
    else result.rest.push({ heading: s.heading, body });
  }
  return result;
}

// Render markdown with #N citation chips, [Entity Name] auto-linking, lists,
// **bold**. Mirrors the existing wiki MarkdownContent but trimmed for
// section bodies rather than full pages.
function renderMarkdownInline(
  text: string,
  entityMap: Map<string, string>,
  onWikiLink: (slug: string) => void
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
      const linkMatch =
        !citationMatch && remaining.match(/^\[([^\]]+)\]/);
      const boldMatch =
        !citationMatch && !linkMatch && remaining.match(/^\*\*([^*]+)\*\*/);

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
        // Take everything up to the next special char
        const next = remaining.search(/[\[*]/);
        if (next === -1) {
          out.push(remaining);
          remaining = "";
        } else if (next === 0) {
          // Fallback — single char then continue
          out.push(remaining[0]);
          remaining = remaining.slice(1);
        } else {
          out.push(remaining.slice(0, next));
          remaining = remaining.slice(next);
        }
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
  confirmDelete = false,
  setConfirmDelete,
  deleting = false,
}: WikiGraphViewProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [graph, setGraph] = useState<{
    nodes: ConstellationNode[];
    edges: ConstellationEdge[];
  }>({ nodes: [], edges: [] });
  const [graphLoading, setGraphLoading] = useState(true);
  const [minWeight, setMinWeight] = useState(2);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [entityTypes, setEntityTypes] = useState<EntityTypeInfo[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [edges, setEdges] = useState<EdgeRow[]>([]);
  const [edgesLoading, setEdgesLoading] = useState(false);
  const [entityMap, setEntityMap] = useState<Map<string, string>>(new Map());

  // Pull dynamic entity types
  useEffect(() => {
    fetch("/api/entity-types")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.types) setEntityTypes(d.types as EntityTypeInfo[]);
      })
      .catch(() => {});
  }, []);

  // Pull constellation
  useEffect(() => {
    let cancelled = false;
    setGraphLoading(true);
    fetch("/api/constellation?days=90&limit=60&min_weight=1")
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
  }, []);

  // Build entity-name → slug map for [Entity Name] resolution in markdown
  useEffect(() => {
    fetch("/api/wiki")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.data) return;
        const map = new Map<string, string>();
        for (const p of d.data as { title: string; slug: string; aliases?: string[] }[]) {
          map.set(p.title.toLowerCase(), p.slug);
          for (const a of p.aliases ?? []) map.set(a.toLowerCase(), p.slug);
        }
        setEntityMap(map);
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

  function toggleType(t: string) {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  // Apply search filter to nodes (parent does it so the constellation
  // doesn't need to know about searchQuery internals)
  const filteredNodes = useMemo(() => {
    if (!searchQuery.trim()) return graph.nodes;
    const q = searchQuery.trim().toLowerCase();
    return graph.nodes.filter((n) => n.label.toLowerCase().includes(q));
  }, [graph.nodes, searchQuery]);

  const selectedNode = useMemo(() => {
    if (!selected) return null;
    return graph.nodes.find((n) => n.slug === selected.slug) ?? null;
  }, [graph.nodes, selected]);

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
                height: collapsed ? 100 : 480,
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
              width={1100}
              height={collapsed ? 100 : 480}
              minWeight={minWeight}
              hiddenTypes={hiddenTypes}
              entityTypes={entityTypes}
              selectedId={selectedNode?.id ?? null}
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
              <span
                style={{
                  fontSize: 10,
                  fontFamily: "var(--font-mono)",
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                  padding: "3px 9px",
                  borderRadius: 4,
                  background: "rgba(80,200,200,0.10)",
                  color: "#7adcdc",
                  border: "1px solid rgba(80,200,200,0.25)",
                }}
              >
                {selected.type}
              </span>
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
                <button type="button" onClick={onRegenerate} style={ghostBtn}>
                  Regenerate
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
              {sections?.summary && (
                <Section title="Summary">
                  {renderMarkdownInline(sections.summary, entityMap, onSelectSlug)}
                </Section>
              )}
              {sections?.keyFacts && (
                <Section title="Key Facts">
                  {renderMarkdownInline(sections.keyFacts, entityMap, onSelectSlug)}
                </Section>
              )}
              {sections?.timeline && (
                <Section title="Timeline">
                  {renderMarkdownInline(sections.timeline, entityMap, onSelectSlug)}
                </Section>
              )}
              {sections?.rest.map((s) => (
                <Section key={s.heading} title={s.heading}>
                  {renderMarkdownInline(s.body, entityMap, onSelectSlug)}
                </Section>
              ))}
              {!sections?.summary &&
                !sections?.keyFacts &&
                !sections?.timeline &&
                sections?.rest.length === 0 && (
                  <span style={{ color: "var(--fg-4)", fontSize: 13 }}>
                    No structured content yet — wait for the next regeneration.
                  </span>
                )}
            </div>

            {/* Right — Relationships, Open Questions, Curator Note */}
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
                    onSelectSlug
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
