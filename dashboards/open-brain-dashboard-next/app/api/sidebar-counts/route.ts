import { NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

function headers(apiKey: string): HeadersInit {
  return { "x-brain-key": apiKey };
}

async function jsonOrNull(url: string, apiKey: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: headers(apiKey) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function GET() {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }

  const [thoughts, wiki, kanbanTasks, kanbanIdeas, review] = await Promise.all([
    jsonOrNull(`${API_URL}/thoughts?per_page=1`, apiKey),
    jsonOrNull(`${API_URL}/wiki-pages`, apiKey),
    jsonOrNull(
      `${API_URL}/thoughts?type=task&status=backlog,planning,active,review&per_page=1`,
      apiKey
    ),
    jsonOrNull(
      `${API_URL}/thoughts?type=idea&status=backlog,planning,active,review&per_page=1`,
      apiKey
    ),
    jsonOrNull(
      `${API_URL}/thoughts?review_status=pending_review&source_type=plaud&per_page=1`,
      apiKey
    ),
  ]);

  const wikiCount = Array.isArray(wiki?.data) ? wiki.data.length : 0;

  return NextResponse.json({
    thoughts: thoughts?.total ?? 0,
    wiki: wikiCount,
    workflow: (kanbanTasks?.total ?? 0) + (kanbanIdeas?.total ?? 0),
    review: review?.total ?? 0,
  });
}
