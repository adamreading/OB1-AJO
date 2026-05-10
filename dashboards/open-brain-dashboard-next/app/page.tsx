import { fetchKanbanThoughts, fetchStats, fetchThoughts } from "@/lib/api";
import { requireSessionOrRedirect } from "@/lib/auth";
import { DashboardClient } from "@/components/design/DashboardClient";
import { KANBAN_STATUSES } from "@/lib/types";
import { TYPE_DOT_COLOR } from "@/components/design/Atoms";

export const dynamic = "force-dynamic";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

const STATUS_COLOR: Record<string, string> = {
  backlog: "#8aa0c8",
  planning: "#b8a6ff",
  active: "#6ca6ff",
  review: "#f0b450",
  done: "#50c8c8",
};

const STATUS_LABEL: Record<string, string> = {
  backlog: "Backlog",
  planning: "Planning",
  active: "Active",
  review: "Review",
  done: "Done",
};

async function jsonOrNull(url: string, apiKey: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { "x-brain-key": apiKey } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export default async function DashboardPage(props: {
  searchParams: Promise<{ window?: string; context?: string }>;
}) {
  const { apiKey } = await requireSessionOrRedirect();
  const sp = await props.searchParams;

  const windowParam = sp.window || "30";
  const days = windowParam === "all" ? undefined : parseInt(windowParam, 10);
  const context = sp.context;

  const initialWindow =
    windowParam === "all"
      ? "All"
      : (`${days}d` as "7d" | "30d" | "90d");
  const initialContext = (
    context === "work" ? "Work" : context === "personal" ? "Personal" : "All"
  ) as "All" | "Work" | "Personal";

  let stats, recent, kanbanItems, wikiPages, review;
  try {
    [stats, recent, kanbanItems, wikiPages, review] = await Promise.all([
      fetchStats(apiKey, days, context),
      fetchThoughts(apiKey, {
        page: 1,
        per_page: 12,
        classification: context,
        sort: "created_at",
        order: "desc",
      }),
      fetchKanbanThoughts(apiKey, { classification: context }),
      jsonOrNull(`${API_URL}/wiki-pages`, apiKey),
      jsonOrNull(
        `${API_URL}/thoughts?review_status=pending_review&source_type=plaud&per_page=1${
          context ? `&classification=${encodeURIComponent(context)}` : ""
        }`,
        apiKey
      ),
    ]);
  } catch (err) {
    return (
      <div style={{ padding: 32 }}>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <div className="bg-danger/10 border border-danger/30 rounded-lg p-4 text-danger text-sm mt-4">
          Failed to load dashboard data. Check API connection.
          <br />
          <span className="text-text-muted">
            {err instanceof Error ? err.message : "Unknown error"}
          </span>
        </div>
      </div>
    );
  }

  // Type breakdown — translate stats.types to TypeBreakdown[]
  const typeBreakdown = Object.entries(stats.types || {})
    .sort((a, b) => (b[1] as number) - (a[1] as number))
    .map(([type, count]) => ({
      type,
      count: count as number,
      color: TYPE_DOT_COLOR[type] || "#9595a8",
    }));

  // Workflow breakdown — group kanban items by status
  const statusCounts: Record<string, number> = {};
  for (const s of KANBAN_STATUSES) statusCounts[s] = 0;
  for (const t of kanbanItems) {
    if (t.status && statusCounts[t.status] !== undefined) {
      statusCounts[t.status] += 1;
    }
  }
  const workflowMax = Math.max(1, ...Object.values(statusCounts));
  const workflowBreakdown = KANBAN_STATUSES.map((s) => ({
    status: s,
    count: statusCounts[s],
    pct: Math.round((statusCounts[s] / workflowMax) * 100),
    color: STATUS_COLOR[s],
    label: STATUS_LABEL[s],
  }));

  const activeCount =
    statusCounts.backlog +
    statusCounts.planning +
    statusCounts.active +
    statusCounts.review;

  // Greeting line — keep it real but generic. Pick the top 1–2 entity-like topics
  // surfaced in recent thoughts, otherwise fall back to a neutral phrasing.
  const recentTopics = new Map<string, number>();
  for (const t of recent.data) {
    const topics = (t.metadata?.topics as string[]) ?? [];
    for (const tag of topics) {
      recentTopics.set(tag, (recentTopics.get(tag) ?? 0) + 1);
    }
  }
  const topRecentTopics = Array.from(recentTopics.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([t]) => t);

  const newThisWindow = recent.data.length; // top of feed is most recent
  const today = new Date();
  const dateStr = today
    .toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    })
    .toUpperCase();

  const subtitle =
    topRecentTopics.length > 0
      ? `${stats.total_thoughts.toLocaleString()} thoughts in your memory — recent focus on ${topRecentTopics
          .map((t) => `#${t}`)
          .join(" and ")}.`
      : `${stats.total_thoughts.toLocaleString()} thoughts in your memory.`;

  const greeting = {
    eyebrow: `TODAY · ${dateStr}`,
    title: "Welcome back, Adam.",
    subtitle,
  };

  const wikiCount = Array.isArray(wikiPages?.data) ? wikiPages.data.length : 0;

  return (
    <DashboardClient
      initialWindow={initialWindow}
      initialContext={initialContext}
      greeting={greeting}
      kpi={{
        total: stats.total_thoughts,
        active: activeCount,
        wiki: wikiCount,
        review: review?.total ?? 0,
        newThisWindow,
      }}
      typeBreakdown={typeBreakdown}
      workflowBreakdown={workflowBreakdown}
      recent={recent.data}
    />
  );
}
