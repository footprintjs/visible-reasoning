# Visible Reasoning — runnable reference implementations

Seven small, self-contained examples that demonstrate the paper *Visible Reasoning: User-Facing Decision Transparency for Generative AI Systems*. Each one runs a real pipeline, records it, and shows the paper's third transparency paradigm — **recorded decision evidence**, where the execution substrate owns the trace instead of a model narrating itself. Every example is one `run.js`, costs nothing to run (mock providers only, no API keys), and prints a stable summary checked against an `expected-output.txt`. The last two also have an interactive mode — a served page where you tap through the influence map, re-run the agent for real, and (in the chat desk) branch the conversation from a counterfactual.

## The paper

Anbalagan, S.K., Nie, X., Kommalapati, A., Kanamarlapudi, V.K., Radhakrishnan, S., Zhao, X., Mohan, U. (2026). "Visible Reasoning: User-Facing Decision Transparency for Generative AI Systems." *Artificial Intelligence in HCI (HCII 2026)*, LNCS 16745, pp. 3–21. Springer, Cham.

DOI: [10.1007/978-3-032-30849-8_1](https://doi.org/10.1007/978-3-032-30849-8_1)

The three paradigms it contrasts: chain-of-thought (a model narrates itself — unverifiable), LLM-as-judge (recursive trust), and **recorded decision evidence** — the framework owns the trace, every decision is a typed event, and humans, cheaper models, and training pipelines all consume the same recording.

## Run everything

```sh
git clone https://github.com/footprintjs/visible-reasoning.git
cd visible-reasoning
npm install
npm run all
```

`npm run all` runs all eight examples and byte-diffs each printed `=== SUMMARY ===` block against that example's `expected-output.txt`, exiting non-zero on any drift (also available alone as `npm run verify`).

Or run a single example:

```sh
npm run example:1   # 01-substrate-owns-the-trace
npm run example:2   # 02-one-recording-three-readers
npm run example:3   # 03-user-facing-why
npm run example:4   # 04-honest-absence
npm run example:5   # 05-prove-by-replay
npm run example:6   # 06-stock-desk (default mode; npm run stock-desk serves the interactive page)
npm run example:7   # 07-chat-desk (default mode; npm run chat-desk serves the interactive chat)
npm run example:8   # 08-app-gallery (default mode; npm run gallery serves the cards page + all three desks)
```

## Try it live (optional)

> Requires Node 20.6+ (the live script uses `node --env-file`).

An optional sixth act tells the same "recorded decision evidence" story against the **real Anthropic API**: a two-tool agent, one short task that forces a tool choice, recorded and then explained from its own trace. As a stranger would follow it:

```sh
git clone https://github.com/footprintjs/visible-reasoning.git
cd visible-reasoning
npm install
npm run all          # the five mock examples — free, no key
cp .env.example .env # then paste your Anthropic key into .env
npm run live         # the live act — costs about two small Haiku calls
```

`npm run live` loads your key from `.env` (git-ignored, never committed), runs `claude-haiku-4-5-20251001` (any Claude model id works), and prints which tool was chosen, the recorded why-this-tool evidence, a couple of typed-event counts, and the live model's answer. It is left out of `npm run all` because a real model's wording varies run to run.

## The map

| Paper claim | Example directory | What you will see |
|---|---|---|
| 1. The substrate owns the trace | `01-substrate-owns-the-trace` | A decider run reconstructed entirely from the snapshot — commit log + engine-recorded decision evidence, no model asked to explain. |
| 2. One recording, three readers | `02-one-recording-three-readers` | One agent run consumed three ways — human narrative, a cheap mock model answering "why?" from the trace, and a training-data export — zero re-runs. |
| 3. User-facing "why" | `03-user-facing-why` | A real run emits a self-contained `out/replay.html` an end user can scrub beat-by-beat to see the why-this-tool evidence. |
| 4. Honest absence | `04-honest-absence` | Two values in one run: one proven back to its origin, one honestly flagged `CANNOT PROVE` because its input (env) was untracked. |
| 5. Prove by replay | `05-prove-by-replay` | A wrong answer localized to the context that caused it, then confirmed counterfactually by rerunning with that piece ablated. |
| 6. The stock desk (interactive) | `06-stock-desk` | An influence map you can drive: see what fed a BUY call, suspect social media, ignore it, and re-run the agent for real — the call flips to HOLD, proven by replay. |
| 7. The chat desk (conversation) | `07-chat-desk` | A real multi-turn chatbot where transparency lives in the chat: every reply has a "visible reason" button, re-running a turn without a source shows a labeled what-if bubble beside the untouched original, and "continue from this version" forks the conversation forward — branch, never rewrite. |
| 8. The app gallery (three apps, one machine) | `08-app-gallery` | Three real chat apps — stocks, movies, trips — sharing one visible-reason machine, with every context source served as an **MCP tool the agent calls** and labeled with its own provenance (live, synthetic fallback, or always-synthetic). |

## The examples

### 1 — The substrate owns the trace

A tiny support-ticket flowchart (seed → decider with `decide()` evidence → branch → finish) runs once. The entire "why" — the ordered typed commit events, the decision taken, and the rule-level evidence — is reconstructed from the snapshot alone. No model is asked to explain anything, because the execution substrate produced the record.

```
=== SUMMARY ===
commit events: 4
  0 intake#0 Intake set:severity
  1 route#1 Route -
  2 urgent#2 Escalate set:lane
  3 finish#3 Finish set:closed
flow events: 5
  stageExecuted Intake linear
  decision Route Escalate
  stageExecuted Route decider
  stageExecuted Escalate linear
  stageExecuted Finish linear
decision: Route -> Escalate (branch 'urgent')
  rule[0] "Severity above 5": severity gt 5 matched=true actual=8
  default: normal
provenance: engine-recorded (commit log + decision evidence), not model-narrated
=== END ===
```

### 2 — One recording, three readers

One mock agent run produces a single typed recording, consumed three ways with zero re-runs: a human-readable narrative, a cheap mock model that answers "why did it choose that tool?" using only the recording, and an `assembleTrajectory` training-data export. A runId-free fingerprint of the commit log ties all three readers to the identical recording.

```
=== SUMMARY ===
ONE RECORDING (runId present but stripped from all assertions)
  commit-log entries: 40
  distinct stages: 12
  llm-call steps: call-llm#18, call-llm#40
  fingerprint (sha256, runId-free): e65834222993
READER 1 — human-readable explanation (run narrative)
  narrative entries: 334
  opening line: Stage 1: The process began: Agent: ReAct loop.
READER 2 — cheap mock model, given ONLY the recording
  question: Why did the agent choose that tool?
  trace tool the model called: who_wrote(lastToolResult)
  tool named IN the trace: weather
  answer: The agent chose the "weather" tool. Trace evidence: ToolCalls wrote lastToolResult with toolName "weather".
READER 3 — training-data export (assembleTrajectory)
  trajectory rows (frames): 2
  row[0] shape: loopIndex, llmCallId, llmCallArrayIdx, headArrayIdx, bodyIds, intermediateText, contextSources, untrackedReadsPresent
  row[0].llmCallId: call-llm#18
ALL THREE consumed fingerprint e65834222993 — one agent.run(), zero re-runs
=== END ===
```

### 3 — User-facing "why"

A mock-provider agent (WeatherBot, two tools) runs, the framework records it as a typed agentthinkingui trace, and the generator emits a self-contained `out/replay.html` that inlines React + the ATUI player + that exact recorded trace. An end user can scrub the run beat-by-beat offline **and tap the final answer to open a "Why this answer" board** — the chain (answer ← tool output with score ← chosen tool ← context pieces with scores) is computed FROM THE RECORDING by `localizeContextBug` and mapped to the board by `toBacktrackTrace`; the tap is wired through agentthinkingui's real `onBacktrack` hook to a controlled `BacktrackOverlay`. Nothing is hand-authored: where the library cannot prove a link it says so (top suspects are marked path-only upper bounds, and the slice's honesty flags ride along verbatim).

