import { NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

async function getApiKey() {
  try {
    const { apiKey } = await requireSession();
    return { apiKey, error: null };
  } catch (err) {
    if (err instanceof AuthError)
      return { apiKey: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    throw err;
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { apiKey, error } = await getApiKey();
  if (error) return error;

  const { id } = await params;
  const body = await req.json();
  const res = await fetch(`${API_URL}/entities/${id}`, {
    method: "PATCH",
    headers: { "x-brain-key": apiKey!, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json({ error: `API ${res.status}: ${text || res.statusText}` }, { status: res.status });
  }
  return NextResponse.json(await res.json());
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { apiKey, error } = await getApiKey();
  if (error) return error;

  const { id } = await params;
  const res = await fetch(`${API_URL}/entities/${id}`, {
    method: "DELETE",
    headers: { "x-brain-key": apiKey! },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json({ error: `API ${res.status}: ${text || res.statusText}` }, { status: res.status });
  }
  return NextResponse.json(await res.json());
}
