import { NextRequest, NextResponse } from "next/server";
import { fetchThoughts } from "@/lib/api";
import { requireSession, AuthError } from "@/lib/auth";

export async function GET(request: NextRequest) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }

  const sp = request.nextUrl.searchParams;

  try {
    const data = await fetchThoughts(apiKey, {
      page: sp.get("page") ? parseInt(sp.get("page")!, 10) : 1,
      per_page: sp.get("per_page") ? parseInt(sp.get("per_page")!, 10) : 25,
      type: sp.get("type") || undefined,
      source_type: sp.get("source_type") || undefined,
      importance_min: sp.get("importance_min")
        ? parseInt(sp.get("importance_min")!, 10)
        : undefined,
      quality_score_max: sp.get("quality_score_max")
        ? parseInt(sp.get("quality_score_max")!, 10)
        : undefined,
      sort: sp.get("sort") || undefined,
      order: sp.get("order") || undefined,
      classification: sp.get("classification") || undefined,
    });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}