```
=== SUMMARY ===
trace beats: 4
beat kinds: prompt -> ask -> return -> answer
tools considered: 2 (weather, clock)
tool asked: weather
why this answer (computed from the recording by localizeContextBug):
  mode: correlational · suspects ranked: 5 · decided at: call-llm#40
  top influence (path-only upper bound): stage context#6 via systemPromptInjections score 0.836
  tool output that fed it: weather "Paris: 72F, sunny" score 0.491
  honesty flags carried into panel: 2 (untracked-sources, no-control-deps)
  link proven from the recording: yes
file emitted: 03-user-facing-why/out/replay.html
size bucket: 256KB-1MB
html has embedded trace JSON: yes
html has embedded why-chain JSON: yes
html has why-answer panel (onBacktrack -> BacktrackOverlay): yes
html has atui bootstrap: yes
=== END ===
```

### 4 — Honest absence

One recorded run makes two provenance queries against the same slice layer. `tier` (written from a tracked read of `amount`) reconstructs a full causal chain back to its origin stage; `riskFlag` (written from an untracked env read) is stamped as having an untracked source. The query layer returns PROVEN for the first and CANNOT PROVE for the second — it flags the input it cannot see instead of inventing an edge.

```
=== SUMMARY ===
Claim 4 — honest absence: two values, one recorded run, default dials.

TRACKED VALUE            'tier'
  writer            classify-tracked#1
  provenance chain  classify-tracked#1 <-amount- seed#0
  untracked inputs  none
  VERDICT           PROVEN — full causal chain back to seed#0; nothing hidden

ABSENT-PROVENANCE VALUE  'riskFlag'
  writer            score-from-env#2
  provenance chain  score-from-env#2
  untracked inputs  env
  VERDICT           CANNOT PROVE — writer read env (untracked); the trace refuses to guess

Same run, same query layer: it proves what it can see and flags what it cannot.
=== END ===
```

