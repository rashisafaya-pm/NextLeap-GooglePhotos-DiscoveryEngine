import { getAllEpisodes, getClusterById, type Episode } from "@/lib/data";
import { expandQueryTerms } from "@/lib/synonyms";

// A from-scratch BM25 search over the 365 episodes. No vector DB, no embedding
// API call, no external cost: at this corpus size (a few hundred short
// documents) a classic term-frequency ranking function finds the relevant
// evidence just as well as an embedding search would, and it runs in a few
// milliseconds in the same serverless function that calls the LLM -- so the
// only per-question cost is the one LLM call for the final answer.

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "do",
  "does", "did", "have", "has", "had", "i", "you", "he", "she", "it", "we",
  "they", "my", "your", "its", "our", "their", "this", "that", "these",
  "those", "to", "of", "in", "on", "for", "with", "about", "as", "by", "at",
  "from", "and", "or", "but", "if", "so", "than", "then", "what", "why",
  "how", "when", "where", "who", "which", "can", "could", "would", "should",
  "will", "not", "no", "yes", "me", "us", "them", "google", "photos",
]);

// A deliberately light suffix-stripping stemmer -- not a real linguistic
// stemmer (e.g. Porter), just enough to collapse the plural/verb-form
// mismatches that come up constantly in real questions ("searches" vs
// "search", "formulating" vs "formulate"-ish). Applied identically when
// indexing episodes and when tokenizing a question, so both sides land on
// the same stemmed form.
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

function searchableText(e: Episode): string {
  const cluster = getClusterById(e.cl);
  return [e.post, e.code, e.cue, e.fm, e.trig, cluster?.label ?? ""]
    .join(" ")
    .toLowerCase();
}

type Indexed = {
  episode: Episode;
  terms: string[];
  termCounts: Map<string, number>;
  length: number;
};

let index: Indexed[] | null = null;
let docFreq: Map<string, number> | null = null;
let avgLength = 0;

function buildIndex() {
  if (index) return;
  const episodes = getAllEpisodes();
  index = episodes.map((episode) => {
    const terms = tokenize(searchableText(episode));
    const termCounts = new Map<string, number>();
    for (const t of terms) termCounts.set(t, (termCounts.get(t) ?? 0) + 1);
    return { episode, terms, termCounts, length: terms.length };
  });
  docFreq = new Map();
  for (const doc of index) {
    for (const term of new Set(doc.terms)) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }
  avgLength = index.reduce((sum, d) => sum + d.length, 0) / index.length;
}

const K1 = 1.5;
const B = 0.75;

export type SearchResult = { episode: Episode; score: number };

export function search(query: string, topK = 8): SearchResult[] {
  buildIndex();
  if (!index || !docFreq) return [];
  const N = index.length;
  const rawTerms = tokenize(query);
  if (rawTerms.length === 0) return [];

  // Widen the literal query with grounded concept synonyms (see
  // lib/synonyms.ts) -- e.g. "memory"/"incomplete" also pulls in "vague"/
  // "none"/"cant"/"find", which is how the dataset's own "none_vague"
  // cue_type episodes actually read. Expanded terms get a lower weight so
  // a literal word match still outranks a synonym-only one.
  const weightedTerms = expandQueryTerms(rawTerms);

  const scores = index.map((doc) => {
    let score = 0;
    for (const [term, weight] of weightedTerms) {
      const df = docFreq!.get(term) ?? 0;
      if (df === 0) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const tf = doc.termCounts.get(term) ?? 0;
      if (tf === 0) continue;
      const denom = tf + K1 * (1 - B + (B * doc.length) / avgLength);
      score += weight * idf * ((tf * (K1 + 1)) / denom);
    }
    return { episode: doc.episode, score };
  });

  return scores
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
