import { NextRequest, NextResponse } from "next/server";
import { search } from "@/lib/retrieval";
import { askGemini } from "@/lib/llm";
import { getClusterById } from "@/lib/data";
import { tryTemplate } from "@/lib/templates";
import { getCached, setCached } from "@/lib/cache";
import { buildFallbackAnswer } from "@/lib/fallback";

// This is the one route that costs money (Gemini free tier, but still rate
// limited) -- so it's deliberately retrieval-grounded: we never let the model
// answer from its own general knowledge about Google Photos. We always hand
// it a fixed set of real evidence quotes pulled by BM25 search, tell it to
// answer ONLY from those quotes, and require it to say so plainly when the
// evidence doesn't cover the question.
//
// Gemini is the LAST resort, not the first move. Every question is checked,
// in order, against: (1) a template that can answer deterministically from
// the data itself (stats, top-ranked problems, "tell me about X cluster"),
// then (2) a cache of answers already generated for a similar question.
// Only if neither matches does this spend an actual Gemini call. That keeps
// the common questions instant and free, and saves the rate limit and the
// quota for genuinely open-ended ones.
//
// There's no login here -- anyone with the link can ask questions -- so the
// only thing standing between the Gemini path and an open tap on your free
// quota is the simple per-IP rate limit below. It resets whenever the
// serverless function cold-starts, so it's a soft limit, not a hard
// guarantee; good enough to stop a runaway script or a bored visitor, not a
// determined abuser.

export const dynamic = "force-dynamic";

type ChatRequestBody = { question?: string };

const TOP_K = 6;

// --- lightweight per-IP rate limit (resets on cold start, no DB needed) ---
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const requestLog = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    requestLog.set(ip, timestamps);
    return true;
  }
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return false;
}

function buildPrompt(question: string, results: ReturnType<typeof search>) {
  const evidenceBlocks = results
    .map((r, i) => {
      const cluster = getClusterById(r.episode.cl);
      return [
        `[${i + 1}] thread_key: ${r.episode.k}`,
        `source: ${r.episode.src}${r.episode.date ? ` | date: ${r.episode.date}` : ""}`,
        `cluster: ${cluster?.label ?? r.episode.cl}`,
        `failure_mode: ${r.episode.fm} | trigger: ${r.episode.trig} | severity: ${r.episode.sev}`,
        `evidence_quote: "${r.episode.q}"`,
      ].join("\n");
    })
    .join("\n\n");

  return `You are answering questions about a research study of Google Photos search/retrieval problems, grounded strictly in the evidence excerpts below. Each excerpt is a real user report, tagged with a thread_key you can cite.

RULES:
- Answer ONLY using the evidence excerpts below. Do not use outside knowledge about Google Photos.
- Every claim you make must be traceable to at least one excerpt. Cite excerpts inline like (thread: abc123).
- If the excerpts don't contain enough information to answer the question, say plainly: "I don't have evidence for that in this dataset." Do not guess or fill in with general knowledge.
- Be concise. Write for a product manager skimming for signal, not a literature review.

EVIDENCE EXCERPTS:
${evidenceBlocks || "(no matching excerpts found)"}

QUESTION: ${question}`;
}

export async function POST(req: NextRequest) {
  let body: ChatRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const question = (body.question ?? "").trim();
  if (!question) {
    return NextResponse.json({ error: "Missing 'question' in request body." }, { status: 400 });
  }
  if (question.length > 1000) {
    return NextResponse.json({ error: "Question is too long (max 1000 characters)." }, { status: 400 });
  }

  // 1. Deterministic template -- free, instant, no Gemini involved. Tagged
  // "data" because it's computed directly from every coded episode, not
  // from a handful of retrieved quotes -- that distinction is surfaced in
  // the UI so it's clear which answers are exact aggregates and which are
  // a model's read of a few examples.
  const templateResult = tryTemplate(question);
  if (templateResult) {
    return NextResponse.json({ ...templateResult, answeredBy: "data" });
  }

  // 2. Cache of a previously-generated Gemini answer for a similar question.
  const cached = getCached(question);
  if (cached) {
    return NextResponse.json(cached);
  }

  // 3. Only now does this touch the rate limit and the Gemini API.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many questions in a short time -- please wait a minute and try again." },
      { status: 429 }
    );
  }

  const results = search(question, TOP_K);

  const sources = results.map((r) => {
    const cluster = getClusterById(r.episode.cl);
    return {
      thread_key: r.episode.k,
      source: r.episode.src,
      cluster: cluster?.label ?? r.episode.cl,
      quote: r.episode.q,
      score: Math.round(r.score * 100) / 100,
    };
  });

  if (results.length === 0) {
    return NextResponse.json({
      answer:
        "I don't have evidence for that in this dataset. Try rephrasing, or ask about a specific search/retrieval behavior (e.g. \"face search\", \"date filters\", \"duplicate photos\").",
      sources: [],
      answeredBy: "none",
    });
  }

  try {
    const prompt = buildPrompt(question, results);
    const answer = await askGemini(prompt);
    const payload = { answer, sources, answeredBy: "evidence" as const };
    setCached(question, payload);
    return NextResponse.json(payload);
  } catch (err) {
    // Gemini is a prose layer on top of evidence that search already
    // found -- losing it shouldn't mean losing the answer. Fall back to
    // the real, coded evidence directly instead of surfacing an error.
    // Not cached: once Gemini is reachable again, the next ask for this
    // question should get the real synthesized answer, not this frozen
    // in place.
    console.error("Gemini call failed, falling back to raw evidence:", err);
    return NextResponse.json(buildFallbackAnswer(results));
  }
}
