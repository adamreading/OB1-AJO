import { 
  DEFAULT_TYPE, 
  ALLOWED_TYPES, 
  DEFAULT_IMPORTANCE, 
  DEFAULT_QUALITY_SCORE, 
  DEFAULT_CONFIDENCE,
  MAX_SUMMARY_LENGTH,
  SENSITIVITY_PATTERNS
} from "./config.ts";

// Helper to compute a SHA-256 fingerprint for dedup
export async function computeContentFingerprint(content: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(content.trim().toLowerCase());
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Simple sensitivity detection
export function detectSensitivity(content: string) {
  const reasons: string[] = [];
  let tier = "standard";

  for (const p of SENSITIVITY_PATTERNS) {
    if (p.pattern.test(content)) {
      reasons.push(p.reason);
      if (p.tier === "restricted") tier = "restricted";
      else if (p.tier === "personal" && tier === "standard") tier = "personal";
    }
  }

  return { tier, reasons };
}

export function asString(v: any, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

export function asNumber(v: any, fallback: number, min?: number, max?: number): number {
  const n = typeof v === "number" ? v : parseFloat(v);
  if (isNaN(n)) return fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

export function asInteger(v: any, fallback: number, min?: number, max?: number): number {
  return Math.round(asNumber(v, fallback, min, max));
}

// Main payload preparation logic
export async function prepareThoughtPayload(content: string, opts?: any) {
  const { tier, reasons } = detectSensitivity(content);
  const fingerprint = await computeContentFingerprint(content);
  
  const type = asString(opts?.metadata?.type, DEFAULT_TYPE);
  const importance = asInteger(opts?.metadata?.importance, DEFAULT_IMPORTANCE, 1, 5);
  
  return {
    content: content.trim(),
    type,
    importance,
    sensitivity_tier: tier,
    content_fingerprint: fingerprint,
    metadata: {
      ...opts?.metadata,
      sensitivity_reasons: reasons,
      source: opts?.source || "mcp"
    }
  };
}
