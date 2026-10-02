// Same question comes up repeatedly across different visitors since the
// evidence base is static -- caching the full answer (not just the search
// results) means the second person to ask something close to an earlier
// question gets an instant, free reply instead of another Gemini call.
//
// This lives in the serverless function's memory, so it resets on cold
// start and isn't shared across function instances -- a soft win, not a
// guarantee, but free and simple, and it costs nothing when it misses.

export type CachedAnswer = {
  answer: string;
  sources: { thread_key: string; source: string; cluster: string; quote: string; score: number }[];
  // Everything that reaches the cache came from the Gemini path (templates
  // answer before the cache is ever checked, see route.ts), so this is
  // always "evidence" today -- kept explicit rather than assumed, so the
  // cached reply carries the same trust label the live Gemini answer would
  // have, instead of silently dropping it.
  answeredBy: "evidence";
};

const MAX_ENTRIES = 200;
const TTL_MS = 60 * 60 * 1000; // 1 hour

type Entry = CachedAnswer & { ts: number };

const store = new Map<string, Entry>();

// Normalize so "What are the top issues?" and "what are the top issues"
// hit the same cache entry.
export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
}

export function getCached(question: string): CachedAnswer | null {
  const key = normalizeQuestion(question);
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    store.delete(key);
    return null;
  }
  return { answer: entry.answer, sources: entry.sources, answeredBy: entry.answeredBy };
}

export function setCached(question: string, value: CachedAnswer): void {
  const key = normalizeQuestion(question);
  if (store.size >= MAX_ENTRIES && !store.has(key)) {
    // Evict the oldest entry to keep this bounded.
    const oldestKey = store.keys().next().value;
    if (oldestKey !== undefined) store.delete(oldestKey);
  }
  store.set(key, { ...value, ts: Date.now() });
}
