import { NextRequest, NextResponse } from "next/server";
import { updateThought } from "@/lib/api";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

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

    // Pre-fetch the current thought so we can capture the LLM's original
    // type/classification as ground truth when the user corrects it in
    // /review. The first correction sticks as metadata.original_llm_type /
    // .original_llm_classification — subsequent edits don't overwrite it.
    // This is the training corpus for the future adaptive-capture loop.
    let originalLlmType: string | undefined;
    let originalLlmClassification: string | undefined;
    let existingMetadata: Record<string, unknown> = {};
    try {
      const res = await fetch(`${API_URL}/thought/${id}`, { headers: { "x-brain-key": apiKey } });
      if (res.ok) {
        const cur = await res.json();
        existingMetadata = (cur?.metadata as Record<string, unknown>) || {};
        const curType = cur?.type as string | undefined;
        const curClass = (existingMetadata.classification as string | undefined) || (cur?.classification as string | undefined);
        if (type !== undefined && type !== curType && !existingMetadata.original_llm_type) {
          originalLlmType = curType;
        }
        if (classification !== undefined && classification !== curClass && !existingMetadata.original_llm_classification) {
          originalLlmClassification = curClass;
        }
      }
    } catch {
      // If the pre-fetch fails, fall through — we just won't capture the correction
      // for this row. The update itself still proceeds.
    }

    const updates: Parameters<typeof updateThought>[2] = {};
    if (content !== undefined) updates.content = content;
    if (type !== undefined) updates.type = type;

    // Merge classification + correction provenance into metadata. PUT /thought
    // replaces metadata wholesale, so we re-pack existing fields to avoid
    // clobbering them.
    const nextMeta: Record<string, unknown> = { ...existingMetadata };
    if (classification !== undefined) nextMeta.classification = classification;
    if (originalLlmType !== undefined) {
      nextMeta.original_llm_type = originalLlmType;
      nextMeta.type_corrected_at = new Date().toISOString();
    }
    if (originalLlmClassification !== undefined) {
      nextMeta.original_llm_classification = originalLlmClassification;
      nextMeta.classification_corrected_at = new Date().toISOString();
    }
    if (Object.keys(nextMeta).length > 0 && (classification !== undefined || originalLlmType !== undefined || originalLlmClassification !== undefined)) {
      updates.metadata = nextMeta;
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
