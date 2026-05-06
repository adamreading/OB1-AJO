import { NextRequest, NextResponse } from "next/server";
import { updateThought } from "@/lib/api";
import { requireSession, AuthError } from "@/lib/auth";

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
    const { id, content, type, classification } = (await request.json()) as {
      id: number;
      content?: string;
      type?: string;
      classification?: string;
    };
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const updates: Parameters<typeof updateThought>[2] = {};
    if (content !== undefined) updates.content = content;
    if (type !== undefined) updates.type = type;
    if (classification !== undefined) {
      updates.metadata = { classification };
    }

    const result = await updateThought(apiKey, id, updates);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Update failed" },
      { status: 500 }
    );
  }
}
