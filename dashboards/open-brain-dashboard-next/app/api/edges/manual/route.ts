import { NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

export async function POST(req: Request) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }

  const body = await req.json();
  const res = await fetch(`${API_URL}/edges/manual`, {
    method: "POST",
    headers: { "x-brain-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // Pass through 409 (blocklisted) and other body payloads — the dashboard
  // surfaces the message to the user.
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return NextResponse.json(data, { status: res.status });
  }
  return NextResponse.json(data);
}
