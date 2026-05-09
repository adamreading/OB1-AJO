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

  const sp = new URLSearchParams();
  for (const k of ["limit", "days", "min_weight", "classification"]) {
    const v = request.nextUrl.searchParams.get(k);
    if (v) sp.set(k, v);
  }
  const qs = sp.toString();

  try {
    const res = await fetch(
      `${API_URL}/constellation${qs ? `?${qs}` : ""}`,
      { headers: { "x-brain-key": apiKey } }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: text || res.statusText },
        { status: res.status }
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}
