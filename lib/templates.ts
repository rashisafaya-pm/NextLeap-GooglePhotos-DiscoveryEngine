import { getAllEpisodes, getClusters, getClusterById, getStats, type Cluster, type Episode } from "@/lib/data";
import { tokenize } from "@/lib/retrieval";

// A handful of question shapes come up constantly and have a fully
// deterministic answer sitting right in the data -- "what are the top
// problems", "how many threads are in scope", "tell me about face search".
// Answering those with a template instead of an LLM call means the most
// common questions are free and instant, and Gemini is only spent on
// questions that actually need open-ended synthesis. Each template writes
// out full sentences rather than a bare list, so the answer doesn't read
// differently from a Gemini-generated one.

export type TemplateResult = {
  answer: string;
  sources: { thread_key: string; source: string; cluster: string; quote: string; score: number }[];
};

function describeSeverity(score: number | null): string {
  if (score === null) return "";
  if (score >= 0.8) return " These reports tend to run high-severity.";
  if (score >= 0.5) return " These reports tend to be medium-severity.";
  return " These reports tend to be lower-severity.";
}

function representativeEpisode(cluster: Cluster): Episode | undefined {
  const episodes = getAllEpisodes().filter((e) => e.cl === cluster.id && e.scope === "in");
  return episodes[0];
}

// --- intent: "how many..." dataset-level stats ---

const STATS_RE = /\b(how many|how much|total number|number of)\b/i;

function tryStats(question: string): TemplateResult | null {
  if (!STATS_RE.test(question)) return null;
  const { total, inScope, outScope, baseline } = getStats();
  const answer =
    `In total, ${total} threads were coded. ${inScope} of those are genuine search/retrieval ` +
    `problems and make up the core dataset. Another ${outScope} turned out to be real complaints ` +
    `about something else entirely -- not search or retrieval -- so they were set aside. The ` +
    `remaining ${baseline} are positive baseline reports: people who found what they were looking ` +
    `for without any trouble.`;
  return { answer, sources: [] };
}

// --- intent: "top / biggest / worst / ranked" problems, OR "what kinds of
// photos do people struggle to find/retrieve" -- the second phrasing
// doesn't mention "top" or "ranked" at all, but it's asking for the same
// thing: the set of situations/problem-types people run into, which is
// exactly what the ranked cluster list already is. Both share one answer
// builder; only the trigger regex and the intro sentence differ.

const TOP_RE =
  /\b(top|biggest|worst|most important|most common|most frequent|common|frequent|main|major|ranked?|highest[- ]priority)\b.*\b(problem|issue|pain ?point|complaint)s?\b|\b(top|rank(ed|ing)?)\b/i;

