import { NextRequest, NextResponse } from "next/server";
import { fetchThoughts } from "@/lib/api";
import { requireSession, AuthError, getSession } from "@/lib/auth";

export async function GET(request: NextRequest) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }



  const page = parseInt(request.nextUrl.searchParams.get("page") || "1", 10);
  const classification = request.nextUrl.searchParams.get("classification") || request.nextUrl.searchParams.get("context");

  try {
    // Server-side filter: quality_score_max=29, sorted by quality ascending
    const data = await fetchThoughts(apiKey, {
      page,
      per_page: 50,
      quality_score_max: 29,
      sort: "quality_score",
      order: "asc",

      classification: classification || undefined,
    });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}
