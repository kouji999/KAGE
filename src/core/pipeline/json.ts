// Helper parse JSON dari output LLM — toleran fenced code block / prose padding.

/** Return null kalau benar-benar tidak bisa diparse. */
export function parseLlmJson<T>(raw: string): T | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/m, '')
    .trim();

  const direct = tryParse<T>(cleaned);
  if (direct !== null) return direct;

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return tryParse<T>(cleaned.slice(start, end + 1));
  }
  return null;
}

function tryParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
