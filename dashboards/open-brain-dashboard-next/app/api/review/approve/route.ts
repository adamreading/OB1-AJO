import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

function headers(apiKey: string): HeadersInit {
  return { "x-brain-key": apiKey, "Content-Type": "application/json" };
}

export async function POST(request: NextRequest) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }

  try {
    const { ids } = (await request.json()) as { ids: number[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "No IDs provided" }, { status: 400 });
    }

    const res = await fetch(`${API_URL}/review/approve`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Approve failed" },
      { status: 500 }
    );
  }
}
