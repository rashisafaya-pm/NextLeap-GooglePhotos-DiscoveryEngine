# Google Photos Search Insights

An open-link chatbot over the Google Photos retrieval-discovery evidence
base (365 episodes / 239 in-scope clusters). Anyone with the URL can open
it and ask questions -- no sign-in, no account needed. Answers are grounded
in real evidence quotes retrieved by a hand-rolled search, not free-floating
LLM knowledge. Visitors can only ask questions; there's nothing in the app
that writes, edits, or deletes anything -- the underlying data file is read
by the server, never touched.

Built to run entirely on free tiers: Vercel (hosting), Google Gemini (the
LLM). No database, no login provider.

This project was hand-written in full (not scaffolded with `create-next-app`)
because it was built in a sandboxed environment with no access to the npm
registry. That means **nothing here has been installed or compiled yet** --
the very first `npm install` / `npm run build` will happen either on your
own machine or on Vercel's build servers. Follow the steps below in order;
step 2 (`npm install` locally) is the first real compile check this code
gets, so don't skip straight to deploying.

## Design

All three screens share one look and one nav bar: Google's Material
Design 3 token system (the same `--primary` / `--surface` / `--outline`
role colors as the standalone Google Photos Search Insights artifact),
Roboto + Roboto Mono, pill-shaped buttons and inputs, and a light/dark
toggle (shown as a sun/moon icon) that reads and writes the same
`localStorage` key (`retrieval-atlas-theme`) everywhere -- so switching
theme on one screen keeps the others in sync. The nav bar itself is a
separate, full-width, sticky strip above the page content (`.site-header-bar`
in `app/globals.css`, mirrored in the two static pages below) -- it's chrome,
not part of the article underneath it.

## What it does

- `/` -- **Insights**, the landing page: intro, the 5 top-level stats, the
  data-collection methodology (the funnel from 34,732 raw items down to 365
  coded episodes, plus the real date range the episodes span and how
  skewed it is toward the most recent year), and a ranked list of the 10
  in-scope problem clusters -- each row shows a severity mini-bar
  (high/medium/low mix) and deep-links into "What People Say" for that
  specific cluster. Served via `app/route.ts` from `public/insights.html`.
- `/what-people-say` -- **What People Say**, the detailed quote-browsing
  screen: click any ranked cluster (or an out-of-scope group) to read
  representative quotes and every individual thread, filterable by
  severity, by what the person remembered when they went looking, and by
  source platform (App Store / Play Store / Reddit / etc.). This is where
  the full 365-episode dataset actually lives. Served via
  `app/what-people-say/route.ts` from `public/what-people-say.html`.
- `/ask` -- **Ask**, the chatbot (Insights Bot). Type a question, get an
  answer grounded in real evidence, with an expandable source list under
  each answer, suggested questions always visible in a left-hand rail, and
  a "Start over" button to reset the conversation. Each reply is tagged
  **"From full dataset"** (a deterministic template computed from every
  coded episode) or **"AI-assisted"** (Gemini synthesizing a handful of
  retrieved quotes), so it's visible at a glance which answers are exact
  counts and which are a model's read of a few examples. The chatbot
  answers one question at a time; the other two screens are for browsing
  -- they're complementary, not a replacement for each other.

All three screens share a sticky nav bar with a subtle Material-tint
gradient, and a refresh anywhere redirects back to Insights (the intended
single entry point) rather than reloading mid-chat or mid-browse in place.

Both static pages (`public/insights.html`, `public/what-people-say.html`)
are generated from `data/data.json` by `atlas/build_pages.py` (kept outside
this app folder, alongside the original master fragment) rather than
hand-edited -- `what-people-say.html` alone embeds the full 365-episode
JSON inline, so regenerating from the source data is far less error-prone
than hand-splicing that file. Re-run it after `data/data.json` changes,
then copy the two `public/*.html` outputs over.
- `/api/chat` -- answers every question through three tiers, cheapest
  first, so Gemini is the last resort rather than the default:
  1. **Template** (`lib/templates.ts`) -- a growing set of common question
     shapes have a fully deterministic answer sitting in the data itself:
     dataset-level stats, top-ranked problems, what people remember vs.
     have forgotten vs. how they search with incomplete memory (three
     genuinely different cuts of the same field, not one answer reworded),
     failure modes, outcomes, triggers, a year-over-year trend (with an
     honest caveat about how skewed the dates are), a severity breakdown,
     a source-platform breakdown, and single-cluster lookup/comparison.
     These are answered instantly, for free, with full sentences built
     from `data.json` -- no LLM call at all.
  2. **Cache** (`lib/cache.ts`) -- if a similar question already got a
     Gemini-generated answer earlier (in this serverless function's
     lifetime), that answer is reused instead of calling the API again.
  3. **Gemini** -- only questions that need real synthesis over multiple
     quotes reach here. BM25 search (`lib/retrieval.ts`) finds the most
     relevant excerpts, then Gemini (`lib/llm.ts`) is instructed to answer
     only from those quotes, with a built-in "I don't have evidence for
     that" fallback. Its answer is then cached for next time.
