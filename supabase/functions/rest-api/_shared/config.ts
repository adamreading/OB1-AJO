/**
 * Shared configuration for OB1 Wave 2.5 core.
 * Used by both REST API and Enhanced MCP Server.
 */

export const DEFAULT_TYPE = "idea";
export const DEFAULT_IMPORTANCE = 3;
export const DEFAULT_QUALITY_SCORE = 50;
export const DEFAULT_CONFIDENCE = 0.5;
export const MAX_SUMMARY_LENGTH = 1000;

export const ALLOWED_TYPES = new Set([
  "idea",
  "task",
  "person_note",
  "reference",
  "decision",
  "lesson",
  "meeting",
  "journal",
  "project",
  "insight",
]);

export const SENSITIVITY_PATTERNS = [
  { pattern: /\b(password|secret|key|token)\b/i, tier: "restricted", reason: "credential_keyword" },
  { pattern: /\b(ssn|passport|license|credit card)\b/i, tier: "restricted", reason: "pii_keyword" },
  { pattern: /\b(private|confidential|internal only)\b/i, tier: "personal", reason: "privacy_marker" },
  { pattern: /\b(doctor|medical|health|diagnosis)\b/i, tier: "personal", reason: "medical_keyword" },
];
