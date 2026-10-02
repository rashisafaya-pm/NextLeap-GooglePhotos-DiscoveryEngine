"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";

// Gemini answers come back as light markdown (**bold**, "* " or "1. "
// lists, blank-line paragraphs). The chat bubble used to dump that text in
// raw -- literal asterisks and all -- so this renders the handful of
// markdown shapes that actually show up into real paragraphs/lists/bold
// text, without pulling in a markdown library.
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const boldRe = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = boldRe.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    parts.push(<strong key={`${keyPrefix}-b${i++}`}>{match[1]}</strong>);
    lastIndex = boldRe.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function renderAnswer(text: string): ReactNode {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let listBuffer: { type: "ul" | "ol"; items: string[] } | null = null;
  let paraBuffer: string[] = [];
  let blockKey = 0;

  function flushPara() {
    const joined = paraBuffer.join(" ").trim();
    paraBuffer = [];
    if (joined) {
      const key = `p${blockKey++}`;
      blocks.push(<p key={key}>{renderInline(joined, key)}</p>);
    }
  }
  function flushList() {
    if (!listBuffer) return;
    const { type, items } = listBuffer;
    listBuffer = null;
    const key = `l${blockKey++}`;
    const ListTag = type;
    blocks.push(
      <ListTag key={key}>
        {items.map((item, idx) => (
          <li key={`${key}-${idx}`}>{renderInline(item, `${key}-${idx}`)}</li>
        ))}
      </ListTag>
    );
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const bullet = /^[*-]\s+(.*)/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)/.exec(line);

    if (line === "") {
      flushPara();
      flushList();
    } else if (bullet) {
      flushPara();
      if (!listBuffer || listBuffer.type !== "ul") {
        flushList();
        listBuffer = { type: "ul", items: [] };
      }
      listBuffer.items.push(bullet[1]);
    } else if (numbered) {
      flushPara();
      if (!listBuffer || listBuffer.type !== "ol") {
        flushList();
        listBuffer = { type: "ol", items: [] };
      }
      listBuffer.items.push(numbered[1]);
    } else {
      flushList();
      paraBuffer.push(line);
    }
  }
  flushPara();
  flushList();

  return <>{blocks}</>;
}

type Source = {
  thread_key: string;
  source: string;
  cluster: string;
  quote: string;
  score: number;
};

type AnsweredBy = "data" | "evidence" | "none";

type Message = {
  role: "user" | "assistant";
  text: string;
  sources?: Source[];
  isError?: boolean;
  answeredBy?: AnsweredBy;
};

// Shown next to each assistant reply so it's clear at a glance whether
// the number came from the full coded dataset (exact, deterministic) or
// from the AI reading a handful of retrieved quotes (still grounded, but
// a synthesis rather than a count). Raised directly from an earlier
// concern about trusting the chatbot's answers -- this makes the
// distinction visible instead of asking for blind trust either way.
function AnsweredByBadge({ answeredBy }: { answeredBy?: AnsweredBy }) {
  if (!answeredBy || answeredBy === "none") return null;
  const isData = answeredBy === "data";
  return (
    <span className={`answered-by-badge ${isData ? "data" : "evidence"}`}>
      {isData ? "From full dataset" : "AI-assisted"}
    </span>
  );
}

// Each chip is built to demonstrate IDENTIFYING or COMPARING retrieval
// problems and opportunity areas with real evidence -- the actual point
// of this tool -- rather than just exercising a different code path for
// its own sake. No two give the same answer, and each is verified against
// the real dataset:
//   - identify + rank every problem area by frequency/severity
//   - identify the single biggest opportunity (the "no search cue at all"
//     gap, which is bigger than any single named bug)
//   - a direct head-to-head comparison between two named problem areas,
//     with real counts, rank, and severity on each side
//   - drill into one specific problem area with its own evidence
//   - an open-ended question with no exact template match, so it's
//     answered by actually retrieving evidence and synthesizing across it
const SUGGESTED_QUESTIONS = [
  "What are the top-ranked search and retrieval problems, by frequency and severity?",
  "What's the biggest opportunity -- people who can't remember any specific detail to search with?",
  "How does the face search problem compare to date-based browsing?",
  "Tell me about album search, with real evidence",
  "What happens to someone's photos when they switch to a new phone?",
];

const THEME_KEY = "retrieval-atlas-theme";

