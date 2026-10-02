import type { SearchResult } from "@/lib/retrieval";
import { getClusterById } from "@/lib/data";

export type AnswerResult = {
  answer: string;
  sources: { thread_key: string; source: string; cluster: string; quote: string; score: number }[];
  answeredBy: "evidence";
};

// Gemini is a convenience layer that writes prose over evidence BM25
// already found -- it is NOT what makes an answer true. So when Gemini is
// unreachable (free-tier quota, an outage, anything), the right behavior
// is not to apologize and hand back nothing: it's to show the real,
// coded evidence directly. That's the actual asset this project built --
// three days of triage and coding -- and it doesn't depend on a third
// -party API being up. This produces a direct, ungenerated answer
// straight from the same top-K search results Gemini would have been
// handed, so the chatbot still answers the question, just without
// AI-written connective sentences.
export function buildFallbackAnswer(results: SearchResult[]): AnswerResult {
  const top = results.slice(0, 5);

  const sources = top.map((r) => {
    const cluster = getClusterById(r.episode.cl);
    return {
      thread_key: r.episode.k,
      source: r.episode.src,
      cluster: cluster?.label ?? r.episode.cl,
      quote: r.episode.q,
      score: Math.round(r.score * 100) / 100,
    };
  });

  const lines = top.map((r) => {
    const cluster = getClusterById(r.episode.cl);
    return `* **${cluster?.label ?? r.episode.cl}** -- "${r.episode.q}" (thread: ${r.episode.k})`;
  });

  const answer =
    "The AI summarizer is temporarily unreachable, so here's the closest matching evidence " +
    "straight from the dataset instead of a written-up answer:\n\n" +
    lines.join("\n") +
    "\n\nThis evidence was found by the same search that normally feeds the AI -- it's just " +
    "not written into a summary right now. Try asking again shortly for a synthesized answer, " +
    "or open the sources below for the full citations.";

  return { answer, sources, answeredBy: "evidence" };
}
