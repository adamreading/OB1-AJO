"use client";

import { useState, useCallback } from "react";
import { SearchBar } from "@/components/SearchBar";
import { TypeBadge } from "@/components/ThoughtCard";
import Link from "next/link";
import type { Thought } from "@/lib/types";
import { formatDate } from "@/lib/format";

import { ThoughtCard } from "@/components/ThoughtCard";

type SearchResult = Thought & { similarity?: number; rank?: number };

interface SearchState {
  results: SearchResult[];
  total: number;
  page: number;
  totalPages: number;
  mode: "semantic" | "text";
}

export default function SearchPage() {
  const [state, setState] = useState<SearchState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState("");
  const [lastMode, setLastMode] = useState<"semantic" | "text">("semantic");
  const [context, setContext] = useState<string | null>(null);

  const doSearch = useCallback(
    async (query: string, mode: "semantic" | "text", page: number = 1, currentContext: string | null = null) => {
      setLoading(true);
      setError(null);
      setLastQuery(query);
      setLastMode(mode);
      try {
        const url = new URL("/api/search", window.location.origin);
        url.searchParams.set("q", query);
        url.searchParams.set("mode", mode);
        url.searchParams.set("page", String(page));
        if (currentContext) url.searchParams.set("context", currentContext);

        const res = await fetch(url.toString());
        if (!res.ok) throw new Error("Search failed");
        const data = await res.json();
        setState({
          results: data.results || [],
          total: data.total || 0,
          page: data.page || 1,
          totalPages: data.total_pages || 1,
          mode,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Search failed");
        setState(null);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const handleSearch = useCallback(
    (query: string, mode: "semantic" | "text") => {
      doSearch(query, mode, 1, context);
    },
    [doSearch, context]
  );

  const handleContextChange = (newContext: string | null) => {
    setContext(newContext);
    if (lastQuery) {
      doSearch(lastQuery, lastMode, 1, newContext);
    }
  };

  const goToPage = useCallback(
    (page: number) => {
      if (lastQuery) doSearch(lastQuery, lastMode, page, context);
    },
    [doSearch, lastQuery, lastMode, context]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text-primary tracking-tight">
            Search
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Browse through your digital memory
          </p>
        </div>

        {/* Context Filter */}
        <div className="flex bg-bg-surface border border-border rounded-lg p-1">
          {[
            { id: null, label: "All" },
            { id: "work", label: "Work" },
            { id: "personal", label: "Personal" },
          ].map((c) => {
            const isActive = context === c.id;
            return (
              <button
                key={c.label}
                onClick={() => handleContextChange(c.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                  isActive
                    ? c.id === "work"
                      ? "bg-work text-white"
                      : c.id === "personal"
                      ? "bg-personal text-white"
                      : "bg-violet text-white shadow-sm"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      <SearchBar onSearch={handleSearch} />

      {loading && (
        <div className="flex items-center gap-2 text-text-muted text-sm">
          <div className="w-4 h-4 border-2 border-violet/30 border-t-violet rounded-full animate-spin" />
          Searching...
        </div>
      )}

      {error && <p className="text-danger text-sm">{error}</p>}

      {state !== null && !loading && (
        <div>
          <p className="text-sm text-text-muted mb-3">
            {state.total} result{state.total !== 1 ? "s" : ""}
            {state.totalPages > 1 && (
              <span>
                {" "}
                &middot; Page {state.page} of {state.totalPages}
              </span>
            )}
          </p>
          <div className="space-y-4">
            {state.results.map((r) => (
              <div key={r.id} className="relative group">
                <ThoughtCard thought={r} />
                {state.mode === "semantic" && r.similarity != null && (
                  <div className="absolute top-4 right-4 z-10">
                    <span className="text-[10px] font-bold bg-violet/20 text-violet px-2 py-0.5 rounded-full border border-violet/30 hidden sm:inline-block">
                      {(r.similarity * 100).toFixed(1)}% match
                    </span>
                  </div>
                )}
              </div>
            ))}
            {state.results.length === 0 && (
              <p className="text-text-muted text-sm px-2">No results found.</p>
            )}
          </div>

          {/* Pagination */}
          {state.totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-text-muted">
                Page {state.page} of {state.totalPages} ({state.total} results)
              </p>
              <div className="flex gap-2">
                {state.page > 1 && (
                  <button
                    onClick={() => goToPage(state.page - 1)}
                    className="px-3 py-1.5 text-sm bg-bg-elevated border border-border rounded-lg text-text-secondary hover:bg-bg-hover transition-colors"
                  >
                    Previous
                  </button>
                )}
                {state.page < state.totalPages && (
                  <button
                    onClick={() => goToPage(state.page + 1)}
                    className="px-3 py-1.5 text-sm bg-bg-elevated border border-border rounded-lg text-text-secondary hover:bg-bg-hover transition-colors"
                  >
                    Next
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