### 5 — Prove by replay

A mock refunds agent is seeded with several facts, one of which is a planted wrong fact ("VIP override — refund beyond 30 days"), so the agent approves an out-of-policy refund. `localizeContextBug` slices back from the answering LLM call, ranks the suspects, then rebuilds and reruns the agent with each suspect ablated to see which removal flips the outcome. The confirmed culprit is named by replay, not by asking a model; the benign decoy is correctly not confirmed.

```
=== SUMMARY ===
original answer wrong (approved out-of-policy): true
localization mode: causal
suspects ranked: 4
injection verdicts: vip-override=confirmed, style-rule=not-confirmed
localized culprit: injection:vip-override
confirmation verdict: confirmed
counterfactual answer flips to in-policy: true
=== END ===
```

### 6 — The stock desk (interactive)

The paper's finale, made tap-able. A trading-desk agent weighs three sources — quarterly results (solid-but-unspectacular fundamentals), insider activity (neutral), and social sentiment (hyped bullish chatter) — and calls **BUY**. The scripted mock is wired so social sentiment's *presence* yields BUY and its *absence* yields HOLD, so the flip is real, produced by the re-run, never hand-authored. `localizeContextBug` (semantic-alignment strategy, mock embedder) ranks the sources, `removableSources` is the toggle list, and one `rerunWithoutSources({ ignore: ['social-sentiment'], checkBaseline: true })` ablates-and-reruns to confirm the cause.

```
=== SUMMARY ===
scenario: stock (stock desk)
ranked by: semantic-alignment
influence (removable sources, ranked — proxy scores, not proof):
  social-sentiment [injection] score 0.872
  insider-activity [injection] score 0.841
  quarterly-results [injection] score 0.811
original answer: BUY — bullish social momentum: the EXTREMELY bullish sentiment trending across forums is a strong BUY signal.
ignored source: social-sentiment
rerun answer: HOLD — no catalyst beyond fair value: revenue up 4% as guided, insider activity steady, nothing driving a move.
flipped: true
verdict: confirmed
=== END ===
```

**The interactive routine.** Serve the page and drive it yourself:

```sh
npm run stock-desk   # generates 06-stock-desk/out/desk.html from real run data and serves it
```

Then open **http://localhost:4173** and:

1. See the **influence map** — the BUY answer at the centre, every source orbiting it, sized by its influence estimate. Social sentiment towers over the fundamentals.
2. Suspect the hype drove it. Flip the **✕** on `social-sentiment` to ignore it.
3. Tap **Re-run without 1 source**. The desk re-runs the agent *for real* on the server (`POST /rerun` → `rerunWithoutSources({ checkBaseline: true })`), minus that one source.
4. Watch **BUY become HOLD** — shown side by side, with the causal verdict: *"Proven by re-run: removing it changed the answer."*

