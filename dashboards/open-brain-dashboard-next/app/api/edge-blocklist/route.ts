import { NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

async function getKey() {
  try {
    const { apiKey } = await requireSession();
    return { apiKey, error: null as null | NextResponse };
  } catch (err) {
    if (err instanceof AuthError)
      return { apiKey: "", error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    throw err;
  }
}

export async function GET() {
  const { apiKey, error } = await getKey();
  if (error) return error;
  const res = await fetch(`${API_URL}/edge-blocklist`, {
    headers: { "x-brain-key": apiKey },
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

export async function DELETE(req: Request) {
  const { apiKey, error } = await getKey();
  if (error) return error;
  const body = await req.json();
  const res = await fetch(`${API_URL}/edge-blocklist`, {
    method: "DELETE",
    headers: { "x-brain-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
