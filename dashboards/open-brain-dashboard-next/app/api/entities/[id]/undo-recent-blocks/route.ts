import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }

  const { id } = await params;
  const minutes = req.nextUrl.searchParams.get("minutes");
  const qs = minutes ? `?minutes=${encodeURIComponent(minutes)}` : "";
  const res = await fetch(`${API_URL}/entities/${id}/undo-recent-blocks${qs}`, {
    method: "POST",
    headers: { "x-brain-key": apiKey, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `API ${res.status}: ${text || res.statusText}` },
      { status: res.status }
    );
  }
  return NextResponse.json(await res.json());
}
