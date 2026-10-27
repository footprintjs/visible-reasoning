# Run a public example and cite the paper

## Reading and citation

- [Free author manuscript on arXiv](https://arxiv.org/abs/2610.35483)
- [Published HCII 2026 chapter](https://doi.org/10.1007/978-3-032-30849-8_1)
- [BibTeX](CITATION.bib) and [machine-readable citation](CITATION.cff)

The published chapter is the preferred paper citation. The arXiv link gives readers free access to the author manuscript.

## Scope of these examples

This public repository contains independent, illustrative implementations related to recorded evidence and user-facing transparency. It uses the author's separately published libraries; its examples and APIs extend beyond the original paper.

The examples below use scripted model replies and a mock embedder. They demonstrate execution capture, evidence inspection and the exclude/rerun interaction. They do **not** reproduce the paper's original Claude 3 Sonnet / Amazon Titan experiment stack, its reported influence scores across the three domains, its counterfactual evaluation table, or its 50-participant formative study. Original participant data and those experimental artifacts are not included.

## Quick start: one recorded question and its evidence

Requirements: Node.js 20.6 or newer and npm. Dependency installation requires access to the npm registry. Running this example afterward uses mock providers and needs no API key.

```sh
git clone https://github.com/footprintjs/visible-reasoning.git
cd visible-reasoning
npm ci
npm run example:3
```

For an exact source snapshot of the checked example, use commit `49dbc1f49596da325609c231949e6462330fc265` before installing dependencies. The lockfile pins the dependency graph.

### Sample input

The input is defined in [03-user-facing-why/run.js](03-user-facing-why/run.js):

- User message: `Weather in Paris?`
- Available tools: `weather` and `clock`
- Mock weather result: `Paris: 72F, sunny`
- Scripted agent response: `It is 72F and sunny in Paris.`

The mock provider selects the weather tool. This is a controlled fixture, not a test of a live model's tool-selection ability.

### What to inspect

The run prints a stable summary and writes `03-user-facing-why/out/replay.html`. Open that file in your browser to inspect the recorded trace and its answer-evidence panel.

The [complete expected output](03-user-facing-why/expected-output.txt) includes:

```text
trace beats: 4
beat kinds: prompt -> ask -> return -> answer
tools considered: 2 (weather, clock)
tool asked: weather
why this answer (computed from the recording by localizeContextBug):
  mode: correlational · suspects ranked: 5 · decided at: call-llm#40
  top influence (path-only upper bound): stage context#6 via systemPromptInjections score 0.836
  tool output that fed it: weather "Paris: 72F, sunny" score 0.491
```

These scores are mock-embedding ranking outputs, not causal contribution percentages or reported paper results. The generated page also carries missing-evidence flags.

## Verify all eight public examples

```sh
npm run all
```

This runs the eight example entry points and compares each stable summary with its checked-in `expected-output.txt`. Timestamps and wall-clock timings are intentionally excluded from the stable summary.

For an interactive exclude/rerun example, run `npm run stock-desk` and open the localhost URL it prints. Its tools, data and model replies are scripted; it is not financial advice or an investment-data service.

Live-provider modes are optional and separate from this verification. They require your own credentials, may incur provider charges, and their text output is not covered by the deterministic fixture comparisons.

## How to cite

Cite the accompanying paper when these examples support your research, and identify the repository commit you actually used. GitHub's **Cite this repository** control uses [CITATION.cff](CITATION.cff); [CITATION.bib](CITATION.bib) provides the published chapter citation and free-reading link.

Do not describe these illustrative examples as a replication of the original participant study or the original Bedrock/Titan experiment results.

