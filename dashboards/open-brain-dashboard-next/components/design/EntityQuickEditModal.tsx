"use client";

import { useEffect, useState } from "react";
import type { EntityTypeInfo } from "./ThoughtGraph";

interface SourceThought {
  serial_id: number;
  content_preview: string;
  type: string | null;
  classification: string | null;
  source_type: string | null;
  created_at: string;
}

interface MergeTarget {
  id: number;
  canonical_name: string;
  entity_type: string;
}

interface Props {
  entity: { id: number; name: string; type: string };
  entityTypes: EntityTypeInfo[];
  onClose: () => void;
  onUpdated: () => void;
  onDeleted: () => void;
}

// Quick-edit panel for entities that don't have their own wiki page yet
// (below MIN_LINKED_FOR_WIKI threshold). The full Rename / Aliases / Edges
// / Merge / Delete suite lives on the wiki page header — those entities
// have no page, so this is the only place to touch their type, canonical
// name, or remove them entirely.
//
// Opens when the user clicks a constellation node whose `slug` is null
// (i.e. no wiki page exists for that entity). Shift-click still triggers
// focus mode, so a curious browse-the-neighborhood interaction is
// unchanged.
export function EntityQuickEditModal({
  entity,
  entityTypes,
  onClose,
  onUpdated,
  onDeleted,
}: Props) {
  const [name, setName] = useState(entity.name);
  const [type, setType] = useState(entity.type);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Source thoughts — the thoughts where this entity was extracted from.
  // Often the fastest fix for a mis-typed entity is to edit one of these
  // and re-extract; the entity may even disappear if its name no longer
  // appears in any thought after the edit.
  const [sources, setSources] = useState<SourceThought[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesTotal, setSourcesTotal] = useState(0);
  // Merge-into-another-entity state. The most common use is collapsing a
  // sub-threshold typo/variant (FundaBot) into its canonical sibling
  // (Funderbot). After merge the source entity is deleted (thought_entities
  // + edges re-pointed, source canonical_name added as alias on target,
  // source canonical_name blocklisted to prevent re-creation).
  const [merging, setMerging] = useState(false);
  const [mergeQuery, setMergeQuery] = useState("");
  const [mergeResults, setMergeResults] = useState<MergeTarget[]>([]);
  const [mergeTarget, setMergeTarget] = useState<MergeTarget | null>(null);
  const [mergeLoading, setMergeLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSourcesLoading(true);
    fetch(`/api/entities/${entity.id}/thoughts?limit=20`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setSources(d.thoughts || []);
        setSourcesTotal(d.total || 0);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setSourcesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entity.id]);

  const dirty = name.trim() !== entity.name || type !== entity.type;

  async function handleSave() {
    if (!dirty) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, string> = {};
      if (name.trim() !== entity.name && name.trim().length > 0) body.canonical_name = name.trim();
      if (type !== entity.type) body.entity_type = type;
      const res = await fetch(`/api/entities/${entity.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      onUpdated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // Debounced search for a merge target. Skips the source itself.
  useEffect(() => {
    if (!merging) return;
    const t = mergeQuery.trim();
    if (t.length < 2) { setMergeResults([]); return; }
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/entities?search=${encodeURIComponent(t)}&limit=8`);
        if (!res.ok) return;
        const d = (await res.json()) as { entities?: MergeTarget[]; data?: MergeTarget[] };
        const rows = (d.entities || d.data || []).filter((e) => e.id !== entity.id);
        setMergeResults(rows);
      } catch { /* ignore */ }
    }, 200);
    return () => clearTimeout(handle);
  }, [merging, mergeQuery, entity.id]);

  async function handleMerge() {
    if (!mergeTarget) return;
    setMergeLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/entities/${entity.id}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_id: mergeTarget.id }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      // Merge deletes the source entity; treat as a remove for parent state.
      onDeleted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Merge failed");
    } finally {
      setMergeLoading(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/entities/${entity.id}`, { method: "DELETE" });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      onDeleted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      setDeleting(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 80,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420,
          maxWidth: "100%",
          background: "var(--bg-1)",
          border: "1px solid var(--line-strong)",
          borderRadius: 14,
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div>
          <div className="eyebrow" style={{ marginBottom: 6 }}>
            Quick edit · no wiki page
          </div>
          <h3
            style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              color: "var(--fg)",
            }}
          >
            #{entity.id} {entity.name}
          </h3>
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--fg-4)" }}>
            This entity has fewer linked thoughts than the wiki threshold
            (MIN_LINKED_FOR_WIKI). It appears on the constellation but
            doesn&apos;t have its own page yet. Use this panel to correct its
            type, rename it, or remove it entirely.
          </p>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="eyebrow">Canonical name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              background: "var(--bg-2)",
              border: "1px solid var(--line-strong)",
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 14,
              color: "var(--fg)",
              outline: "none",
              fontFamily: "inherit",
            }}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="eyebrow">Entity type</span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            style={{
              background: "var(--bg-2)",
              border: "1px solid var(--line-strong)",
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 14,
              color: "var(--fg)",
              outline: "none",
              fontFamily: "inherit",
            }}
          >
            {entityTypes.length === 0 ? (
              <option value={type}>{type}</option>
            ) : (
              entityTypes.map((t) => (
                <option key={t.entity_type} value={t.entity_type}>
                  {t.entity_type}
                </option>
              ))
            )}
          </select>
        </label>

        {/* Source thoughts — the thoughts where this entity is mentioned.
            Often the fastest fix for a mis-typed or noisy entity is to
            edit one of these directly. After the edit the worker
            re-extracts and the entity may even disappear if its name
            no longer appears anywhere. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="eyebrow">
            Source thoughts
            {sourcesTotal > 0 && (
              <span style={{ color: "var(--fg-4)", marginLeft: 6 }}>
                ({sourcesTotal})
              </span>
            )}
          </span>
          {sourcesLoading ? (
            <span style={{ fontSize: 12, color: "var(--fg-4)" }}>Loading…</span>
          ) : sources.length === 0 ? (
            <span style={{ fontSize: 12, color: "var(--fg-4)" }}>
              No linked thoughts. The entity may be orphaned — Delete is safe.
            </span>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                maxHeight: 160,
                overflowY: "auto",
                border: "1px solid var(--line)",
                borderRadius: 8,
                background: "var(--bg-2)",
              }}
            >
              {sources.map((t) => (
                <a
                  key={t.serial_id}
                  href={`/thoughts/${t.serial_id}`}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    padding: "6px 10px",
                    fontSize: 12,
                    color: "var(--fg-2)",
                    textDecoration: "none",
                    borderBottom: "1px solid var(--line)",
                  }}
                  title="Open thought · edit content · worker re-extracts on save"
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      color: "var(--violet-300)",
                      flexShrink: 0,
                      width: 36,
                    }}
                  >
                    #{t.serial_id}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t.content_preview}
                  </span>
                </a>
              ))}
            </div>
          )}
          <span style={{ fontSize: 10.5, color: "var(--fg-4)" }}>
            Edit a thought → save → worker re-extracts → this entity may
            be auto-removed if its name no longer appears.
          </span>
        </div>

        {/* Merge into another entity. The canonical "Funderbot has 3 typos"
            case: pick the surviving entity, the source gets absorbed (its
            thought_entities + edges re-point to the target, its
            canonical_name + aliases land on the target, then the source row
            is deleted). Works regardless of whether the target has a wiki
            page — the merge endpoint doesn't care. */}
        {!merging ? (
          <button
            type="button"
            onClick={() => { setMerging(true); setError(null); }}
            style={{
              ...ghostBtn,
              color: "var(--violet-200)",
              borderColor: "rgba(157,131,255,0.4)",
              alignSelf: "flex-start",
            }}
          >
            Merge into another entity…
          </button>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: 12,
              borderRadius: 10,
              border: "1px solid rgba(157,131,255,0.4)",
              background: "rgba(157,131,255,0.05)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--violet-200)" }}>
                merge {entity.name} into…
              </span>
              <button
                type="button"
                onClick={() => { setMerging(false); setMergeQuery(""); setMergeResults([]); setMergeTarget(null); }}
                style={{ background: "transparent", border: "none", color: "var(--fg-3)", fontSize: 16, cursor: "pointer", lineHeight: 1 }}
              >
                ×
              </button>
            </div>

            <input
              type="text"
              value={mergeQuery}
              onChange={(e) => { setMergeQuery(e.target.value); setMergeTarget(null); }}
              placeholder="Search for the surviving entity by name or alias…"
              style={{
                background: "var(--bg-2)",
                border: "1px solid var(--line-strong)",
                borderRadius: 8,
                padding: "7px 10px",
                fontSize: 13,
                color: "var(--fg)",
                outline: "none",
                fontFamily: "inherit",
              }}
            />

            {!mergeTarget && mergeResults.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 1, maxHeight: 160, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg-2)" }}>
                {mergeResults.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => { setMergeTarget(r); setMergeQuery(r.canonical_name); setMergeResults([]); }}
                    style={{ textAlign: "left", padding: "7px 10px", background: "transparent", border: "none", color: "var(--fg)", cursor: "pointer", fontSize: 12.5, display: "flex", justifyContent: "space-between", gap: 8 }}
                  >
                    <span>{r.canonical_name}</span>
                    <span style={{ fontSize: 10, color: "var(--fg-4)", fontFamily: "var(--font-mono)" }}>
                      {r.entity_type} · #{r.id}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {mergeTarget && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: "var(--fg-2)" }}>
                  <strong>{entity.name}</strong> <span style={{ color: "var(--fg-4)" }}>→</span> <strong>{mergeTarget.canonical_name}</strong>
                  <span style={{ marginLeft: 8, fontSize: 10, color: "var(--fg-4)", fontFamily: "var(--font-mono)" }}>
                    #{entity.id} merges into #{mergeTarget.id}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={handleMerge}
                  disabled={mergeLoading}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 6,
                    border: "1px solid rgba(157,131,255,0.5)",
                    background: "rgba(157,131,255,0.25)",
                    color: "var(--violet-100)",
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: mergeLoading ? "not-allowed" : "pointer",
                    fontFamily: "inherit",
                    opacity: mergeLoading ? 0.6 : 1,
                  }}
                >
                  {mergeLoading ? "Merging…" : "Confirm merge"}
                </button>
              </div>
            )}

            <p style={{ fontSize: 10.5, color: "var(--fg-4)", margin: 0, lineHeight: 1.5 }}>
              The source entity is <strong>deleted</strong> — its thoughts, edges, and aliases all re-point to the target. The source name is blocklisted on the worker so it can&apos;t re-emerge.
            </p>
          </div>
        )}

        {error && (
          <div
            style={{
              fontSize: 12,
              color: "#ff9b9b",
              padding: "6px 10px",
              background: "rgba(255,80,80,0.08)",
              border: "1px solid rgba(255,80,80,0.3)",
              borderRadius: 6,
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
            gap: 10,
            marginTop: 4,
          }}
        >
          {confirmDelete ? (
            <span style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                style={{
                  padding: "7px 12px",
                  borderRadius: 8,
                  border: "1px solid rgba(255,80,80,0.6)",
                  background: "var(--crit, #c33)",
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
                onClick={() => setConfirmDelete(false)}
                style={ghostBtn}
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              title="Delete this entity and all its thought-entity links"
              style={{
                ...ghostBtn,
                borderColor: "rgba(255,80,80,0.3)",
                color: "rgba(255,150,150,0.9)",
              }}
            >
              Delete entity
            </button>
          )}
          <span style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onClose} style={ghostBtn}>
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !dirty}
              style={{
                padding: "7px 12px",
                borderRadius: 8,
                border: "none",
                background: "var(--violet-500, #7c5cff)",
                color: "#fff",
                fontSize: 12,
                fontWeight: 500,
                cursor: saving || !dirty ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                opacity: saving || !dirty ? 0.55 : 1,
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </span>
        </div>
      </div>
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
