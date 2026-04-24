/**
 * Open Brain Local Extraction Worker (Ollama HTTP + Format JSON Edition)
 * Uses HTTP API since Ollama is updated to >= 0.21.
 */
const { createClient } = require('@supabase/supabase-js');

// Configuration (Loaded from .env via --env-file flag)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OLLAMA_URL = `${process.env.OLLAMA_URL}/generate`;
const MODEL = process.env.OLLAMA_MODEL || "Qwen3:30b";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function resetFailedItems() {
  console.log("♻️ Resetting failed queue items to pending...");
  const { error } = await supabase
    .from('entity_extraction_queue')
    .update({ status: 'pending', last_error: null })
    .eq('status', 'failed');
  if (error) console.error("❌ Reset error:", error.message);
}

async function processQueue() {
  await resetFailedItems();
  console.log(`🚀 Starting Local Extraction Worker using ${MODEL} (HTTP mode)...`);

  while (true) {
    // 1. Get next pending item
    const { data: queueItem, error: queueError } = await supabase
      .from('entity_extraction_queue')
      .select('thought_id, thoughts(content, status, classification, metadata)')
      .eq('status', 'pending')
      .limit(1)
      .maybeSingle();

    if (queueError) {
      console.error("❌ Queue error:", queueError.message);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    if (!queueItem) {
      console.log("😴 Queue empty. Waiting 10s...");
      await new Promise(r => setTimeout(r, 10000));
      continue;
    }

    const { thought_id, thoughts } = queueItem;
    const content = thoughts?.content;

    if (!content) {
      await supabase.from('entity_extraction_queue').update({ status: 'failed', last_error: 'No content' }).eq('thought_id', thought_id);
      continue;
    }

    // Logic: If there is ALREADY a classification in metadata, it means a human or AI already processed it.
    // If it was re-queued (due to trigger), we skip it to prevent overwriting manual moves.
    const hasMetadataClass = thoughts?.metadata?.classification;

    if (hasMetadataClass) {
      console.log(`⏭️ Skipping ${thought_id.substring(0,8)}: Found existing classification in metadata.`);
      await supabase.from('entity_extraction_queue').update({ status: 'done' }).eq('thought_id', thought_id);
      continue;
    }

    console.log(`\n🧠 Processing thought ${thought_id.substring(0, 8)}...`);
    
    try {
      // 2. Call Ollama for classification
      const workDesc = process.env.WORK_CONTEXT_DESC || "Professional and work tasks";
      const personalDesc = process.env.PERSONAL_CONTEXT_DESC || "Personal life and side projects";

      const systemPrompt = `You are a professional life/work classifier. Return ONLY a JSON object. 
IMPORTANT: 
WORK = ${workDesc}. 
PERSONAL = ${personalDesc}.`;

      const userPrompt = `Classify this thought.
Types: idea, task, meeting, reference, journal, decision, lesson
Context: work (${workDesc}), personal (${personalDesc})

CONTENT:
"${content}"

JSON Format: {"type": "task", "context": "work", "importance": 80, "summary": "brief summary"}
OUTPUT THE JSON:`;

      const res = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          prompt: `${systemPrompt}\n\n${userPrompt}`,
          stream: false
        })
      });

      if (!res.ok) throw new Error(`Ollama error: ${res.statusText}`);
      
      const result = await res.json();
      const rawText = result.response;
      console.log(`🤔 Raw Response: ${rawText.substring(0, 100)}...`);

      let analysis;
      try {
        const jsonMatch = rawText.match(/\{[\s\S]*?\}/);
        if (!jsonMatch) throw new Error("No JSON found in response");
        analysis = JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        throw new Error(`Parse error: ${parseError.message} | Raw: ${rawText}`);
      }

      console.log(`✅ Result: Type=${analysis.type}, Context=${analysis.context}, Importance=${analysis.importance}`);

      // 3. Update Thought
      const updates = {
        type: (analysis.type || 'idea').toLowerCase(),
        importance: parseInt(analysis.importance) || 50,
        status: thoughts?.status || ((analysis.type === 'task' || analysis.type === 'idea') ? 'new' : null),
        updated_at: new Date().toISOString(),
        metadata: {
          classification: (analysis.context || 'personal').toLowerCase(),
          ai_summary: analysis.summary
        }
      };

      const { error: updateError } = await supabase
        .from('thoughts')
        .update(updates)
        .eq('id', thought_id);

      if (updateError) throw updateError;

      // 4. Mark as done
      await supabase
        .from('entity_extraction_queue')
        .update({ status: 'done', source_updated_at: new Date().toISOString() })
        .eq('thought_id', thought_id);

      console.log(`✨ Success.`);

    } catch (err) {
      console.error(`❌ Failed:`, err.message);
      await supabase
        .from('entity_extraction_queue')
        .update({ status: 'failed', last_error: err.message })
        .eq('thought_id', thought_id);
    }
  }
}

processQueue().catch(console.error);
