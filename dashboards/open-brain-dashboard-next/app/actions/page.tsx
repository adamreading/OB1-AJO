"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

interface ActionThought {
  serial_id: number;
  content: string;
  type: string;
  metadata: {
    action_items?: string[];
    classification?: string;
    [key: string]: unknown;
  };
  source_type: string | null;
  created_at: string;
  importance: number;
}

// Local representation — items can be dismissed without a full reload
interface LocalItem {
  text: string;
  index: number;
  state: "idle" | "working" | "done" | "promoted" | "error";
  promotedId?: number;
  errorMsg?: string;
}

interface LocalThought {
  thought: ActionThought;
  items: LocalItem[];
}

const WINDOW_OPTIONS = [
  { label: "24h", value: 24 },
  { label: "3 days", value: 72 },
  { label: "1 week", value: 168 },
  { label: "2 weeks", value: 336 },
  { label: "1 month", value: 720 },
];

function buildLocal(thoughts: ActionThought[]): LocalThought[] {
  return thoughts.map((t) => ({
    thought: t,
    items: (t.metadata.action_items ?? []).map((text, index) => ({
      text,
      index,
      state: "idle" as const,
    })),
  }));
}

export default function ActionsPage() {
  const [locals, setLocals] = useState<LocalThought[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<"" | "work" | "personal">("");
  const [sinceHours, setSinceHours] = useState(168);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ since_hours: String(sinceHours) });
      if (context) params.set("classification", context);
      const res = await fetch(`/api/actions?${params}`);
      if (!res.ok) throw new Error("Failed to load");
      const d = await res.json();
      setLocals(buildLocal(d.thoughts || []));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [context, sinceHours]);

  useEffect(() => {
    load();
  }, [load]);

  function setItemState(thoughtId: number, itemIndex: number, patch: Partial<LocalItem>) {
    setLocals((prev) =>
      prev.map((lt) =>
        lt.thought.serial_id !== thoughtId
          ? lt
          : {
              ...lt,
              items: lt.items.map((item) =>
                item.index === itemIndex ? { ...item, ...patch } : item
              ),
            }
      )
    );
  }

  async function handleAction(
    thought: ActionThought,
    item: LocalItem,
    action: "done" | "promote"
  ) {
    setItemState(thought.serial_id, item.index, { state: "working" });
    try {
      const res = await fetch(`/api/actions/${thought.serial_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, item_index: item.index }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || res.statusText);
      }
      const d = await res.json();
      setItemState(thought.serial_id, item.index, {
        state: action === "done" ? "done" : "promoted",
        promotedId: d.promoted_id ?? undefined,
      });
    } catch (err) {
      setItemState(thought.serial_id, item.index, {
        state: "error",
        errorMsg: err instanceof Error ? err.message : "Failed",
      });
    }
  }

  const activeLocals = locals.filter((lt) =>
    lt.items.some((i) => i.state === "idle" || i.state === "working" || i.state === "error")
  );
  const totalActive = activeLocals.reduce(
    (n, lt) => n + lt.items.filter((i) => i.state === "idle" || i.state === "working").length,
    0
  );
  const totalDone = locals.reduce(
    (n, lt) => n + lt.items.filter((i) => i.state === "done" || i.state === "promoted").length,
    0
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold mb-1">Action Items</h1>
          <p className="text-text-secondary text-sm">
            Tasks and follow-ups automatically extracted from your captures. Dismiss them or promote to Kanban.
          </p>
        </div>
        {!loading && (
          <div className="text-right text-xs text-text-muted pt-1 space-y-0.5">
            <div>{totalActive} pending</div>
            {totalDone > 0 && <div className="text-emerald-400">{totalDone} handled this session</div>}
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1 bg-bg-elevated rounded-lg p-1">
          {(["", "work", "personal"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setContext(v)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                context === v
                  ? "bg-violet text-white"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {v === "" ? "All" : v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex gap-1 bg-bg-elevated rounded-lg p-1">
          {WINDOW_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setSinceHours(o.value)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                sinceHours === o.value
                  ? "bg-violet text-white"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="text-danger text-sm bg-danger/10 border border-danger/20 rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-text-muted text-sm py-8 text-center">Loading…</div>
      ) : activeLocals.length === 0 && totalDone === 0 ? (
        <div className="text-text-muted text-sm py-12 text-center">
          No action items found in this window. Items are extracted automatically from every capture.
        </div>
      ) : (
        <>
          {activeLocals.length === 0 && totalDone > 0 && (
            <div className="text-emerald-400 text-sm py-6 text-center">
              All caught up — {totalDone} item{totalDone > 1 ? "s" : ""} handled this session.
            </div>
          )}

          <div className="space-y-3">
            {activeLocals.map((lt) => {
              const { thought, items } = lt;
              const label = thought.metadata.classification;
              const date = thought.created_at.slice(0, 10);
              const visibleItems = items.filter(
                (i) => i.state !== "done" && i.state !== "promoted"
              );

              return (
                <div
                  key={thought.serial_id}
                  className="bg-bg-surface border border-border rounded-lg p-4 space-y-3"
                >
                  <div className="flex items-center gap-2 text-xs text-text-muted">
                    <Link
                      href={`/thoughts/${thought.serial_id}`}
                      className="font-mono text-violet hover:underline"
                    >
                      #{thought.serial_id}
                    </Link>
                    {label && (
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          label === "work"
                            ? "bg-blue-500/10 text-blue-400"
                            : "bg-emerald-500/10 text-emerald-400"
                        }`}
                      >
                        {label.toUpperCase()}
                      </span>
                    )}
                    <span>{date}</span>
                    {thought.source_type && (
                      <span className="text-text-muted/70">{thought.source_type}</span>
                    )}
                  </div>

                  <p className="text-text-secondary text-sm line-clamp-2">
                    {thought.content.slice(0, 150)}
                    {thought.content.length > 150 ? "…" : ""}
                  </p>

                  <ul className="space-y-2">
                    {visibleItems.map((item) => (
                      <li key={item.index} className="flex items-start gap-2.5">
                        <span className="mt-0.5 w-4 h-4 shrink-0 rounded border border-border" />
                        <span className="flex-1 text-sm text-text-primary">{item.text}</span>
                        <div className="flex items-center gap-1 shrink-0">
                          {item.state === "error" && (
                            <span
                              className="text-[10px] text-danger mr-1"
                              title={item.errorMsg}
                            >
                              error
                            </span>
                          )}
                          <button
                            type="button"
                            disabled={item.state === "working"}
                            onClick={() => handleAction(thought, item, "done")}
                            className="px-2 py-0.5 text-xs rounded border border-border text-text-muted hover:text-text-primary hover:border-emerald-500/40 hover:text-emerald-400 transition-colors disabled:opacity-40"
                            title="Mark as done — removes from this thought"
                          >
                            {item.state === "working" ? "…" : "Done"}
                          </button>
                          <button
                            type="button"
                            disabled={item.state === "working"}
                            onClick={() => handleAction(thought, item, "promote")}
                            className="px-2 py-0.5 text-xs rounded border border-border text-text-muted hover:text-violet hover:border-violet/40 transition-colors disabled:opacity-40"
                            title="Add to Kanban as a task in backlog"
                          >
                            {item.state === "working" ? "…" : "→ Kanban"}
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>

                  {/* Show promoted items with link */}
                  {items.filter((i) => i.state === "promoted").map((item) => (
                    <div key={`p-${item.index}`} className="text-xs text-violet/70 flex items-center gap-1.5 line-through">
                      <span>{item.text}</span>
                      {item.promotedId && (
                        <Link href="/kanban" className="no-underline text-violet hover:underline ml-1">
                          → on Kanban
                        </Link>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
