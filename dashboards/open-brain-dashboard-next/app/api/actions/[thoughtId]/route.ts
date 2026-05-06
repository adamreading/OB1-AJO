import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

async function restGet(apiKey: string, path: string) {
  const res = await fetch(`${API_URL}${path}`, { headers: { "x-brain-key": apiKey } });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function restPut(apiKey: string, path: string, body: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "PUT",
    headers: { "x-brain-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PUT ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

async function restPost(apiKey: string, path: string, body: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "x-brain-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

// PATCH /api/actions/[thoughtId]
// Body: { action: "done" | "promote", item_index: number }
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ thoughtId: string }> }
) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }

  const { thoughtId } = await params;
  const body = await request.json();
  const { action, item_index } = body as { action: "done" | "promote"; item_index: number };

  if (!["done", "promote"].includes(action) || typeof item_index !== "number") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    // Fetch current thought
    const thought = await restGet(apiKey, `/thought/${thoughtId}`);
    const currentItems: string[] = thought.metadata?.action_items ?? [];

    if (item_index < 0 || item_index >= currentItems.length) {
      return NextResponse.json({ error: "Item index out of range" }, { status: 400 });
    }

    const itemText = currentItems[item_index];
    const updatedItems = currentItems.filter((_: string, i: number) => i !== item_index);

    let promotedId: number | null = null;

    if (action === "promote") {
      // Create a new task thought from the action item text
      const captured = await restPost(apiKey, "/capture", { content: itemText });
      // Promote to task on backlog
      const classification = thought.metadata?.classification ?? "work";
      await restPut(apiKey, `/thought/${captured.thought_id}`, {
        type: "task",
        status: "backlog",
        importance: thought.importance ?? 3,
        metadata: { classification },
      });
      promotedId = captured.thought_id;
    }

    // Remove item from source thought's action_items
    await restPut(apiKey, `/thought/${thoughtId}`, {
      metadata: { action_items: updatedItems },
    });

    return NextResponse.json({
      action,
      removed_item: itemText,
      promoted_id: promotedId,
      remaining: updatedItems.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}