A **scenario switcher** offers a second drill — career advice (skills assessment / market salaries / trending titles), where the trending-titles hype drives a PIVOT and ignoring it flips the advice to STAY. Same honesty throughout: the scores are labelled a proxy (clues, not proof), the run's honesty flags ride along as plain chips, and only the re-run earns the word *causal*. Ignoring a fundamentals source instead (quarterly results) leaves the call unchanged — the contrast that shows a score alone never convicts.

**Cost: $0.** Everything is a mock provider with a mock embedder — no API keys, no network, offline and deterministic. Opened as a static file (no server), the Re-run button degrades honestly: it tells you it needs the local server rather than pretending to re-run.

### 7 — The chat desk (conversation)

Transparency where people actually meet an agent: inside the chat — a clean, mainstream chat surface (a single centered conversation column with a fixed composer). A financial-advisor bot answers over three context sources; under every reply sits a quiet "visible reason" button. Tap it and a panel slides in from the right (a full overlay on narrow screens) reading that reply's influence as a ranked bar list — the sources that fed it, highest-scoring first, each with an inline ignore control, over a real `localizeContextBug` on that turn's recording; a strategy dropdown swaps the ranking. Flip a source to ignore it and Re-run: the desk re-runs THAT TURN for real — same recorded conversation up to that point, minus the source — and the counterfactual appears as a clearly-labeled what-if bubble next to the original ("without social media sentiment, I would have said: HOLD…"), with the causal-verdict chip. "Continue from this version" forks the conversation forward from the what-if as a new recorded session; the original transcript stays whole. The default mode runs a scripted 3-turn conversation and proves the whole loop deterministically: the turn-2 flip AND the fork's turn-3 divergence (ADD in the original, KEEP in the fork).

```
=== SUMMARY ===
scripted conversation: 3 turns (financial advisor, mock provider)
turn 1 top influence: social-sentiment [injection] score 0.838
turn 2 top influence: social-sentiment [injection] score 0.881
turn 3 top influence: social-sentiment [injection] score 0.807
turn 2 original reply: BUY — bullish social momentum: the EXTREMELY bullish sentiment trending across forums is a strong BUY signal.
turn 2 ignored source: social-sentiment
turn 2 what-if reply: HOLD — no catalyst beyond fair value: revenue up 4% as guided, insider activity steady, nothing driving a move.
turn 2 flipped: true
turn 2 verdict: confirmed
fork: continued from the turn-2 what-if (social-sentiment stays ignored)
turn 3 in the original conversation: ADD — momentum supports adding: the desk is already long on a BUY call, lift allocation by 5%.
turn 3 in the fork: KEEP — allocation unchanged: the desk is on HOLD, there is no catalyst to add exposure.
fork continuation proof (replies diverge): true
=== END ===
```

```sh
npm run example:7      # default mode — the gated, byte-stable summary
npm run chat-desk      # serve the chat on http://localhost:4174
npm run chat-desk:live # the same desk against the real Anthropic API (needs .env)
```

**BRANCH, NEVER REWRITE.** The original reply is immutable; a re-run never replaces it — the counterfactual is a separate, clearly-labeled what-if bubble, and a fork is a new recorded session (the original transcript stays whole). The verdict chip renders only when `checkBaseline: true` earned it; scores suggest, re-runs convict. Opened as a static file the recorded story renders read-only and every interactive control states what it needs and does nothing else — nothing is ever faked.

### Live mode — real data behind the desk

`npm run chat-desk:live` swaps the mock for the real Anthropic API (Haiku); the key is read from `.env` and never printed. In live mode the three context sources are **fetched for real** (keyless, `node` fetch, ~4s timeout each) instead of scripted:

