"use client";

import { useState } from "react";
import type { EntityTypeInfo } from "./ThoughtGraph";

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
