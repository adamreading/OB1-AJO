import { fetchStats, fetchThoughts } from "@/lib/api";
import { requireSessionOrRedirect, getSession } from "@/lib/auth";
import { StatsWidget } from "@/components/StatsWidget";
import { KanbanSummary } from "@/components/KanbanSummary";
import { ThoughtCard } from "@/components/ThoughtCard";
import { AddToBrain } from "@/components/AddToBrain";
import Link from "next/link";

const TIME_WINDOWS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "All", days: "all" },
];

export const dynamic = "force-dynamic";

export default async function DashboardPage(props: {
  searchParams: Promise<{ window?: string; context?: string }>;
}) {
  const { apiKey } = await requireSessionOrRedirect();
  const session = await getSession();
  const excludeRestricted = !session.restrictedUnlocked;
  const searchParams = await props.searchParams;

  const windowParam = searchParams.window || "30";
  const days = windowParam === "all" ? undefined : parseInt(windowParam);
  const context = searchParams.context;

  let stats, recent;
  try {
    [stats, recent] = await Promise.all([
      fetchStats(apiKey, days, excludeRestricted, context),
      fetchThoughts(apiKey, {
        page: 1,
        per_page: 5,
        exclude_restricted: excludeRestricted,
        classification: context,
      }),
    ]);
  } catch (err) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <div className="bg-danger/10 border border-danger/30 rounded-lg p-4 text-danger text-sm">
          Failed to load dashboard data. Check API connection.
          <br />
          <span className="text-text-muted">
            {err instanceof Error ? err.message : "Unknown error"}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Filters & Stats Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text-primary tracking-tight">
            Dashboard
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Overview of your second brain
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Context Filter */}
          <div className="flex bg-bg-surface border border-border rounded-lg p-1">
            {[
              { id: undefined, label: "All" },
              { id: "work", label: "Work" },
              { id: "personal", label: "Personal" },
            ].map((c) => {
              const isActive = context === c.id;
              const sp = new URLSearchParams(searchParams as any);
              if (c.id) sp.set("context", c.id);
              else sp.delete("context");

              return (
                <Link
                  key={c.label}
                  href={`/?${sp.toString()}`}
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

          <div className="w-[1px] h-6 bg-border mx-1 hidden sm:block"></div>

          <div className="flex items-center gap-2 bg-bg-surface border border-border rounded-lg p-1">
            {TIME_WINDOWS.map((window) => {
              const isActive = days === window.days;
              const sp = new URLSearchParams(searchParams as any);
              sp.set("window", String(window.days));

              return (
                <Link
                  key={window.label}
                  href={`/?${sp.toString()}`}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                    isActive
                      ? "bg-violet text-white shadow-sm"
                      : "text-text-muted hover:text-text-secondary"
                  }`}
                >
                  {window.label}
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      {/* Statistics */}
      <StatsWidget stats={stats} />

      <KanbanSummary />

      {/* Add to Brain */}
      <div>
        <h2 className="text-lg font-medium mb-1">Add to Brain</h2>
        <p className="text-text-secondary text-sm mb-3">
          Paste a thought, notes, or source text. Open Brain decides whether to
          save one thought or extract several.
        </p>
        <AddToBrain rows={3} />
      </div>

      {/* Recent activity */}
      <div>
        <h2 className="text-lg font-medium mb-3">Recent Activity</h2>
        <div className="space-y-3">
          {recent.data.map((thought) => (
            <ThoughtCard key={thought.id} thought={thought} />
          ))}
          {recent.data.length === 0 && (
            <p className="text-text-muted text-sm">No thoughts yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
