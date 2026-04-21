/**
 * One-off Reclassification Script
 * Safely adds 'Work/Personal' tags to existing thoughts without overwriting manual edits.
 */
const { createClient } = require('@supabase/supabase-js');

// Configuration (Loaded from .env via --env-file flag)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OLLAMA_URL = `${process.env.OLLAMA_URL}/generate`;
const MODEL = process.env.OLLAMA_MODEL || "Qwen3:30b";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function run() {
  console.log("🔍 Scanning for thoughts missing context classification...");

  // 1. Fetch thoughts
  const { data: thoughts, error: fetchError } = await supabase
    .from('thoughts')
    .select('id, content, metadata');

  if (fetchError) {
    console.error("❌ Error fetching thoughts:", fetchError.message);
    return;
  }

  // 2. Force all thoughts to be reprocessed for the 'refinement' run
  const pending = thoughts; 
  console.log(`📊 Found ${thoughts.length} total thoughts to refine.`);

  if (pending.length === 0) {
    console.log("✅ Everything is already classified. Nothing to do!");
    return;
  }

  for (const t of pending) {
    console.log(`\n🧠 Analyzing: "${t.content.substring(0, 50)}..."`);
    
    try {
      const workDesc = process.env.WORK_CONTEXT_DESC || "Professional and work tasks";
      const personalDesc = process.env.PERSONAL_CONTEXT_DESC || "Personal life and side projects";

      const systemPrompt = `You are a professional life/work classifier. Return ONLY a JSON object. 
IMPORTANT: 
WORK = ${workDesc}. 
PERSONAL = ${personalDesc}.`;

      const userPrompt = `Is this thought related to ${workDesc} (Work) or ${personalDesc} (Personal)?
Thought: "${t.content}"
JSON Format: {"context": "work"} or {"context": "personal"}`;

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
      
      const jsonMatch = rawText.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) throw new Error("No JSON in response");
      const analysis = JSON.parse(jsonMatch[0]);
      const context = (analysis.context || 'personal').toLowerCase();

      console.log(`✅ Result: ${context}`);

      // 3. Selective Update (only metadata)
      const currentMetadata = t.metadata || {};
      const newMetadata = {
        ...currentMetadata,
        classification: context
      };

      const { error: updateError } = await supabase
        .from('thoughts')
        .update({ metadata: newMetadata })
        .eq('id', t.id);

      if (updateError) throw updateError;

    } catch (err) {
      console.error(`❌ Failed item ${t.id}:`, err.message);
    }
    
    // Tiny delay to be nice to Ollama
    await new Promise(r => setTimeout(r, 500));
  }

  console.log("\n✨ Reclassification complete! Check your Dashboard.");
}

run().catch(console.error);
