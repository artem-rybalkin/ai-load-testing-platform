// ── AI output parsing/validation helpers ───────────────────────────────────
//
// LLM (Gemini/OpenAI/Anthropic) responses are free text expected to contain a
// JSON block, but the model doesn't always honor the prompt's exact shape —
// fields can be missing, mistyped, or numbers can arrive as unit-suffixed
// strings (e.g. "1000ms"). These helpers centralize the "extract JSON, then
// validate/coerce before trusting it" pattern so every AI-backed endpoint can
// reject malformed output instead of forwarding it to the UI unchecked.

/** Extracts and parses a {...} or [...] JSON block from raw LLM text. Returns null on no match or parse failure — never throws. */
export function extractAndParseAIJson(text: string, kind: 'object' | 'array' = 'object'): unknown | null {
  const re = kind === 'array' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const match = text.match(re);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

/** Coerces a value that may have arrived as a unit-suffixed string (e.g. "1000ms") into a plain
 * number — confirmed live against a real Gemini call that the model doesn't always honor a
 * prompt's "return a plain number" instruction. Returns null if it can't be coerced. */
export function coerceNumericValue(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