- **quarterly-results** — SEC EDGAR (`data.sec.gov` company-facts; ticker→CIK via `www.sec.gov/files/company_tickers.json`, cached per process) → the latest reported revenue for the period, as one plain sentence.
- **insider-activity** — SEC EDGAR submissions → the count of Form 4 (insider) filings in the last 90 days plus the most-recent date (the count carries its own window so it can't read as an unbounded multi-year "spike").
- **social-sentiment** — a keyless Reddit JSON search over `r/stocks+wallstreetbets` → post count + latest title. (Reddit commonly 403/429s unauthenticated traffic; when it does, this source falls back — see below.)

The ticker is parsed from your message (`$NVDA`, or a known company name; default **NVDA**), and the bot's system prompt notes the active ticker. Every tool result ends with its own **provenance label** — ` [source: live — SEC EDGAR]` or ` [source: synthetic fallback — <reason>]` — so the influence panel's snippet shows exactly where each figure came from. A turn that mixes live and fallback sources is fine; each source is labeled independently. When a source cannot be fetched, a realistic **labeled** synthetic figure is used instead of any scripted test string, and the chat keeps working. The page header shows the active ticker and a per-tool provenance legend (live/fallback dots).

**Frozen-world re-runs (the honesty keystone).** When you ignore a source and Re-run in live mode, the desk does **not** re-fetch. It replays the exact tool outputs recorded on the original turn — *same world, minus the ignored source* — and only the LLM calls stay real. The what-if bubble is labeled *"(world frozen at the original run)"*, and the server logs `[frozen-world] … external tool fetches during re-run = 0, live LLM calls = N` so the guarantee is auditable. This keeps a counterfactual honest: the answer can only move because a source was removed, never because the market data drifted between runs.

**Cost.** Each reply ≈ 1 Haiku call; a baseline-checked Re-run ≈ up to ~8 small Haiku calls (ablated + baseline samples); forking costs nothing until you chat in it. Offline drill: set `CHATDESK_FORCE_FALLBACK=1` to force every fetcher to fail — all three sources fall back (labeled) and the chat still works.

### 8 — The app gallery (three apps, one machine)

The same machine, three products. A cards landing page opens onto a **stock desk** ("BUY or HOLD $NVDA?"), a **movie desk** ("should I watch *Heat* tonight?") and a **trip advisor** ("should I hike Mission Peak on Saturday?") — all sharing one copy of 07's visible-reason machine, parameterized by a small app pack.

The step past 07 is where the context comes from. An app's sources are no longer facts the host pins into the prompt: they are **MCP tools the agent calls**. One small local MCP server (`08-app-gallery/mcp-server.js`, official `@modelcontextprotocol/sdk`, stdio) hosts every live fetcher; agentfootprint's `mcpClient` turns them into agent tools; a thin host decorator adds per-turn memoization, labeled fallbacks and a dispatch counter. Default mode swaps in `mockMcpClient` — same code path, no subprocess, no network, byte-stable.

Every tool sentence carries its own provenance label, and the trip advisor's `crowd_level` is **synthetic by construction**: it never fetches anything, in any mode, and always says `[source: synthetic — modeled crowd estimate, not measured]`. A source that says what it is.

Tap "visible reason" under any reply, flip a source off, and Re-run: the turn re-runs over the **frozen** tool results of the original turn — 0 new fetches, and the dispatch counter prints the proof — and the counterfactual appears beside the original with its causal verdict. "Continue from this version" forks the conversation forward. Branch, never rewrite.

```
=== SUMMARY ===
the app gallery: 3 apps, one scripted turn each (mock provider, mock MCP tools)
[stocks] Q: Should we BUY or HOLD $NVDA?
[stocks] reply: BUY — bullish social momentum: the EXTREMELY bullish sentiment trending across forums is a strong BUY signal.
[stocks] top influence: social_sentiment [tool] score 0.791
[movies] Q: Should I watch "Heat" tonight?
[movies] reply: WATCH — near-universal acclaim outweighs the rental price.
[movies] top influence: wiki_reception [tool] score 0.659
[trip] Q: Should I hike Mission Peak on Saturday?
[trip] reply: GO — Saturday looks clear with a high near 71°F and only a 5% chance of rain.
[trip] top influence: weather_forecast [tool] score 0.736
[movies] ignored source: wiki_reception
[movies] what-if reply: SKIP — mixed signals: price is fine but nothing here says tonight is the night.
[movies] flipped: true
[movies] verdict: confirmed
=== END ===
```

```sh
npm run example:8      # scripted run, no network, no key — the verified summary
npm run gallery        # cards page + all three desks on http://localhost:4175 (mock, no key)
npm run gallery:live   # real Anthropic (haiku) + real keyless APIs over MCP (needs .env)
GALLERY_FORCE_FALLBACK=1 npm run gallery:live   # offline drill: every source falls back, labeled
```

**Live sources, all keyless.** The movie desk reads iTunes Search (price, availability, advisory rating — commerce facts, never critic scores) and Wikipedia (plot + the Reception section, resolved through Wikipedia's search API so "Heat" lands on the 1995 film and not on thermodynamics). The trip advisor reads Open-Meteo (geocode → 7-day forecast → the next Saturday) and Wikipedia; its crowd estimate stays synthetic. The stock desk reuses 06/07's SEC EDGAR + Reddit fetchers — note that SEC's fair-access policy wants a contact **email** in the User-Agent, so out of the box those two tools return a labeled fallback; set `SEC_CONTACT=you@example.com` to make them live. Reddit 403s unauthenticated traffic and falls back too. Nothing is ever faked: a source that could not be fetched says so in its own sentence.

**What the live model does with its tools is its own business.** The agent decides which tools to consult; a tool it skipped shows in the legend as "not consulted" rather than being invented. And a live re-run can honestly come back **not-confirmed** — the real model sometimes keeps its answer without the source you suspected. Scores suggest; re-runs convict.

## Try it with your own key (BYOK)

The app gallery has a bring-your-own-key page: paste your Anthropic API key and
chat with the trip advisor and the movie desk — visible reasons, verified
what-if re-runs and forks included — with everything running in your browser.

**Your key stays in your tab.** Every Claude call goes straight from your
browser to `api.anthropic.com` (agentfootprint's browser provider); the tools
are keyless public APIs (Open-Meteo, Wikipedia, iTunes) called from your
browser too. There is no backend: the page is a plain static file, so there is
no server code that *could* see your key. Verify it yourself in DevTools →
Network — the only requests carrying your key go to `api.anthropic.com`.

```sh
npm run byok        # generate 08-app-gallery/out/byok/ and serve it on :4176
```

The folder is fully static — any file server works the same:

```sh
npm run byok:build
python3 -m http.server 4176 -d 08-app-gallery/out/byok
```

(A double-clicked `file://` page won't load ES modules — that's a browser
platform rule; use any dumb file server, including GitHub Pages.)

Your key is kept in a page variable only. Tick "remember my key in this tab"
and it is kept in `sessionStorage` until the tab closes; "Forget my key"
erases it instantly. It is never sent to us, never logged, never in a URL.
`npm run verify:byok` re-generates the page and asserts all of that.

Honest scope: two desks, not three. The SEC's servers don't allow browser
calls, so the stock desk runs only in the server demo (`npm run gallery:live`).
Each reply spends a handful of small Haiku calls on your key; re-runs replay
the original turn's frozen tool results — zero new fetches.

## Citing

To cite the paper:

```bibtex
@inproceedings{anbalagan2026visible,
  author    = {Anbalagan, Sanjay Krishna and Nie, Xinrui and Kommalapati, Anughna and Kanamarlapudi, Vijay Kumar and Radhakrishnan, Sreekanth and Zhao, Xiaodan and Mohan, Umesh},
  title     = {Visible Reasoning: User-Facing Decision Transparency for Generative {AI} Systems},
  booktitle = {Artificial Intelligence in {HCI} ({HCII} 2026)},
  series    = {Lecture Notes in Computer Science},
  volume    = {16745},
  pages     = {3--21},
  publisher = {Springer, Cham},
  year      = {2026},
  doi       = {10.1007/978-3-032-30849-8_1}
}
```

If you use these libraries in research, please cite the software:

```bibtex
@software{footprintjs,
  author  = {Anbalagan, Sanjay Krishna},
  title   = {footprintjs: A self-explaining flowchart engine},
  year    = {2024},
  url     = {https://github.com/footprintjs/footPrint},
  license = {MIT}
}

@software{agentfootprint,
  author  = {Anbalagan, Sanjay Krishna},
  title   = {agentfootprint: Observable, explainable AI agents},
  year    = {2025},
  url     = {https://github.com/footprintjs/agentfootprint},
  license = {MIT}
}
```

The companion publication is the HCII 2026 paper above; its citation is available at the DOI: [10.1007/978-3-032-30849-8_1](https://doi.org/10.1007/978-3-032-30849-8_1).

## License

MIT. Part of the footprintjs ecosystem — see the map at [footprintjs.github.io](https://footprintjs.github.io/).
