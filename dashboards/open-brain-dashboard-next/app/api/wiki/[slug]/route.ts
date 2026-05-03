import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }

  const { slug } = await params;
  const res = await fetch(`${API_URL}/wiki-pages/${encodeURIComponent(slug)}`, {
    headers: { "x-brain-key": apiKey, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `API ${res.status}: ${text || res.statusText}` },
      { status: res.status }
    );
  }
  const data = await res.json();
  return NextResponse.json(data);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }

  const { slug } = await params;
  const body = await req.json();
  const res = await fetch(`${API_URL}/wiki-pages/${encodeURIComponent(slug)}`, {
    method: "PUT",
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
  const data = await res.json();
  return NextResponse.json(data);
}
