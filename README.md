# Visible Reasoning — runnable reference implementations

Runnable reference implementations of the ideas in the published paper *Visible Reasoning: User-Facing Decision Transparency for Generative AI Systems*, built on open-source TypeScript libraries. Eight self-contained examples, each behind a single `run.js`, each printing a summary that is byte-checked against a recorded `expected-output.txt`.

The idea the paper argues for is **recorded decision evidence**: instead of asking a model to narrate itself (chain-of-thought, unverifiable) or asking a second model to judge it (recursive trust), the execution substrate owns the trace. Every decision is a typed event, and humans, cheaper models and training pipelines all read the same recording.

## Try it online

**→ [footprintjs.github.io/visible-reasoning](https://footprintjs.github.io/visible-reasoning/)**

Two of the desks — trip advisor and movie desk — running on real keyless data (Open-Meteo, Wikipedia, iTunes). Bring your own Anthropic key: **it runs entirely in your browser.** Your key goes only to `api.anthropic.com`; the site's host (GitHub Pages) serves static files and has no backend that *could* receive it. Open DevTools → Network and check. (The stock desk gets a card too, disabled — the SEC's servers don't allow browser calls, and the card says so rather than pretending.)

## Run everything locally

Free, no API keys — every example uses mock providers.

```sh
git clone https://github.com/footprintjs/visible-reasoning.git
cd visible-reasoning
npm install
npm run all
```

`npm run all` runs all eight examples and byte-diffs each printed `=== SUMMARY ===` block against that example's `expected-output.txt`, exiting non-zero on any drift. Same thing as `npm run verify` — see [verify.js](verify.js). Each example's own run command is in its section below.

**Optional live act.** [live/run.js](live/run.js) tells the same story against the real Anthropic API: a two-tool agent, one task that forces a tool choice, recorded and then explained from its own trace. It is left out of `npm run all` because a real model's wording varies run to run.

```sh
cp .env.example .env   # paste your Anthropic key into .env
npm run live           # about two small Haiku calls; requires Node 20.6+ (--env-file)
```

## The paper

Anbalagan, S. K., Nie, X., Kommalapati, A., Kanamarlapudi, V. K., Radhakrishnan, S., Zhao, X., & Mohan, U. (2026). Visible Reasoning: User-Facing Decision Transparency for Generative AI Systems. In *Artificial Intelligence in HCI (HCII 2026)*, Lecture Notes in Computer Science vol. 16745, pp. 3–21. Springer, Cham. https://doi.org/10.1007/978-3-032-30849-8_1

The ideas in this repository were developed with those co-authors and published in that paper. The paper states the argument; this repository makes it runnable.

*This repository is an independent, personal open-source project. It is built on the author's own MIT-licensed libraries and is not affiliated with, sponsored by, or endorsed by any employer.*

## The examples

### 1 — The substrate owns the trace

**What it shows:** the paper's core move — a decider run's entire "why" reconstructed from the engine's own record (commit log + typed decision evidence), with no model asked to explain anything.

**Run it:** `npm run example:1`

**Use it in your project:**
1. Install: `npm install footprintjs`
2. Record a decision with `decide()`, then read the evidence off the snapshot:

```js
import { flowChart, decide, FlowChartExecutor } from 'footprintjs';

const chart = flowChart('Intake', (s) => { s.severity = 8; }, 'intake')
  .addDeciderFunction('Route', (s) => decide(s, [
      { when: { severity: { gt: 5 } }, then: 'urgent', label: 'Severity above 5' },
    ], 'normal'), 'route')
    .addFunctionBranch('urgent', 'Escalate', (s) => { s.lane = 'Human escalation'; })
    .addFunctionBranch('normal', 'AutoResolve', (s) => { s.lane = 'Auto-resolved'; })
    .setDefault('normal').end()
  .build();
const executor = new FlowChartExecutor(chart);
executor.attachCombinedRecorder({ id: 'why', onDecision: (e) => console.log(e.evidence.rules) });
await executor.run();
const { commitLog } = executor.getSnapshot();   // one typed bundle per executed stage
```

**Code:** [01-substrate-owns-the-trace/run.js](01-substrate-owns-the-trace/run.js)

### 2 — One recording, three readers

**What it shows:** the paper's claim that one recording serves every audience — a human narrative, a cheap model answering "why?" from the trace alone, and a training-data export, all from one `agent.run()` with zero re-runs.

**Run it:** `npm run example:2`

**Use it in your project:**
1. Install: `npm install agentfootprint`
2. Run the agent once, keep the snapshot and the typed event stream, then read them three ways:

```js
import { Agent } from 'agentfootprint';
import { assembleTrajectory, traceDebugAgent } from 'agentfootprint/observe';

const events = [];
agent.on('*', (e) => events.push(e));            // the substrate emits typed events
await agent.run({ message: 'Weather in Paris?' });
const snapshot = agent.getLastSnapshot();        // THE recording

const narrative = agent.getLastNarrativeEntries();                          // reader 1: human
const triage = traceDebugAgent({ artifacts: { snapshot }, provider, model }); // reader 2: cheap model
await triage.run({ message: 'Why did the agent choose that tool?' });
const trajectory = assembleTrajectory({ snapshot, events });                // reader 3: training data
```

**Code:** [02-one-recording-three-readers/run.js](02-one-recording-three-readers/run.js)

### 3 — User-facing "why"

**What it shows:** the paper's user-facing end — a real run emits a self-contained page an end user can scrub beat-by-beat and tap for a "why this answer" board, with the chain computed from the recording, not hand-authored.

**Run it:** `npm run example:3`

**Use it in your project:**
1. Install: `npm install agentfootprint agentthinkingui` (agentthinkingui declares `react` / `react-dom` as peers; npm installs them alongside, and the generator inlines them into the page)
2. Record the run as a UI trace and compute the why-chain from that same recording:

```js
import { agentThinkingTrace } from 'agentfootprint/observe';
import { mockEmbedder } from 'agentfootprint/memory';
import { embeddingCache, llmCallIdsFromEvents, localizeContextBug, toBacktrackTrace } from 'agentfootprint/debug';

const att = agentThinkingTrace({ agent: 'WeatherBot', model: 'mock-1', asker: 'You' });
const agent = Agent.create({ provider, model: 'mock-1' }).tool(weather).recorder(att).build();
const out = await agent.run({ message: 'Weather in Paris?' });
const llmIds = llmCallIdsFromEvents(events);
const report = await localizeContextBug({
  artifacts: { snapshot: agent.getLastSnapshot(), events },
  embedder: embeddingCache(mockEmbedder()),
  atStep: llmIds[llmIds.length - 1],             // the answering call = root of the slice
});
const trace = att.getTrace();                    // → <AgentThinkingUI trace={...} />
const backtrack = toBacktrackTrace(report, {     // → <BacktrackOverlay trace={...} />
  answer: { text: out.content, label: 'WeatherBot answer' },  // required — the report has no output text
  claim: 'Why this answer?',
});
```

3. The run writes `03-user-facing-why/out/replay.html` — a self-contained page (inlined React + the ATUI UMD + the embedded trace). Open it in a browser; no server, no network.

**Code:** [03-user-facing-why/run.js](03-user-facing-why/run.js)

### 4 — Honest absence

**What it shows:** the paper's honesty requirement — the same query layer returns PROVEN for a value it can trace to its origin and CANNOT PROVE for one whose input it could not see, instead of inventing the edge.

**Run it:** `npm run example:4`

**Use it in your project:**
1. Install: `npm install footprintjs`
2. Slice backward from a variable and read the honesty markers the slice carries:

```js
import { FlowChartExecutor } from 'footprintjs';
import { sliceForKey, keysReadFromExecutionTree, formatSlice } from 'footprintjs/trace';

const executor = new FlowChartExecutor(chart);
await executor.run({ env: { riskThreshold: 80 } });
const snap = executor.getSnapshot();
const reads = keysReadFromExecutionTree(snap.executionTree);

const slice = sliceForKey(snap.commitLog, 'tier', reads);
console.log(formatSlice(slice));          // the safe renderer — never JSON.stringify a slice root
// slice.root.parentEdges     → the causal chain, one hop per tracked read
// node.incompleteSources     → the inputs the trace could NOT see (here: 'env')
```

**Code:** [04-honest-absence/run.js](04-honest-absence/run.js)

### 5 — Prove by replay

**What it shows:** the paper's causal claim — a wrong answer localized to the one piece of context that caused it, then confirmed by rerunning with that piece ablated. The verdict comes from the replay, not from asking a model.

**Run it:** `npm run example:5`

**Use it in your project:**
1. Install: `npm install agentfootprint`
2. Give the localizer a runner it can re-drive with suspects removed, and let it convict:

```js
import { applyAblations, embeddingCache, llmCallIdsFromEvents, localizeContextBug } from 'agentfootprint/observe';
import { mockEmbedder } from 'agentfootprint/memory';

async function runAgent(ablations = []) {
  const { injections } = applyAblations(ablations, { tools: [], injections: [PLANTED, BENIGN] });
  /* build a FRESH agent from `injections`, run it, tap its events */
  return { content, snapshot: agent.getLastSnapshot(), events };
}
const original = await runAgent();
const llmIds = llmCallIdsFromEvents(original.events);
const report = await localizeContextBug({
  artifacts: { snapshot: original.snapshot, events: original.events },
  embedder: embeddingCache(mockEmbedder()),
  atStep: llmIds[llmIds.length - 1],
  rerun: {                                     // supplying `rerun` upgrades mode to 'causal'
    runner: async (specs) => (await runAgent(specs)).content,
    originalOutput: original.content, samples: 3,
    outcomeChanged: (a, b) => a.includes('APPROVED') !== b.includes('APPROVED'),
  },
});
const culprit = report.suspects.find((s) => s.verdict?.verdict === 'confirmed');
```

**Code:** [05-prove-by-replay/run.js](05-prove-by-replay/run.js)

### 6 — The stock desk (interactive)

**What it shows:** the paper's finale made tap-able — an influence map a non-technical person can drive: suspect a source, ignore it, re-run the agent for real, and watch BUY become HOLD. Scores suggest; the re-run convicts.

**Run it:**

```sh
npm run example:6                           # default mode — the byte-stable summary
node 06-stock-desk/run.js --scenario career # the career-advice variant
npm run stock-desk                          # generate out/desk.html and serve it on :4173
```

Then open **http://localhost:4173**: see the influence map, flip the **✕** on `social-sentiment`, tap **Re-run without 1 source** (a `POST /rerun` that re-runs the agent on the server), and watch the call flip with the causal verdict. Ignoring a fundamentals source instead leaves the call unchanged — the contrast that shows a score alone never convicts. Cost: $0, mock provider and mock embedder, offline and deterministic. Opened as a plain file (no server) the Re-run button says it needs the local server rather than pretending.

**Use it in your project:**
1. Install: `npm install agentfootprint`
2. Rank the sources, expose them as toggles, and ablate-and-rerun the ones the user flips:

```js
import { listInfluenceStrategies, localizeContextBug, removableSources,
         rerunWithoutSources, semanticAlignmentStrategy } from 'agentfootprint/debug';

const report = await localizeContextBug({ artifacts, embedder, atStep, scorer: semanticAlignmentStrategy });
const sources = removableSources(report);      // [{ id, kind, label, source, stageName, score }]

const result = await rerunWithoutSources({
  report, ignore: ['social-sentiment'], embedder,
  runner: async (specs) => (await runScenario(sc, specs)).content,
  originalAnswer: original.content,
  answerChanged: (a, b) => a.includes('BUY') !== b.includes('BUY'),
  checkBaseline: true,                         // only this earns `result.verdict`
});
// result.answer · result.whatChanged.answerFlipped · result.verdict.verdict
```

3. Serve it: the example renders `sources` into agentthinkingui's `InfluenceMap` and wires the toggle to a `POST /rerun` that calls the block above. `listInfluenceStrategies()` supplies the strategy dropdown.

**Code:** [06-stock-desk/run.js](06-stock-desk/run.js)

### 7 — The chat desk (conversation)

**What it shows:** the paper's transparency where people actually meet an agent — inside the chat. Every reply carries a "visible reason" panel; a re-run appears as a labeled what-if bubble *beside* the untouched original, and "continue from this version" forks the conversation forward. Branch, never rewrite.

**Run it:**

```sh
npm run example:7      # default mode — a scripted 3-turn conversation, byte-stable summary
npm run chat-desk      # serve the chat on http://localhost:4174
npm run chat-desk:live # the same desk against the real Anthropic API (needs .env)
```

**Use it in your project:**
1. Install: `npm install agentfootprint`
2. Let `recordedChat` own the transcript and the per-turn recording; you keep only the agent factory:

```js
import { recordedChat, removableSources, semanticAlignmentStrategy } from 'agentfootprint/debug';

// makeAgent({ specs }) → a FRESH agent with those ablations applied at construction
const chat = recordedChat({ makeAgent, format: { assistantLabel: 'Advisor' } });

await chat.send('Should we BUY or HOLD?');              // turn 0 — bytes, snapshot, events frozen
const report = await chat.reason(0, { embedder, scorer: semanticAlignmentStrategy }); // memoized
const sources = removableSources(report);               // the panel's ranked ignore list

const result = await chat.rerunTurn(0, {                // replays turn 0 minus one source
  ignore: ['social-sentiment'], embedder, checkBaseline: true, samples: 3,
  answerChanged: decisionChanged,                       // your comparator: did the decision change?
});
const forked = chat.fork(0, { fromRerun: result });     // identity-checked; original stays whole
```

3. Live mode swaps the mock for `anthropic()` and fetches the three context sources for real (SEC EDGAR, Reddit — keyless, ~4s timeout, each result carrying its own `[source: live …]` or `[source: synthetic fallback …]` label). **Re-runs do not re-fetch:** the desk replays the exact tool outputs recorded on the original turn — same world, minus the ignored source — and logs `[frozen-world] … external tool fetches during re-run = 0` so the guarantee is auditable. Offline drill: `CHATDESK_FORCE_FALLBACK=1` forces every fetcher to fail; all three sources fall back, labeled, and the chat keeps working.

**Code:** [07-chat-desk/run.js](07-chat-desk/run.js)

### 8 — The app gallery (three apps, one machine)

**What it shows:** the same visible-reason machine across three products — stocks, movies, trips — with every context source served as an **MCP tool the agent calls** and labeled with its own provenance (live, synthetic fallback, or always-synthetic).

**Run it:**

```sh
npm run example:8      # one scripted turn per app on mock MCP tools — the verified summary
npm run gallery        # cards page + all three desks on http://localhost:4175 (mock, no key)
npm run gallery:live   # real Anthropic (haiku) + real keyless APIs over MCP (needs .env)
GALLERY_FORCE_FALLBACK=1 npm run gallery:live   # offline drill: every source falls back, labeled
```

**Use it in your project:**
1. Install: `npm install agentfootprint @modelcontextprotocol/sdk`
2. Serve your context sources from an MCP server and hand the resulting tools to the agent:

```js
import { mcpClient, mockMcpClient } from 'agentfootprint/tool-providers';

const client = await mcpClient({                 // --live: one local stdio subprocess
  name: 'gallery-tools',
  transport: { transport: 'stdio', command: process.execPath, args: ['./mcp-server.js'] },
});
const tools = await client.tools();              // [{ schema, execute }]
const agent = Agent.create({ provider, model }).system(system).tools(tools).build();

// default / offline: same code path, no subprocess, no network
const mockClient = mockMcpClient({
  name: 'gallery-tools',
  tools: [{ name, description, inputSchema, handler: (args) => scripted(args) }],
});
```

3. Wrap each tool so a re-run replays the original turn's bytes instead of re-fetching — the decorator in [08-app-gallery/lib/mcp.js](08-app-gallery/lib/mcp.js) memoizes per turn, turns a failed fetch into a normal labeled sentence, and counts dispatches so `metrics.toolDispatches` proves a re-run made zero new calls. The MCP server itself is [08-app-gallery/mcp-server.js](08-app-gallery/mcp-server.js); the shared machine lifted out of 07 is [08-app-gallery/lib/chat-core.js](08-app-gallery/lib/chat-core.js).

Live sources are all keyless: iTunes Search and Wikipedia (movies), Open-Meteo and Wikipedia (trips), SEC EDGAR and Reddit (stocks). SEC's fair-access policy wants a contact email in the User-Agent, so out of the box those two return a labeled fallback — set `SEC_CONTACT=you@example.com` to make them live. The trip advisor's `crowd_level` is synthetic by construction: it never fetches anything, in any mode, and always says so.

**Code:** [08-app-gallery/run.js](08-app-gallery/run.js)

## Running the demo live

The **movie desk on the local server build** is the one to present. Its three sources — iTunes Search, Wikipedia plot, Wikipedia reception — are all real, all keyless, all CORS-free, and all reachable without a contact header, so a good turn shows three genuinely live sources and a three-row influence map.

```sh
npm run gallery:live      # needs .env with ANTHROPIC_API_KEY
```

Then open **http://localhost:4175/app/movies** (the cards page at `/` links to it).

Nothing has to be typed on stage: the desk's own starter questions are buttons. They sit under the empty state as large pills, and once the conversation has started the same two stay as a quiet row just above the box. They are the pack's `starters` — both films resolve on all three sources:

- `Should I watch "Interstellar" tonight?`
- `Is "Dune" worth renting?`

### What to click, in order

| # | Click | What it demonstrates |
|---|---|---|
| 1 | **a starter pill** (or type and **Send** — same path) | The agent picks its own sources. Watch the status line name each tool as it is consulted; the legend under the reply shows one dot per source with its verbatim `[source: …]` tail. Three green "live" dots = three real APIs answered. |
| 2 | **Visible reason** | The influence map: three rows, one per source, ranked by semantic alignment. This is read off the run's own recording, not asked of the model. |
| 3 | **Ignore this source** on the top row | States the counterfactual: "what would it have said without the source it leaned on most?" |
| 4 | **Re-run without …** | Re-runs the same turn over the *frozen* tool results, minus that one. The server log prints `MCP tool dispatches during re-run = 0` — the world did not move, only the context changed. Whether the verdict flips is the honest part: `confirmed` means the source caused the answer, `not-confirmed` means it did not. |
| 5 | **Continue from this version** | Forks the conversation at that turn with the source permanently removed. The original is untouched; the two branches diverge from here. |
| 6 | **debug** (bottom-right) | "What actually happened", in three views over the same recorded turn. **story** — agentthinkingui's player, over a trace agentfootprint's own recorder built from the turn's events; it rode in with the reply. **flowchart** — `Lens`, the agent debugger [agentfootprint-lens](https://www.npmjs.com/package/agentfootprint-lens) ships: the composition graph the run was built from, the run summary, the event stream. **inspector** — `ExplainableShell`, [footprintjs's own inspector](https://www.npmjs.com/package/footprint-explainable-ui): 41 stages on a timeline, a transport to step through them, and the memory state each one left. The last two are the ecosystem's real developer tools, unmodified; they load only when opened, and they read this turn's frozen recording — no model call, no fetch off this site. |

Step 4 is the claim the whole repo exists to support, and step 6 is the receipt.

### Honest caveats

- **If a source falls back on venue wifi.** A fallback is not a failure — it is the exhibit. The dot turns hollow and the legend says exactly why (`synthetic fallback — HTTP 404`, `— fetch failed`), and the reply is still made from what *did* arrive. Say that out loud and carry on; the influence map still ranks the sources that answered. If you would rather rehearse it deliberately, `GALLERY_FORCE_FALLBACK=1 npm run gallery:live` makes every fetcher fail, labeled.
- **Pick a film the iTunes catalog actually has.** Apple's public Search API covers movies unevenly — `media=movie` returns nothing at all today, and the unfiltered search misses plenty of major titles (`Blade Runner 2049`, `The Matrix`, `Top Gun: Maverick` all come back empty). When it has no match, `itunes_lookup` says so and falls back rather than substituting a lookalike. `Interstellar`, `Dune`, `Dune: Part Two`, `Jaws`, `Barbie` and `Nope` were all verified live on all three sources; a title you have not rehearsed may not be.
- **The BYOK build has no MCP.** `npm run byok` produces a static browser bundle where the tools are called directly from the tab — same tool sentences, same provenance labels, but no MCP server and no stdio protocol, because a browser cannot spawn a subprocess. Only `npm run gallery:live` is the real-MCP demo. The BYOK bundle also carries two desks, not three (the SEC blocks browser calls, so the stock desk is server-only).
- **The trip advisor's `crowd_level` is synthetic on purpose** and says so in every mode. If someone asks whether any source is fake, that one is — by construction, and it is labeled `synthetic — modeled crowd estimate, not measured` rather than dressed up as real.

## The libraries

| Library | One job | npm |
|---|---|---|
| footprintjs | Self-explaining flowchart engine: the substrate records every stage, decision and write as typed events. | [npmjs.com/package/footprintjs](https://www.npmjs.com/package/footprintjs) |
| agentfootprint | Observable, explainable AI agents on that engine — recordings, influence localization, ablate-and-rerun, MCP tools. | [npmjs.com/package/agentfootprint](https://www.npmjs.com/package/agentfootprint) |
| agentthinkingui | React components that render a recording for an end user — the scrubbable player, influence map and backtrack overlay. | [npmjs.com/package/agentthinkingui](https://www.npmjs.com/package/agentthinkingui) |
| hcifootprint | The fourth library in the same family — a declarative skill graph for front ends. Not used by these examples. | [npmjs.com/package/hcifootprint](https://www.npmjs.com/package/hcifootprint) |

## Bring your own key (hosted or local)

The app gallery has a bring-your-own-key bundle: a gallery home (`index.html`) whose cards open one page per desk (`trip.html`, `movies.html`). Paste your Anthropic key on the desk you picked and chat — visible reasons, verified what-if re-runs and forks included — with everything running in your browser. Every link is relative, so the same folder is correct at `/visible-reasoning/`, at a domain root, or off a local file server.

```sh
npm run byok         # generate 08-app-gallery/out/byok/ and serve it on :4176
npm run byok:build   # generate only — any file server works
python3 -m http.server 4176 -d 08-app-gallery/out/byok
```

(A double-clicked `file://` page won't load ES modules — that's a browser platform rule; use any dumb file server, including GitHub Pages.)

**Your key stays in your tab.**  Every Claude call goes straight from your browser to `api.anthropic.com` (agentfootprint's browser provider); the tools are keyless public APIs called from your browser too. There is no backend, so there is no server code that *could* see your key. It is kept in a page variable only; tick "remember my key in this tab" and it lives in `sessionStorage` until the tab closes (which is also what carries it back through the gallery into the other desk). "Forget my key" erases it instantly. It is never sent to us, never logged, never in a URL — `npm run verify:byok` re-generates the bundle and asserts all of that, on every page that can hold a key.

Honest scope: two desks, not three. The SEC's servers don't allow browser calls, so the stock desk runs only in the server demo (`npm run gallery:live`). Each reply spends a handful of small Haiku calls on your key; re-runs replay the original turn's frozen tool results — zero new fetches.

### Publishing the hosted copy

```sh
npm run byok:publish   # regenerate + stage into .gh-pages-staging/ (gitignored)
```

It writes the generated folder plus `.nojekyll` (GitHub Pages otherwise runs Jekyll, which silently drops every path starting with `_` — a hazard in a vendored dist tree we don't control) and a `404.html` that redirects to `./`. Then it prints the `git worktree` commands that push the staged folder to an orphan `gh-pages` branch, which keeps the artifact out of `main`. Nothing in the page assumes an origin or a base path.

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

## License

MIT. Part of the footprintjs ecosystem — see the map at [footprintjs.github.io](https://footprintjs.github.io/).