function currentTheme(): "light" | "dark" {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  function handleClick() {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private browsing or storage disabled -- the toggle still works for
      // this page load, it just won't be remembered next time.
    }
    setTheme(next);
  }

  // The icon shows what clicking it WILL DO, not the current state: on the
  // light theme it shows a moon (click to go dark), and once dark it shows
  // a sun (click to go back to light) -- so the icon always reads as the
  // destination, never the here-and-now.
  return (
    <button
      className="theme-icon-btn"
      type="button"
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      onClick={handleClick}
    >
      {theme === "dark" ? "\u{2600}\u{FE0F}" : "\u{1F319}"}
    </button>
  );
}

const GREETING: Message = {
  role: "assistant",
  text:
    "Ask me about Google Photos search/retrieval problems -- e.g. \"what goes wrong with face search?\" or \"what are the top-ranked issues?\". I'll answer only from the research evidence, with citations.",
};

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([GREETING]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendQuestion(question: string) {
    if (!question || loading) return;

    setMessages((m) => [...m, { role: "user", text: question }]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();

      if (!res.ok) {
        setMessages((m) => [
          ...m,
          { role: "assistant", text: data.error ?? "Something went wrong.", isError: true },
        ]);
      } else {
        setMessages((m) => [
          ...m,
          { role: "assistant", text: data.answer, sources: data.sources, answeredBy: data.answeredBy },
        ]);
      }
    } catch {
      setMessages((m) => [
        ...m,
        { role: "assistant", text: "Network error -- please try again.", isError: true },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleStartOver() {
    setMessages([GREETING]);
    setInput("");
  }

  function handleSend(e: React.FormEvent) {
    e.preventDefault();
    void sendQuestion(input.trim());
  }

  return (
    <div className="page-shell">
      <header className="site-header-bar">
        <div className="site-header-inner">
          <div className="header-left">
            <span className="brand">GooglePhotos</span>
            <nav className="site-nav" aria-label="Main">
              <a className="nav-link" href="/">
                Insights
              </a>
              <a className="nav-link" href="/what-people-say">
                What People Say
              </a>
              <a className="nav-link active" href="/ask">
                Ask
              </a>
            </nav>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="app-shell">
        <div className="chat-body">
          {/* Suggested questions stay visible on the left for the whole
              conversation, not just before the first message -- they're
              meant to be revisited (try a comparison, then a different
              cluster) rather than a one-time onboarding hint that vanishes. */}
          <aside className="suggestions-rail" aria-label="Suggested questions">
            <div className="suggestions-rail-title">Try asking</div>
            {SUGGESTED_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                className="suggestion-chip"
                onClick={() => void sendQuestion(q)}
                disabled={loading}
              >
                {q}
              </button>
            ))}
          </aside>

          <div className="chat-shell">
            <div className="chat-shell-header">
              <button
                type="button"
                className="start-over-btn"
                onClick={handleStartOver}
                disabled={loading || messages.length <= 1}
              >
                Start over
              </button>
            </div>
            <div className="chat-log">
              {messages.map((m, i) => (
                <div key={i} className={`msg ${m.role}`}>
                  <div className="who">
                    {m.role === "user" ? "You" : "Insights Bot"}
                    {m.role === "assistant" && !m.isError && <AnsweredByBadge answeredBy={m.answeredBy} />}
                  </div>
                  <div className={`bubble ${m.isError ? "error" : ""}`}>
                    {m.role === "assistant" && !m.isError ? renderAnswer(m.text) : m.text}
                  </div>
                  {m.sources && m.sources.length > 0 && (
                    <details className="sources">
                      <summary>
                        {m.sources.length} source{m.sources.length > 1 ? "s" : ""}
                      </summary>
                      <ul>
                        {m.sources.map((s) => (
                          <li key={s.thread_key}>
                            <strong>{s.cluster}</strong> ({s.source},{" "}
                            <span className="key">thread: {s.thread_key}</span>) &mdash; &ldquo;{s.quote}&rdquo;
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              ))}
              {loading && <div className="thinking">Thinking...</div>}
              <div ref={bottomRef} />
            </div>

            <form className="chat-input-row" onSubmit={handleSend}>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about a search/retrieval problem..."
              />
              <button className="send-btn" type="submit" disabled={loading || !input.trim()}>
                Send
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
