import { NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

export async function PATCH(
  req: Request,
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
  const body = await req.json();
  const res = await fetch(`${API_URL}/entities/${id}/aliases`, {
    method: "PATCH",
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
