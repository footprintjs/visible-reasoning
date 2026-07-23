# Visible Reasoning — runnable reference implementations

Five small, self-contained examples that demonstrate the paper *Visible Reasoning: User-Facing Decision Transparency for Generative AI Systems*. Each one runs a real pipeline, records it, and shows the paper's third transparency paradigm — **recorded decision evidence**, where the execution substrate owns the trace instead of a model narrating itself. Every example is one `run.js`, costs nothing to run (mock providers only, no API keys), and prints a stable summary checked against an `expected-output.txt`.

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

`npm run all` runs all five examples and byte-diffs each printed `=== SUMMARY ===` block against that example's `expected-output.txt`, exiting non-zero on any drift (also available alone as `npm run verify`).

Or run a single example:

```sh
npm run example:1   # 01-substrate-owns-the-trace
npm run example:2   # 02-one-recording-three-readers
npm run example:3   # 03-user-facing-why
npm run example:4   # 04-honest-absence
npm run example:5   # 05-prove-by-replay
```

## The map

| Paper claim | Example directory | What you will see |
|---|---|---|
| 1. The substrate owns the trace | `01-substrate-owns-the-trace` | A decider run reconstructed entirely from the snapshot — commit log + engine-recorded decision evidence, no model asked to explain. |
| 2. One recording, three readers | `02-one-recording-three-readers` | One agent run consumed three ways — human narrative, a cheap mock model answering "why?" from the trace, and a training-data export — zero re-runs. |
| 3. User-facing "why" | `03-user-facing-why` | A real run emits a self-contained `out/replay.html` an end user can scrub beat-by-beat to see the why-this-tool evidence. |
| 4. Honest absence | `04-honest-absence` | Two values in one run: one proven back to its origin, one honestly flagged `CANNOT PROVE` because its input (env) was untracked. |
| 5. Prove by replay | `05-prove-by-replay` | A wrong answer localized to the context that caused it, then confirmed counterfactually by rerunning with that piece ablated. |

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

A mock-provider agent (WeatherBot, two tools) runs, the framework records it as a typed agentthinkingui trace, and the generator emits a self-contained `out/replay.html` that inlines React + the ATUI player + that exact recorded trace. An end user can scrub the run beat-by-beat offline. The demo data is produced by the run, never hand-authored.

```
=== SUMMARY ===
trace beats: 4
beat kinds: prompt -> ask -> return -> answer
tools considered: 2 (clock, weather)
tool asked: weather
file emitted: 03-user-facing-why/out/replay.html
size bucket: 256KB-1MB
html has embedded trace JSON: yes
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
