import { fetchStats, fetchThoughts } from "@/lib/api";
import { requireSessionOrRedirect, getSession } from "@/lib/auth";
import { StatsWidget } from "@/components/StatsWidget";
import { KanbanSummary } from "@/components/KanbanSummary";
import { ThoughtCard } from "@/components/ThoughtCard";
import { AddToBrain } from "@/components/AddToBrain";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { window?: string };
}) {
  const { apiKey } = await requireSessionOrRedirect();
  const session = await getSession();
  const excludeRestricted = !session.restrictedUnlocked;

  const windowParam = searchParams.window || "30";
  const days = windowParam === "all" ? undefined : parseInt(windowParam);

  let stats, recent;
  try {
    [stats, recent] = await Promise.all([
      fetchStats(apiKey, days, excludeRestricted),
      fetchThoughts(apiKey, { page: 1, per_page: 5, exclude_restricted: excludeRestricted }),
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
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold mb-1">Dashboard</h1>
          <p className="text-text-secondary text-sm">
            Overview of your second brain
          </p>
        </div>

        <div className="flex bg-bg-primary border border-border rounded-lg p-1">
          {["7", "30", "90", "all"].map((w) => (
            <a
              key={w}
              href={`/?window=${w}`}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
                windowParam === w
                  ? "bg-bg-surface text-text-primary shadow-sm"
                  : "text-text-muted hover:text-text-secondary"
              }`}
            >
              {w === "all" ? "All" : `${w}d`}
            </a>
          ))}
        </div>
      </div>

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
