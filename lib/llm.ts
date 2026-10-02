// Plain fetch() to Google's Gemini free-tier API -- deliberately no SDK
// dependency, so there's one less package to install and one less thing to
// go out of date. Model name is an env var (GEMINI_MODEL) in case Google
// renames or retires the default free-tier model after this was written;
// check https://ai.google.dev/gemini-api/docs/models for the current free
// model name if this starts failing with a 404.

// New Gemini API keys get funneled to a narrow, constantly-shifting set of
// models -- gemini-2.0-flash, gemini-2.5-flash, and gemini-2.5-flash-lite
// were all tried here and each came back "no longer available to new
// users," and gemini-3.8-flash (the first redirect target) turned out to
// carry only a 20-request/DAY quota. gemini-3.5-flash-lite is what
// Google's own 404 on gemini-2.5-flash-lite named as the live replacement,
// so it's the current best bet for a new account. If this one also stops
// working, check https://ai.google.dev/gemini-api/docs/models for whatever
// the lite variant of the newest generation is now, and set GEMINI_MODEL
// in .env.local rather than editing this file.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

// Gemini's free tier returns a 503 ("high demand") or 429 (rate limited)
// fairly often -- these are transient, not a real failure, so they're
// worth a couple of quick retries before giving up. A 400/401/404 won't
// fix itself on retry, so those fail immediately.
const MAX_RETRIES = 2; // up to 3 attempts total
const RETRY_DELAYS_MS = [500, 1500];

function isRetryableStatus(status: number): boolean {
  return status === 503 || status === 429 || status === 500 || status === 502 || status === 504;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function askGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey " +
        "and add it to your environment variables."
    );
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  let lastStatus: number | null = null;
  let lastBody = "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
      }),
    });

    if (res.ok) {
      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        // Not a network/API failure -- Gemini responded, but with no text
        // (usually a safety block). Still a plain-language message, not
        // raw JSON, in the chat bubble.
        throw new Error(
          "Gemini didn't return an answer for that question (it may have been blocked). Try rephrasing it."
        );
      }
      return text;
    }

    lastStatus = res.status;
    lastBody = await res.text().catch(() => "");

    if (!isRetryableStatus(res.status) || attempt === MAX_RETRIES) break;
    await sleep(RETRY_DELAYS_MS[attempt] ?? 1500);
  }

  // Every attempt failed. Log the real status/body server-side for
  // debugging, but never show raw API error JSON to the end user -- it
  // reads as broken and gives away nothing they can act on.
  console.error(`Gemini API error ${lastStatus}: ${lastBody.slice(0, 500)}`);

  if (lastStatus === 503 || lastStatus === 429) {
    throw new Error(
      "Gemini is temporarily overloaded. This usually clears up within a few seconds -- please try asking again."
    );
  }
  throw new Error(
    "Something went wrong getting an answer just now. Please try again in a moment."
  );
}
