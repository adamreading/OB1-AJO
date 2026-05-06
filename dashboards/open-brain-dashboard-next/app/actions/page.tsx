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

const WINDOW_OPTIONS = [
  { label: "24h", value: 24 },
  { label: "3 days", value: 72 },
  { label: "1 week", value: 168 },
  { label: "2 weeks", value: 336 },
  { label: "1 month", value: 720 },
];

export default function ActionsPage() {
  const [thoughts, setThoughts] = useState<ActionThought[]>([]);
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
      setThoughts(d.thoughts || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [context, sinceHours]);

  useEffect(() => {
    load();
  }, [load]);

  const totalItems = thoughts.reduce(
    (n, t) => n + (t.metadata.action_items?.length ?? 0),
    0
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold mb-1">Action Items</h1>
          <p className="text-text-secondary text-sm">
            Tasks and follow-ups automatically extracted from your captures
          </p>
        </div>
        {!loading && (
          <span className="text-sm text-text-muted pt-1">
            {totalItems} items across {thoughts.length} thoughts
          </span>
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
      ) : thoughts.length === 0 ? (
        <div className="text-text-muted text-sm py-12 text-center">
          No action items found in this window. Items are extracted automatically from every capture.
        </div>
      ) : (
        <div className="space-y-3">
          {thoughts.map((t) => {
            const items = t.metadata.action_items ?? [];
            const label = t.metadata.classification;
            const date = t.created_at.slice(0, 10);
            return (
              <div
                key={t.serial_id}
                className="bg-bg-surface border border-border rounded-lg p-4 space-y-2"
              >
                <div className="flex items-center gap-2 text-xs text-text-muted">
                  <Link
                    href={`/thoughts/${t.serial_id}`}
                    className="font-mono text-violet hover:underline"
                  >
                    #{t.serial_id}
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
                  {t.source_type && (
                    <span className="text-text-muted/70">{t.source_type}</span>
                  )}
                </div>
                <p className="text-text-secondary text-sm line-clamp-2">
                  {t.content.slice(0, 120)}
                  {t.content.length > 120 ? "…" : ""}
                </p>
                <ul className="space-y-1 pt-1">
                  {items.map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <span className="mt-0.5 w-4 h-4 shrink-0 rounded border border-border flex items-center justify-center">
                        <span className="w-2 h-2 rounded-sm" />
                      </span>
                      <span className="text-text-primary">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
