import { fetchDuplicates, fetchThoughts } from "@/lib/api";
import { requireSessionOrRedirect } from "@/lib/auth";
import { ThoughtsPageClient } from "@/components/design/ThoughtsPageClient";

export const dynamic = "force-dynamic";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

async function fetchSources(apiKey: string): Promise<
  { source_type: string; count: number }[]
> {
  try {
    const res = await fetch(`${API_URL}/sources`, {
      headers: { "x-brain-key": apiKey },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.sources ?? [];
  } catch {
    return [];
  }
}

export default async function ThoughtsPage(props: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { apiKey } = await requireSessionOrRedirect();
  const sp = await props.searchParams;

  const initialQuery = sp.q || "";
  const initialMode = sp.mode === "text" ? ("Full-text" as const) : ("Semantic" as const);
  const initialContext =
    sp.classification === "work" || sp.context === "work"
      ? ("Work" as const)
      : sp.classification === "personal" || sp.context === "personal"
        ? ("Personal" as const)
        : ("All" as const);
  const initialType = sp.type || "";
  const initialSource = sp.source_type || "";
  const initialMaxScore = sp.score_max
    ? parseInt(sp.score_max, 10)
    : sp.audit
      ? 15
      : 100;
  const initialDuplicatesOnly = sp.duplicates === "1";
  const initialCompose = sp.compose === "1";

  // Fetch counts in parallel
  const [totalRes, lowScoreRes, dupRes, sources] = await Promise.all([
    fetchThoughts(apiKey, { per_page: 1 }).catch(() => null),
    fetchThoughts(apiKey, {
      per_page: 1,
      quality_score_max: 15,
    }).catch(() => null),
    fetchDuplicates(apiKey, { threshold: 0.85, limit: 100, offset: 0 }).catch(
      () => null
    ),
    fetchSources(apiKey),
  ]);

  return (
    <ThoughtsPageClient
      initial={{
        total: totalRes?.total ?? 0,
        sources,
        lowScoreCount: lowScoreRes?.total ?? 0,
        duplicatesCount: dupRes?.pairs?.length ?? 0,
      }}
      initialQuery={initialQuery}
      initialMode={initialMode}
      initialContext={initialContext}
      initialType={initialType}
      initialSource={initialSource}
      initialMaxScore={initialMaxScore}
      initialDuplicatesOnly={initialDuplicatesOnly}
      initialCompose={initialCompose}
    />
  );
}
