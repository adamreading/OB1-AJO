import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

function headers(apiKey: string): HeadersInit {
  return { "x-brain-key": apiKey, "Content-Type": "application/json" };
}

export async function GET(request: NextRequest) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }

  const classification = request.nextUrl.searchParams.get("classification");
  const page = request.nextUrl.searchParams.get("page") || "1";

  const sp = new URLSearchParams({
    review_status: "pending_review",
    source_type: "plaud",
    per_page: "50",
    page,
  });
  if (classification) sp.set("classification", classification);

  try {
    const res = await fetch(`${API_URL}/thoughts?${sp}`, { headers: headers(apiKey) });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}