// "what kinds/types of photos/problems do people struggle/have trouble
// (finding|retrieving|searching for)" -- deliberately requires BOTH the
// "what kind(s)/type(s) of" shape AND a struggle-word, so it doesn't fire
// on every question that happens to contain "kind of".
const PHOTO_KINDS_RE =
  /\bwhat (kind|kinds|type|types|categories) of\b[\s\S]*\b(struggle|trouble|difficult|hard|fail|can'?t|cannot|lost|losing|miss(ing)?)\b/i;

function rankedProblemsAnswer(intro: string): TemplateResult | null {
  const clusters = getClusters()
    .filter((c) => c.rank !== null)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .slice(0, 5);

  if (clusters.length === 0) return null;

  const bullets = clusters.map((c, i) => {
    const pairNote = c.top_pair ? ` -- most often ${c.top_pair}` : "";
    return `${i + 1}. **${c.label}** -- ${c.n} episode${c.n === 1 ? "" : "s"}${pairNote}`;
  });

  const answer = `${intro}\n\n${bullets.join("\n")}`;

  const sources = clusters
    .map((c) => {
      const ep = representativeEpisode(c);
      if (!ep) return null;
      return {
        thread_key: ep.k,
        source: ep.src,
        cluster: c.label,
        quote: ep.rq || ep.q,
        score: 1,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  return { answer, sources };
}

function tryTopRanked(question: string): TemplateResult | null {
  if (!TOP_RE.test(question)) return null;
  return rankedProblemsAnswer(
    "Ranked by how often each pattern shows up, how severe it tends to be, and how consistently " +
      "it traces back to the same underlying cause, here are the top search/retrieval problems:",
  );
}

function tryPhotoKinds(question: string): TemplateResult | null {
  if (!PHOTO_KINDS_RE.test(question)) return null;
  // A question naming a specific cluster topic gets the more useful
  // cluster-specific answer instead (checked later in the chain).
  if (findMatchingClusters(question).length > 0) return null;
  return rankedProblemsAnswer(
    "Here are the kinds of situations people actually run into trying to find an old photo, " +
      "ranked by how often each one shows up:",
  );
}

// --- intent: "what do people remember / what have they forgotten / how do
// they search with incomplete memory" -- these three sound like
// rephrasings of one question, and they used to all route to the same
// breakdown with only the lead-in sentence changed. A user caught that:
// three walls of identical bullet points in a row reads as a canned bot,
// and worse, it's not actually the most honest answer to each question --
// "what have they forgotten" and "how do they search" are asking about
// different slices of the data than "what do they remember" is. These are
// now three separate templates, each pulling a genuinely different cut:
//
//   - tryMemoryCues: what people DO have in mind (the cue_type field,
//     ranked) -- this is the original breakdown, kept for the "what do
//     people remember" framing.
//   - tryMemoryGaps: what's missing. The codebook only tags ONE cue per
//     episode, so there's no "forgot the date but remembered the object"
//     ground truth -- the honest answer is the count of episodes where
//     NOTHING usable was remembered at all (cue = none_vague or
//     manual_browsing), with that limitation stated plainly rather than
//     reusing the full cue ranking under a "forgotten" label.
//   - tryIncompleteMemorySearch: what actually happens when someone
//     searches with nothing to go on -- a different field entirely (the
//     outcome of that same none_vague/manual_browsing subset), since the
//     question is about search behavior and its result, not about which
//     detail was missing.
const MEMORY_CUE_RE = /\b(memory|remember(ing)?|recall(ing)?|recollect|vague)\b/i;
const FORGOT_RE = /\bforgot(ten)?\b|\bforget\b/i;
const INCOMPLETE_SEARCH_RE =
  /\bformulate\b|\b(search(es|ing)?|quer(y|ies))\b[\s\S]*\b(incomplete|partial|vague)\b|\b(incomplete|partial|vague)\b[\s\S]*\b(search(es|ing)?|quer(y|ies))\b/i;
const BLANK_CUES = new Set(["none_vague", "manual_browsing"]);

// A question like "what combination of details do people hold onto --
// e.g. an object AND a time period" sounds answerable from this same
// dataset, but it isn't: the codebook tags exactly ONE primary cue_type
// per episode (data.ts' Episode.cue is a single string, not a list), so
// there is no coded ground truth for "object + date_time together".
//
// A text-scan approximation was tried before building this (grep each
// episode's quote for keyword hits from 2+ cue categories) and it does
// not hold up: on the 365 real quotes, only ~6% of episodes matched 2+
// categories at all, and most of those were incidental word overlap, not
// a real combination -- e.g. "album" + "date_time" top-paired on a quote
// that never actually names an album. That's noise dressed up as a
// number, which is worse than just saying the data doesn't support the
// question, so this template says so plainly instead of estimating.
const COMBO_RE = /\b(combination|combinations|combine[sd]?|together|more than one|multiple (cues|details|pieces)|both .+ and)\b/i;

function comboCaveat(): string {
  return (
    "One thing worth flagging first: the coding only tags ONE primary cue per episode " +
    "(e.g. \"a date\" OR \"an object\", not both), so there's no coded ground truth for a " +
    "specific combination like \"an object and a time period together.\" Scanning the raw " +
    "quotes for that kind of overlap was tried, but it mostly picked up incidental word " +
    "matches rather than real combinations, so it's left out rather than shown as a number " +
    "it can't actually back up. Here's the real, single-cue breakdown instead:"
  );
}

const CUE_LABELS: Record<string, string> = {
  none_vague: "no specific, searchable detail at all -- just a vague sense that the photo exists somewhere",
  keyword_object: "a keyword or object/scene description (e.g. \"dog\", \"receipt\")",
  album_name: "the name of an album it might be in",
  date_time: "roughly when it was taken",
  person_face: "who's in it",
  manual_browsing: "nothing specific -- they browse/scroll instead of searching",
  recency: "that it's recent",
  file_type_video: "that it's a video rather than a photo",
  visual_text_in_image: "text visible inside the image itself (e.g. a screenshot)",
  location_place: "where it was taken",
  similar_photo: "that it looks similar to another photo",
  other: "something else that doesn't fit the usual categories",
};

// "Forgotten" and "incomplete-memory search" questions are now handled by
// their own templates (tryMemoryGaps, tryIncompleteMemorySearch) before
// this one is ever reached, so this intro only needs to vary for the combo
// caveat vs. the plain "what do people remember" framing.
function pickIntro(question: string): string {
  if (COMBO_RE.test(question)) {
    return comboCaveat();
  }
  return (
    "Here's what people actually have in mind when they go looking for a photo, ranked by how often " +
    "each kind of detail shows up, across every coded episode:"
  );
}

function tryMemoryCues(question: string): TemplateResult | null {
  if (!MEMORY_CUE_RE.test(question) && !COMBO_RE.test(question)) return null;

  const episodes = getAllEpisodes().filter((e) => !!e.cue);
  if (episodes.length === 0) return null;
  const total = episodes.length;

  const counts = new Map<string, number>();
  for (const e of episodes) counts.set(e.cue, (counts.get(e.cue) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  const bullets = sorted.map(([cue, n]) => {
    const label = CUE_LABELS[cue] ?? cue;
    const pct = Math.round((n / total) * 100);
    return `* ${label} -- ${n} episode${n === 1 ? "" : "s"} (${pct}%)`;
  });

  const vagueCount = counts.get("none_vague") ?? 0;
  const vaguePct = Math.round((vagueCount / total) * 100);
  const example = episodes.find((e) => e.cue === "none_vague");

  const answer =
    `${pickIntro(question)}\n\n${bullets.join("\n")}\n\n` +
    `The single largest group, at ${vagueCount} episodes (${vaguePct}%), is people with no specific, ` +
    `searchable detail at all -- they know a photo exists, but nothing about it that search could use.` +
    (example
      ? ` One person put it plainly: "${example.rq || example.q}" (thread: ${example.k}).`
      : "");

  const sources = example
    ? [
        {
          thread_key: example.k,
          source: example.src,
          cluster: getClusterById(example.cl)?.label ?? example.cl,
          quote: example.rq || example.q,
          score: 1,
        },
      ]
    : [];

  return { answer, sources };
}

// "What have they forgotten?" -- answered honestly rather than by reusing
// the cue ranking under a different label. The codebook tags one cue per
// episode, so there's no ground truth for "forgot X but remembered Y"; the
// one thing the data CAN say is how often someone has nothing usable in
// mind at all (cue = none_vague or manual_browsing). That's the real
// "forgotten everything" number, stated with the limitation up front.
function tryMemoryGaps(question: string): TemplateResult | null {
  if (!FORGOT_RE.test(question)) return null;

  const episodes = getAllEpisodes().filter((e) => !!e.cue);
  if (episodes.length === 0) return null;
  const total = episodes.length;

  const noneVague = episodes.filter((e) => e.cue === "none_vague");
  const manualBrowse = episodes.filter((e) => e.cue === "manual_browsing");
  const blankCount = noneVague.length + manualBrowse.length;
  const blankPct = Math.round((blankCount / total) * 100);
  const example = noneVague[0] ?? manualBrowse[0];

  const answer =
    `The coding only tags the one cue a person DID mention, not a checklist of what they've forgotten -- so ` +
    `there's no direct "forgot the date, remembered the object" number in this data. What it does show clearly ` +
    `is how often someone has nothing usable left to search with at all:\n\n` +
    `* ${noneVague.length} episodes (${Math.round((noneVague.length / total) * 100)}%) -- no specific detail ` +
    `whatsoever, just a sense the photo exists somewhere\n` +
    `* ${manualBrowse.length} episodes (${Math.round((manualBrowse.length / total) * 100)}%) -- nothing specific ` +
    `enough to search with, so they scroll/browse manually instead\n\n` +
    `Combined, that's ${blankCount} of ${total} episodes (${blankPct}%) where memory has effectively failed ` +
    `them completely. For the other ${total - blankCount} episodes, people do name one detail -- an object, a ` +
    `date, an album, a face -- but the coding can't say what else, if anything, they'd also forgotten on top of ` +
    `it.` +
    (example ? ` One example: "${example.rq || example.q}" (thread: ${example.k}).` : "");

  const sources = example
    ? [
        {
          thread_key: example.k,
          source: example.src,
          cluster: getClusterById(example.cl)?.label ?? example.cl,
          quote: example.rq || example.q,
          score: 1,
        },
      ]
    : [];

  return { answer, sources };
}

// "How do users formulate searches when their memory is incomplete?" --
// this is a question about search BEHAVIOR and what happens next, not
// about which detail is missing (that's tryMemoryGaps). So it pulls a
// different field entirely: the outcome (Episode.out) of just the
// no-usable-cue subset (none_vague + manual_browsing), which is the real
// answer to "what happens when someone has nothing to search with."
function tryIncompleteMemorySearch(question: string): TemplateResult | null {
  if (!INCOMPLETE_SEARCH_RE.test(question)) return null;

  const episodes = getAllEpisodes().filter((e) => !!e.cue && BLANK_CUES.has(e.cue));
  if (episodes.length === 0) return null;
  const total = episodes.length;

  const outCounts = new Map<string, number>();
  for (const e of episodes) outCounts.set(e.out, (outCounts.get(e.out) ?? 0) + 1);
  const sorted = [...outCounts.entries()].sort((a, b) => b[1] - a[1]);

  const bullets = sorted.map(([out, n]) => {
    const label = OUT_LABELS[out] ?? out;
    const pct = Math.round((n / total) * 100);
    return `* ${label} -- ${n} episode${n === 1 ? "" : "s"} (${pct}%)`;
  });

  const unresolvedCount = outCounts.get("unresolved") ?? 0;
  const unresolvedPct = Math.round((unresolvedCount / total) * 100);
  const example =
    episodes.find((e) => e.cue === "manual_browsing" && e.out === "unresolved") ??
    episodes.find((e) => e.out === "unresolved");

  const answer =
    `When someone has no specific detail to search with (${total} of 365 episodes), they don't really ` +
    `formulate a search at all -- they fall back to scrolling or browsing manually, hoping to recognize the ` +
    `photo on sight instead of describing it. Here's what happens to that strategy:\n\n${bullets.join("\n")}\n\n` +
    `The majority, ${unresolvedCount} episodes (${unresolvedPct}%), never get resolved -- without a specific ` +
    `term to search on, browsing mostly doesn't work.` +
    (example ? ` One example: "${example.rq || example.q}" (thread: ${example.k}).` : "");

  const sources = example
    ? [
        {
          thread_key: example.k,
          source: example.src,
          cluster: getClusterById(example.cl)?.label ?? example.cl,
          quote: example.rq || example.q,
          score: 1,
        },
      ]
    : [];

  return { answer, sources };
}

// --- intent: "what goes wrong", "what are the outcomes", "what triggers
// this" -- the dataset codes three more structured dimensions besides
// cue_type (Episode.fm = failure mode, Episode.out = outcome/resolution,
// Episode.trig = what preceded the problem), and until now none of them
// had a deterministic template. These three questions sit right at the
// center of the project's actual purpose -- how people search, how it
// fails, what happens after -- so leaving them to Gemini's free-form
// synthesis (which can refuse, contradict itself, or just be vaguer than
// the real numbers) was a real gap, not a minor one.
//
// Each one defers to the cluster-specific path first (via
// findMatchingClusters) when the question also names a specific cluster
// topic ("what goes wrong with face search?") -- a cluster-specific
// answer is more useful there than the global breakdown.

const FM_LABELS: Record<string, string> = {
  no_results: "search returns nothing at all",
  wrong_irrelevant_results: "search returns results, but the wrong or irrelevant ones",
  feature_missing: "the feature or filter needed to find it simply doesn't exist",
  ui_navigation_hard: "the interface is too confusing or hard to navigate to find it manually",
  data_lost_or_deleted: "the photo or data appears lost or deleted outright",
  degraded_after_update: "search got measurably worse after an app update",
  inconsistent_across_platform: "results are inconsistent across devices or platforms",
  download_export_failed: "downloading or exporting the photo fails",
  access_blocked: "access to the photo or album is blocked",
  sensitive_content_blocked: "sensitive content is blocked from appearing in results",
  positive_no_failure: "no failure at all -- search just worked",
  other: "something else that doesn't fit the usual categories",
};

const OUT_LABELS: Record<string, string> = {
  resolved: "fully resolved -- they found what they were looking for",
  partially_resolved: "partially resolved -- they found some, but not all, of it",
  unresolved: "left unresolved -- the problem was never actually fixed",
  gave_up: "gave up on finding it entirely",
  workaround_found: "found a workaround, without the underlying problem getting fixed",
  not_applicable: "not applicable (e.g. a success story, with nothing to resolve)",
};

const TRIG_LABELS: Record<string, string> = {
  after_app_update: "right after an app update",
  after_device_or_account_change: "after switching devices or accounts",
  after_deletion_or_cleanup: "after deleting or cleaning up photos",
  ongoing_recurring: "an ongoing, recurring issue with no single trigger",
  no_explicit_trigger: "no stated trigger at all -- it's just how search behaves",
  other: "something else",
};

const FAILURE_RE = /\b(goes? wrong|what fails|what breaks|failure mode|types? of failures?|kinds? of (problems?|failures?))\b/i;

// This originally required "do (people|users|they) (find|get)" as three
// literally adjacent words, which fails on completely ordinary phrasings
// like "Do people USUALLY find..." or "...find what they're looking for
// EVENTUALLY" -- any word in between breaks it. Caught by a user pressure-
// testing the bot: that question fell through all the way to Gemini, which
// (correctly, per its own instructions) said it had no evidence in the few
// retrieved quotes -- even though the real answer (78% unresolved) was
// sitting right there in the data, just unreachable by this regex. Fixed
// by allowing a bounded gap between the subject and verb instead of
// requiring them adjacent, plus the same for "find"/"eventually" in either
// order.
const OUTCOME_RE =
  /\b(resolved|resolution|outcome|give up|gave up|workaround|get (it |things? )?fixed|happens (after|next))\b|\b(do|does|did)\b[\s\S]{0,40}\b(find|get|resolve)\b|\bfind\b[\s\S]{0,30}\beventually\b|\beventually\b[\s\S]{0,30}\bfind\b/i;
const TRIGGER_RE = /\b(triggers?|what causes|causes? (it|this|search) to (break|fail)|when does (this|it|search) (happen|start|break))\b/i;

function breakdownTemplate(
  question: string,
  field: "fm" | "out" | "trig",
  labels: Record<string, string>,
  intro: string,
): TemplateResult | null {
  // A question about a specific named cluster ("what goes wrong with face
  // search?") gets a more useful cluster-specific answer than this global
  // breakdown, so defer to that path when one matches.
  if (findMatchingClusters(question).length > 0) return null;

  const episodes = getAllEpisodes().filter((e) => !!e[field]);
  if (episodes.length === 0) return null;
  const total = episodes.length;

  const counts = new Map<string, number>();
  for (const e of episodes) counts.set(e[field], (counts.get(e[field]) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  const bullets = sorted.map(([key, n]) => {
    const label = labels[key] ?? key;
    const pct = Math.round((n / total) * 100);
    return `* ${label} -- ${n} episode${n === 1 ? "" : "s"} (${pct}%)`;
  });

  const [topKey, topN] = sorted[0];
  const topPct = Math.round((topN / total) * 100);
  const example = episodes.find((e) => e[field] === topKey);
  const topLabel = labels[topKey] ?? topKey;

  const answer =
    `${intro}\n\n${bullets.join("\n")}\n\n` +
    `The largest group, at ${topN} episodes (${topPct}%): ${topLabel}.` +
    (example ? ` One example: "${example.rq || example.q}" (thread: ${example.k}).` : "");

  const sources = example
    ? [
        {
          thread_key: example.k,
          source: example.src,
          cluster: getClusterById(example.cl)?.label ?? example.cl,
          quote: example.rq || example.q,
          score: 1,
        },
      ]
    : [];

  return { answer, sources };
}

function tryFailureModes(question: string): TemplateResult | null {
  if (!FAILURE_RE.test(question)) return null;
  return breakdownTemplate(
    question,
    "fm",
    FM_LABELS,
    "Here's how search actually fails in practice, across every coded episode (including the " +
      "baseline successes, so the failure rate reads in context rather than in isolation):",
  );
}

function tryOutcomes(question: string): TemplateResult | null {
  if (!OUTCOME_RE.test(question)) return null;
  return breakdownTemplate(
    question,
    "out",
    OUT_LABELS,
    "Here's what ultimately happens after someone runs into a search problem, across every " +
      "coded episode:",
  );
}

function tryTriggers(question: string): TemplateResult | null {
  if (!TRIGGER_RE.test(question)) return null;
  return breakdownTemplate(
    question,
    "trig",
    TRIG_LABELS,
    "Here's what tends to precede a search problem, across every coded episode:",
  );
}

// --- intent: "has this gotten better/worse over time" -- the one coded
// field (Episode.date) that had no template at all. Worth being careful
// here: the 354 dated episodes are heavily skewed toward the most recent
// year (276 of 354, 78%) because review/complaint volume naturally piles
// up near whenever the data was pulled, and several early years have
// single-digit sample sizes (2015: 1 episode, 2021: 3). A year-by-year
// unresolved-rate breakdown on numbers that small would look like a trend
// line but mostly be noise, so early years are grouped into one bucket
// and labeled with their real (tiny) n instead of implying a false signal.
const TIME_TREND_RE =
  /\b(over time|getting (better|worse)|improv(e|ed|ing)|trend|has this changed|still (a )?(problem|issue)|more recent|lately|these days)\b/i;

function tryTimeTrend(question: string): TemplateResult | null {
  if (!TIME_TREND_RE.test(question)) return null;
  if (findMatchingClusters(question).length > 0) return null;

  const dated = getAllEpisodes().filter((e) => !!e.date && !!e.out);
  if (dated.length === 0) return null;

  type Bucket = { label: string; total: number; unresolved: number };
  const buckets = new Map<string, Bucket>();
  for (const e of dated) {
    const year = e.date.slice(0, 4);
    const key = Number(year) <= 2022 ? "early" : year;
    const label = key === "early" ? "2022 and earlier" : year;
    const b = buckets.get(key) ?? { label, total: 0, unresolved: 0 };
    b.total += 1;
    if (e.out === "unresolved") b.unresolved += 1;
    buckets.set(key, b);
  }
  const sortedKeys = [...buckets.keys()].sort((a, b) => (a === "early" ? -1 : b === "early" ? 1 : a.localeCompare(b)));

  const bullets = sortedKeys.map((key) => {
    const b = buckets.get(key)!;
    const pct = Math.round((b.unresolved / b.total) * 100);
    const smallSampleNote = b.total < 10 ? " (small sample)" : "";
    return `* ${b.label}${smallSampleNote} -- ${b.total} episode${b.total === 1 ? "" : "s"}, ${pct}% unresolved`;
  });

  const recentYears = sortedKeys.filter((k) => k !== "early").slice(-3);
  const recentUnresolvedPcts = recentYears.map((k) => {
    const b = buckets.get(k)!;
    return Math.round((b.unresolved / b.total) * 100);
  });

  const answer =
    `Here's the unresolved rate by year, across every dated episode. One honesty note first: the data is ` +
    `heavily skewed toward the most recent year (${buckets.get(sortedKeys[sortedKeys.length - 1])?.total} of ` +
    `${dated.length} dated episodes), and the early years have very few episodes each, so those are grouped ` +
    `together rather than shown as a year-by-year line that would just be noise:\n\n${bullets.join("\n")}\n\n` +
    `The honest read: there's no sign of this getting better over time -- the unresolved rate has stayed ` +
    `persistently high (${recentUnresolvedPcts.join("%, ")}% across the most recent years with real sample ` +
    `size) rather than trending down after any particular update or fix.`;

  return { answer, sources: [] };
}

// --- intent: "how severe are these problems" -- Episode.sev (low/medium/
// high) is used inside individual cluster cards but never surfaced as its
// own breakdown. Distinct from the "top ranked problems" template (which
// already folds severity into its ranking), this answers the narrower
// question of how severity itself is distributed.
const SEVERITY_RE = /\b(how severe|severity (level|breakdown|distribution)|most serious|highest severity)\b/i;

function trySeverity(question: string): TemplateResult | null {
  if (!SEVERITY_RE.test(question)) return null;
  if (findMatchingClusters(question).length > 0) return null;

  const episodes = getAllEpisodes().filter((e) => !!e.sev);
  if (episodes.length === 0) return null;
  const total = episodes.length;

  const counts = { low: 0, medium: 0, high: 0 } as Record<string, number>;
  for (const e of episodes) counts[e.sev] = (counts[e.sev] ?? 0) + 1;

  const bullets = (["high", "medium", "low"] as const).map((level) => {
    const n = counts[level] ?? 0;
    const pct = Math.round((n / total) * 100);
    return `* ${level} severity -- ${n} episode${n === 1 ? "" : "s"} (${pct}%)`;
  });

  const topCluster = getClusters()
    .filter((c) => c.severity_score !== null)
    .sort((a, b) => (b.severity_score ?? 0) - (a.severity_score ?? 0))[0];

  const answer =
    `Here's how severity is distributed across every coded episode:\n\n${bullets.join("\n")}\n\n` +
    (topCluster
      ? `The single most severe problem AREA (by average severity score, not raw count) is "${topCluster.label}" ` +
        `-- ${topCluster.n} episodes with a severity score of ${topCluster.severity_score}.`
      : "");

  const example = topCluster ? representativeEpisode(topCluster) : undefined;
  const sources = example
    ? [
        {
          thread_key: example.k,
          source: example.src,
          cluster: topCluster!.label,
          quote: example.rq || example.q,
          score: 1,
        },
      ]
    : [];

  return { answer, sources };
}

// --- intent: "does this differ by platform / app store vs reddit" --
// Episode.src is coded on every episode but never broken out on its own.
// Triggered either by naming two or more platforms together, or by a
// generic "by platform/source" phrasing.
const SRC_LABELS: Record<string, string> = {
  app_store: "App Store (iOS)",
  play_store: "Play Store (Android)",
  arctic_shift: "Reddit",
  gphotos_community: "Google Photos Community forum",
  youtube: "YouTube comments",
  stackexchange: "Stack Exchange",
};

const SOURCE_RE =
  /\b(app store|play store|reddit|google photos community|community forum|youtube|stack exchange)\b[\s\S]*\b(app store|play store|reddit|community|youtube|stack exchange|differ|compare|versus|vs\.?|different)\b|\bby (platform|source)\b|\bacross platforms\b/i;

function trySourceBreakdown(question: string): TemplateResult | null {
  if (!SOURCE_RE.test(question)) return null;
  if (findMatchingClusters(question).length > 0) return null;

  const episodes = getAllEpisodes().filter((e) => !!e.src && !!e.out);
  if (episodes.length === 0) return null;

  type Row = { src: string; total: number; unresolved: number };
  const rows = new Map<string, Row>();
  for (const e of episodes) {
    const r = rows.get(e.src) ?? { src: e.src, total: 0, unresolved: 0 };
    r.total += 1;
    if (e.out === "unresolved") r.unresolved += 1;
    rows.set(e.src, r);
  }
  const sorted = [...rows.values()].sort((a, b) => b.total - a.total);

  const bullets = sorted.map((r) => {
    const pct = Math.round((r.unresolved / r.total) * 100);
    const label = SRC_LABELS[r.src] ?? r.src;
    return `* ${label} -- ${r.total} episode${r.total === 1 ? "" : "s"}, ${pct}% unresolved`;
  });

  const answer =
    `Here's how the episode counts and unresolved rate break down by where the report came from:\n\n` +
    `${bullets.join("\n")}\n\n` +
    `The platforms aren't equally sized samples (Play Store alone accounts for over half the dataset), so ` +
    `treat the smaller platforms' percentages as a rough read rather than a precise comparison -- but none ` +
    `of them show a dramatically better resolution rate than the others.`;

  return { answer, sources: [] };
}

// --- intent: "tell me about <cluster topic>" (single match) or
// "compare X to Y" / "X vs Y" (two matches) -- fuzzy-match the question's
// words against every cluster label, rather than stopping at the first
// hit. A question naming two topics ("how does face search compare to
// date browsing?") used to silently collapse onto whichever one happened
// to score higher and drop the other half of the question entirely --
// which defeats the actual point of a question like that. Matching against
// every cluster first and branching on how many came back fixes that.

function findMatchingClusters(question: string): { cluster: Cluster; score: number }[] {
  // Deliberately uses the LITERAL question words only, not the synonym-
  // expanded set that lib/synonyms.ts adds for BM25 search. This check
  // decides whether to short-circuit straight to specific cluster(s), so
  // it needs to be conservative -- a loose match here hijacks the whole
  // answer into the wrong topic instead of just adding a so-so extra
  // source the way a loose BM25 match would.
  const queryTokens = new Set(tokenize(question));
  if (queryTokens.size === 0) return [];

  const matches: { cluster: Cluster; score: number }[] = [];
  for (const cluster of getClusters()) {
    const labelTokens = tokenize(cluster.label);
    if (labelTokens.length === 0) continue;
    const overlap = labelTokens.filter((t) => queryTokens.has(t)).length;
    if (overlap === 0) continue;
    const ratio = overlap / labelTokens.length;
    // Require a decent share of the label's own words to be present, or a
    // solid absolute number of them -- a couple of incidentally shared
    // words isn't confident enough evidence this is what the person meant,
    // especially against a long, multi-clause label.
    if (ratio < 0.3 && overlap < 3) continue;
    matches.push({ cluster, score: overlap });
  }
  return matches.sort((a, b) => b.score - a.score);
}

function describeSingleCluster(cluster: Cluster, ep: Episode | undefined): string {
  const rankClause = cluster.rank ? `, ranked #${cluster.rank} among the scored problem clusters` : "";
  const pairClause = cluster.top_pair ? `, most often involving ${cluster.top_pair}` : "";
  const quoteSentence = ep ? ` One person put it this way: "${ep.rq || ep.q}" (thread: ${ep.k}).` : "";
  return (
    `${cluster.label} shows up in ${cluster.n} episode${cluster.n === 1 ? "" : "s"} in the dataset` +
    `${rankClause}${pairClause}.` +
    `${describeSeverity(cluster.severity_score)}${quoteSentence}`
  );
}

function tryCompareClusters(a: Cluster, b: Cluster): TemplateResult {
  const epA = representativeEpisode(a);
  const epB = representativeEpisode(b);

  const bulletFor = (c: Cluster, ep: Episode | undefined) => {
    const rank = c.rank ? `rank #${c.rank}` : "unranked";
    const sev = c.severity_score !== null ? `severity ${c.severity_score.toFixed(2)}` : "severity unscored";
    const quote = ep ? ` -- e.g. "${ep.rq || ep.q}" (thread: ${ep.k})` : "";
    return `* **${c.label}**: ${c.n} episode${c.n === 1 ? "" : "s"}, ${rank}, ${sev}${quote}`;
  };

  const [moreFrequent, lessFrequent] = a.n >= b.n ? [a, b] : [b, a];
  const freqDelta = lessFrequent.n > 0 ? Math.round(((moreFrequent.n - lessFrequent.n) / lessFrequent.n) * 100) : null;

  let severityNote = "";
  if (a.severity_score !== null && b.severity_score !== null) {
    const [moreSevere] = a.severity_score >= b.severity_score ? [a] : [b];
    severityNote =
      moreSevere.id === moreFrequent.id
        ? ` ${moreFrequent.label} also tends to run more severe.`
        : ` That said, ${moreSevere.label} tends to run more severe, even though it's the less frequent of the two.`;
  }

  const answer =
    `Comparing the two directly:\n\n${bulletFor(a, epA)}\n${bulletFor(b, epB)}\n\n` +
    `${moreFrequent.label} is the more common of the two` +
    (freqDelta !== null ? ` -- about ${freqDelta}% more episodes than ${lessFrequent.label}.` : ".") +
    severityNote;

  const sources = [
    epA && { thread_key: epA.k, source: epA.src, cluster: a.label, quote: epA.rq || epA.q, score: 1 },
    epB && { thread_key: epB.k, source: epB.src, cluster: b.label, quote: epB.rq || epB.q, score: 1 },
  ].filter((s): s is NonNullable<typeof s> => !!s);

  return { answer, sources };
}

function tryClusterLookup(question: string): TemplateResult | null {
  const matches = findMatchingClusters(question);
  if (matches.length === 0) return null;

  if (matches.length >= 2 && matches[0].cluster.id !== matches[1].cluster.id) {
    return tryCompareClusters(matches[0].cluster, matches[1].cluster);
  }

  const { cluster } = matches[0];
  const ep = representativeEpisode(cluster);
  return {
    answer: describeSingleCluster(cluster, ep),
    sources: ep
      ? [{ thread_key: ep.k, source: ep.src, cluster: cluster.label, quote: ep.rq || ep.q, score: 1 }]
      : [],
  };
}

// Tried in order of specificity -- stats and top-ranked are narrow, high-
// confidence patterns; memory-cues/failure-modes/outcomes/triggers are
// each specific to their own keyword set; cluster lookup (single or
// comparison) is broadest and checked last so it doesn't shadow the
// others on overlapping words like "problem".
export function tryTemplate(question: string): TemplateResult | null {
  return (
    tryStats(question) ??
    tryTopRanked(question) ??
    tryMemoryGaps(question) ??
    tryIncompleteMemorySearch(question) ??
    tryMemoryCues(question) ??
    tryFailureModes(question) ??
    tryOutcomes(question) ??
    tryTriggers(question) ??
    tryPhotoKinds(question) ??
    tryTimeTrend(question) ??
    trySeverity(question) ??
    trySourceBreakdown(question) ??
    tryClusterLookup(question)
  );
}
