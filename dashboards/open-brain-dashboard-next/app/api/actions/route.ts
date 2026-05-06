import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

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
  const classification = sp.get("classification") || undefined;
  const sinceHoursRaw = sp.get("since_hours");

  const params = new URLSearchParams({ limit: "200" });
  if (sinceHoursRaw && sinceHoursRaw !== "0") params.set("since_hours", sinceHoursRaw);
  if (classification) params.set("classification", classification);

  try {
    const res = await fetch(`${API_URL}/action-items?${params}`, {
      headers: { "x-brain-key": apiKey },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json({ error: text || res.statusText }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}
