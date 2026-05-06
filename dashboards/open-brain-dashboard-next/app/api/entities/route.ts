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
  const params = new URLSearchParams();
  if (sp.get("no_wiki") === "true") params.set("no_wiki", "true");
  if (sp.get("search")) params.set("search", sp.get("search")!);

  try {
    const res = await fetch(`${API_URL}/entities?${params}`, {
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