- A simple per-IP rate limit (10 questions/minute), applied only to the
  Gemini tier -- template and cache answers are free, so they skip it. The
  link is open to anyone, so this is a soft guard against a runaway script
  or bot eating your free Gemini quota, not a hard security measure.

The data itself (`data/data.json`) is bundled straight into the deployed
app as a static file -- no database to pay for or manage. To update it
later, re-run your Stage 8 pipeline and copy the new `data.json` over this
one, then redeploy.

## Key findings

What the 365 coded episodes actually show, for anyone who wants the
headline numbers without opening the app:

- **78% of episodes (283/365) are left unresolved.** Only 14 (4%) are
  fully resolved; the rest end in a workaround, giving up, or just
  staying broken. This holds across every year with a real sample size --
  there's no sign it's gotten better or worse over time.
- **The #1 problem area** is keyword/object/caption search returning
  nothing or the wrong results (63 episodes) -- ahead of search breaking
  after an app update (25), unreliable date/time browsing (22), and
  general UI confusion (76, the single largest cluster by raw count,
  though more diffuse).
- **A third of people (120/365, 33%) have nothing specific to search
  with at all** -- either no detail in mind whatsoever (89) or nothing
  specific enough to search, so they just scroll/browse manually (31).
  When that happens, 66% of those searches are never resolved.
- **The most common failure mode** is search degrading after an app
  update (71 episodes) -- ahead of returning no results at all (61) and
  data appearing lost or deleted (60).
- **Most problems have no explicit trigger** (203 episodes) -- they're
  just how search behaves day to day, not a one-time regression tied to
  a specific update (73 episodes) or device change.
- **Platform doesn't change the story much**: Play Store is by far the
  largest source (205 of 354 dated episodes) and runs a 78% unresolved
  rate; no platform shows a meaningfully better resolution rate.

## 1. Create your free accounts

You'll need two free accounts if you don't have them already:

1. **GitHub** -- https://github.com/signup (to host the code so Vercel can
   build it).
2. **Vercel** -- https://vercel.com/signup -- sign up with your GitHub
   account, it's the easiest way to connect the two.

And one API key:

3. **Google AI Studio** -- https://aistudio.google.com/apikey -- for the
   Gemini API key (uses a Google account you likely already have).

## 2. Run it locally first (recommended)

This catches any typos before you deploy. In a terminal, inside this
project folder:

```
npm install
```

If that finishes without errors, continue. If it fails, copy the error --
most likely it's a typo in one of the hand-written files, and worth fixing
before deploying.

Copy `.env.local.example` to `.env.local` and fill in `GEMINI_API_KEY`
(see step 3 below). Then:

```
npm run dev
```

Open http://localhost:3000 -- you should see the chat page immediately.

## 3. Get a Gemini API key

1. Go to https://aistudio.google.com/apikey and click **Create API key**.
2. Copy it into `GEMINI_API_KEY`.
3. The free tier has a per-minute and per-day request limit. With a handful
   of people asking occasional questions this should be comfortable, but if
   you hit limits, the error will say so plainly in the chat UI. The
   built-in rate limit (step "What it does" above) helps keep this in check.

## 4. Deploy to Vercel

1. Push this folder to a new GitHub repo:
   ```
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin <your-new-repo-url>
   git push -u origin main
   ```
2. In Vercel, click **Add New -> Project**, import that GitHub repo.
3. Before deploying, open **Environment Variables** and add `GEMINI_API_KEY`.
4. Click **Deploy**. Vercel's build servers have normal npm access, so this
   is also the first time `next build` runs for real.

Share the Vercel URL with anyone -- they can open it and start asking
questions right away, no sign-up step.

## Updating the evidence data later

Three files need updating together, since the chatbot and the two static
pages each bundle their own copy of the data:

1. Re-run your existing Stage 8 pipeline (`build_stage8_data.py`) to produce
   a fresh `data.json`.
2. Replace `data/data.json` in this project with the new `data.json` (powers
   the chatbot's templates and BM25 search).
3. Run `python3 atlas/build_pages.py` (from the `atlas/` folder alongside
   this project) -- it reads the new `data/data.json` and regenerates both
   `public/insights.html` and `public/what-people-say.html`. Copy both over
   the ones in this project, then redeploy (push to GitHub -- Vercel
   redeploys automatically).

## If something breaks

- **Build fails on Vercel**: check the build log for the exact TypeScript
  or syntax error -- since this code was never compiled before now, a typo
  is the most likely culprit; the line number in the error is accurate.
- **"GEMINI_API_KEY is not set"**: you deployed without adding it in
  Vercel's Environment Variables, or added it after the last deploy (redeploy
  to pick it up).
- **"Too many questions in a short time"**: the per-IP rate limit kicked in
  (10/minute) -- wait a minute, or raise `RATE_LIMIT_MAX_REQUESTS` in
  `app/api/chat/route.ts` if that's too strict for your use.

## Want some access control after all?

If this ever gets passed around more widely than you'd like and you want to
restrict who can use it, the simplest free option is adding a shared
password gate in `middleware.ts` (check a cookie, if missing show a
one-field password form, compare against an env var). That's a bigger
change than this version includes -- just flag it and it can be added back.
