"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { TypeBadge } from "@/components/ThoughtCard";
import type { Thought, BrowseResponse } from "@/lib/types";
import { THOUGHT_TYPES } from "@/lib/types";

interface PendingThought extends Thought {
  metadata: Record<string, unknown> & {
    ollama_decision?: string;
    update_target_id?: number;
    original_content?: string;
    classification?: string;
  };
}

function DecisionBadge({ thought }: { thought: PendingThought }) {
  const decision = thought.metadata?.ollama_decision;
  const targetId = thought.metadata?.update_target_id;
  if (decision === "UPDATE" && targetId) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20 whitespace-nowrap">
        → #{targetId}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
      NEW
    </span>
  );
}

function ClassificationBadge({ value }: { value: string }) {
  const isWork = value === "work";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
      isWork
        ? "bg-work/10 text-work border border-work/20"
        : "bg-personal/10 text-personal border border-personal/20"
    }`}>
      {isWork ? "Work" : "Personal"}
    </span>
  );
}

type EditState = {
  content: string;
  type: string;
  classification: string;
};

export default function ReviewPage() {
  return (
    <Suspense fallback={null}>
      <ReviewPageInner />
    </Suspense>
  );
}

function ReviewPageInner() {
  const searchParams = useSearchParams();
  const classification = searchParams.get("classification");

  const [data, setData] = useState<BrowseResponse | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline editing state: thought id → edits
  const [edits, setEdits] = useState<Record<number, EditState>>({});
  const [saving, setSaving] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL("/api/review", window.location.origin);
      if (classification) url.searchParams.set("classification", classification);
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error("Failed to load");
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [classification]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setSelected(new Set()); }, [data]);

  const thoughts = (data?.data ?? []) as PendingThought[];

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === thoughts.length) setSelected(new Set());
    else setSelected(new Set(thoughts.map((t) => t.id)));
  };

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const startEdit = (t: PendingThought) => {
    setEdits((prev) => ({
      ...prev,
      [t.id]: {
        content: t.content,
        type: t.type,
        classification: (t.metadata?.classification as string) || "personal",
      },
    }));
    setExpanded((prev) => { const next = new Set(prev); next.add(t.id); return next; });
  };

  const cancelEdit = (id: number) => {
    setEdits((prev) => { const next = { ...prev }; delete next[id]; return next; });
  };

  const saveEdit = async (id: number) => {
    const edit = edits[id];
    if (!edit) return;
    setSaving((prev) => { const next = new Set(prev); next.add(id); return next; });
    try {
      const res = await fetch("/api/review/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, content: edit.content, type: edit.type, classification: edit.classification }),
      });
      if (!res.ok) throw new Error("Save failed");
      cancelEdit(id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  const approve = async (ids: number[]) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/review/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error("Approve failed");
      setSelected(new Set());
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setBusy(false);
    }
  };

  const reject = async (ids: number[]) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/review/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error("Delete failed");
      setSelected(new Set());
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Review</h1>
        <div className="flex items-center gap-2 text-text-muted text-sm">
          <div className="w-4 h-4 border-2 border-violet/30 border-t-violet rounded-full animate-spin" />
          Loading pending thoughts...
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">Review</h1>
            {data && data.total > 0 && (
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-violet text-white">
                {data.total}
              </span>
            )}
          </div>
          <p className="text-text-secondary text-sm mt-1">
            Plaud captures awaiting approval — pass to enter the brain, delete to discard
          </p>
        </div>

        {/* Classification filter */}
        <div className="flex bg-bg-surface border border-border rounded-lg p-1">
          {[
            { id: null, label: "All" },
            { id: "work", label: "Work" },
            { id: "personal", label: "Personal" },
          ].map((c) => {
            const isActive = classification === c.id;
            const sp = new URLSearchParams(searchParams.toString());
            if (c.id) sp.set("classification", c.id); else sp.delete("classification");
            return (
              <Link
                key={c.label}
                href={`/review?${sp.toString()}`}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                  isActive
                    ? c.id === "work"
                      ? "bg-work text-white"
                      : c.id === "personal"
                      ? "bg-personal text-white"
                      : "bg-violet text-white"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                {c.label}
              </Link>
            );
          })}
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 p-3 bg-bg-elevated border border-border rounded-lg">
          <span className="text-sm text-text-secondary flex-1">
            {selected.size} selected
          </span>
          <button
            disabled={busy}
            onClick={() => approve(Array.from(selected))}
            className="px-4 py-1.5 text-sm font-medium text-white bg-violet rounded-lg hover:bg-violet/90 transition-colors disabled:opacity-40"
          >
            Pass {selected.size}
          </button>
          <button
            disabled={busy}
            onClick={() => reject(Array.from(selected))}
            className="px-4 py-1.5 text-sm font-medium text-danger border border-danger/30 rounded-lg hover:bg-danger/10 transition-colors disabled:opacity-40"
          >
            Delete {selected.size}
          </button>
        </div>
      )}

      {error && <p className="text-danger text-sm">{error}</p>}

      {/* Empty state */}
      {!loading && thoughts.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-text-muted">
          <ReviewEmptyIcon />
          <p className="mt-4 text-sm">Nothing to review</p>
          <p className="text-xs mt-1">Plaud captures will appear here before entering the brain</p>
        </div>
      )}

      {/* Table */}
      {thoughts.length > 0 && (
        <div className="bg-bg-surface border border-border rounded-lg overflow-hidden overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="border-b border-border text-text-muted text-xs uppercase tracking-wider">
                <th className="px-4 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={thoughts.length > 0 && selected.size === thoughts.length}
                    onChange={toggleAll}
                    className="accent-violet"
                  />
                </th>
                <th className="text-left px-4 py-3 font-medium">Content</th>
                <th className="text-left px-4 py-3 font-medium w-28">Decision</th>
                <th className="text-left px-4 py-3 font-medium w-28">Type</th>
                <th className="text-left px-4 py-3 font-medium w-24">Context</th>
                <th className="text-right px-4 py-3 font-medium w-36">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {thoughts.map((t) => {
                const isExpanded = expanded.has(t.id);
                const edit = edits[t.id];
                const isSaving = saving.has(t.id);
                const classificationVal = (t.metadata?.classification as string) || "personal";

                return (
                  <tr key={t.id} className={`transition-colors ${isExpanded ? "bg-bg-elevated" : "hover:bg-bg-hover"}`}>
                    <td className="px-4 py-3 align-top">
                      <input
                        type="checkbox"
                        checked={selected.has(t.id)}
                        onChange={() => toggleSelect(t.id)}
                        className="accent-violet mt-0.5"
                      />
                    </td>

                    <td className="px-4 py-3">
                      {edit ? (
                        <div className="space-y-2">
                          <textarea
                            value={edit.content}
                            onChange={(e) => setEdits((prev) => ({ ...prev, [t.id]: { ...prev[t.id], content: e.target.value } }))}
                            rows={6}
                            className="w-full text-sm bg-bg-surface border border-border rounded-lg p-2 text-text-primary resize-y outline-none focus:border-violet/50 transition-colors font-mono"
                          />
                          <div className="flex items-center gap-2 flex-wrap">
                            <select
                              value={edit.type}
                              onChange={(e) => setEdits((prev) => ({ ...prev, [t.id]: { ...prev[t.id], type: e.target.value } }))}
                              className="text-xs bg-bg-elevated border border-border rounded-lg px-2 py-1 text-text-primary outline-none focus:border-violet/50"
                            >
                              {THOUGHT_TYPES.map((tp) => (
                                <option key={tp} value={tp}>{tp}</option>
                              ))}
                            </select>
                            <select
                              value={edit.classification}
                              onChange={(e) => setEdits((prev) => ({ ...prev, [t.id]: { ...prev[t.id], classification: e.target.value } }))}
                              className="text-xs bg-bg-elevated border border-border rounded-lg px-2 py-1 text-text-primary outline-none focus:border-violet/50"
                            >
                              <option value="personal">Personal</option>
                              <option value="work">Work</option>
                            </select>
                            <button
                              disabled={isSaving}
                              onClick={() => saveEdit(t.id)}
                              className="text-xs px-3 py-1 bg-violet text-white rounded-lg hover:bg-violet/90 transition-colors disabled:opacity-40"
                            >
                              {isSaving ? "Saving…" : "Save"}
                            </button>
                            <button
                              onClick={() => cancelEdit(t.id)}
                              className="text-xs px-3 py-1 border border-border rounded-lg text-text-muted hover:text-text-primary transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                          {/* Original content hint for UPDATE decisions */}
                          {t.metadata?.original_content && (
                            <details className="mt-1">
                              <summary className="text-xs text-text-muted cursor-pointer hover:text-text-secondary">
                                Show original thought (before merge)
                              </summary>
                              <p className="mt-1 text-xs text-text-muted bg-bg-surface border border-border rounded p-2 whitespace-pre-wrap">
                                {t.metadata.original_content as string}
                              </p>
                            </details>
                          )}
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => toggleExpand(t.id)}
                          className="text-left text-text-primary hover:text-violet transition-colors w-full"
                          title={isExpanded ? "Click to collapse" : "Click to show full content"}
                        >
                          <span
                            className="whitespace-pre-wrap block"
                            style={
                              isExpanded
                                ? undefined
                                : {
                                    display: "-webkit-box",
                                    WebkitLineClamp: 6,
                                    WebkitBoxOrient: "vertical",
                                    overflow: "hidden",
                                  }
                            }
                          >
                            {t.content}
                          </span>
                          {!isExpanded && t.content.split("\n").length > 6 && (
                            <span className="block text-xs text-text-muted mt-1">
                              … click to expand
                            </span>
                          )}
                        </button>
                      )}
                    </td>

                    <td className="px-4 py-3 align-top">
                      <DecisionBadge thought={t} />
                    </td>

                    <td className="px-4 py-3 align-top">
                      <TypeBadge type={t.type} />
                    </td>

                    <td className="px-4 py-3 align-top">
                      <ClassificationBadge value={classificationVal} />
                    </td>

                    <td className="px-4 py-3 align-top">
                      <div className="flex items-center justify-end gap-1">
                        {!edit && (
                          <button
                            onClick={() => startEdit(t)}
                            className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
                            title="Edit"
                          >
                            <EditIcon />
                          </button>
                        )}
                        <button
                          disabled={busy}
                          onClick={() => approve([t.id])}
                          className="p-1.5 rounded-lg text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-40"
                          title="Pass — send to brain"
                        >
                          <PassIcon />
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => reject([t.id])}
                          className="p-1.5 rounded-lg text-danger hover:bg-danger/10 transition-colors disabled:opacity-40"
                          title="Delete"
                        >
                          <DeleteIcon />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ReviewEmptyIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="text-text-muted opacity-40">
      <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="2" />
      <path d="M16 24l5 5 11-11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <path d="M10.5 1.5l3 3-9 9H1.5v-3l9-9z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function PassIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3 8l4 4 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <path d="M3 3l9 9M12 3l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
