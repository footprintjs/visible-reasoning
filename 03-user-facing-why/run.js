// Claim 3 — USER-FACING WHY (paper §"Recorded Decision Evidence"; HCII 2026).
// A REAL (mock-provider, $0, no-network) agent runs; the framework RECORDS it as
// a typed trace; we emit a self-contained HTML page that replays that recording
// as a scrubbable agentthinkingui story — a non-technical person can step through
// the run AND tap the final answer to see WHY the agent said it. The demo data is
// GENERATED, never hand-authored: agentThinkingTrace() captures the trace produced
// BY the run, and the "why this answer" chain is computed FROM THE RECORDING by the
// real agentfootprint localization machinery (localizeContextBug → toBacktrackTrace).
// If the library cannot prove a link it says so — the honest-absence idiom rides along.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, defineTool } from 'agentfootprint';
import { mock } from 'agentfootprint/llm-providers';
import { mockEmbedder } from 'agentfootprint/memory';
import { agentThinkingTrace } from 'agentfootprint/observe';
import {
  embeddingCache, llmCallIdsFromEvents,
  localizeContextBug, toBacktrackTrace,
} from 'agentfootprint/debug';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// 1. A REAL agent run: two tools in the toolbox (both "considered"); the scripted
//    mock provider drives the ReAct loop to pick ONE.
const weather = defineTool({
  name: 'weather',
  description: 'Get the current weather for a city.',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  execute: async ({ city }) => `${city}: 72F, sunny`,
});
const clock = defineTool({
  name: 'clock',
  description: 'Get the current time.',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => '12:00',
});
const provider = mock({
  replies: [
    { content: 'I should check the live weather.', toolCalls: [{ id: 't1', name: 'weather', args: { city: 'Paris' } }] },
    { content: 'It is 72F and sunny in Paris.' },
  ],
});

// The recorder (attached on the builder, BEFORE build) captures the run AS a
// user-facing trace — a product of traversal, not narration. We ALSO tap the raw
// typed-event stream and keep the snapshot: those are the artifacts the localizer
// slices to compute the "why this answer" chain.
const att = agentThinkingTrace({ agent: 'WeatherBot', model: 'mock-1', asker: 'You' });
const agent = Agent.create({ provider, model: 'mock-1', maxIterations: 3 })
  .system('You answer weather questions using the weather tool.')
  .tool(weather)
  .tool(clock)
  .recorder(att)
  .build();
const events = [];
agent.on('*', (e) => events.push(e));
const out = await agent.run({ message: 'Weather in Paris?' });
const answerText = typeof out === 'object' && out && 'content' in out ? String(out.content) : String(out);

// 2. The recording — exactly the agentthinkingui Trace shape. This is the demo data.
const trace = att.getTrace();
const beats = trace.steps.map((s) => s.kind);                       // prompt -> ask -> return -> answer
const toolsConsidered = trace.steps.find((s) => s.kind === 'ask')?.toolsSeen?.map((t) => t.name) ?? []; // from the recording
const toolAsked = trace.steps.filter((s) => s.kind === 'ask').map((s) => s.tool);

// 3. Compute the WHY-THIS-ANSWER chain FROM THE RECORDING — no hand-authored data.
//    localizeContextBug slices the run backward from the answering LLM call and ranks
//    every context source by an embedding-geometry PROXY (deterministic: mock embedder).
//    No `rerun` => mode 'correlational' (ranking only; the honesty envelope says so).
//    toBacktrackTrace maps that report 1:1 into the BacktrackTrace shape ATUI renders,
//    and we enrich the content-evidence suspect with its recorded tool output (custody).
const snapshot = agent.getLastSnapshot();
const llmIds = llmCallIdsFromEvents(events);
const answeringCall = llmIds[llmIds.length - 1];                    // root of the backward slice
const report = await localizeContextBug({
  artifacts: { snapshot, events },
  embedder: embeddingCache(mockEmbedder()),
  atStep: answeringCall,
});
const backtrack = toBacktrackTrace(report, {
  answer: { text: answerText, label: 'WeatherBot answer' },
  claim: 'Why this answer?',
  agent: 'WeatherBot',
  model: 'mock-1',
  // Enrich a suspect that carries a real content signal with its RECORDED state, so the
  // rewind player can replay the exact bytes the answering call read (never invented).
  custody: (suspect) => (suspect.detail?.text ? [{
    step: 'READ',
    detail: `${suspect.stageName} produced this; the answering call read it`,
    at: suspect.source,
    variable: suspect.edgePath?.[0]?.key,
    content: suspect.detail.text,
    highlight: suspect.detail.text,
  }] : undefined),
});

// Honesty surfaces straight from the report (rendered verbatim by the panel):
//  - top-ranked suspects are path-only upper bounds (no content signal) — `upperBound`.
//  - exactly the content-evidence suspect(s) carry a proven-read tool output.
//  - honestyFlags name what the slice could NOT see (untracked sources, no control deps).
const top = report.suspects[0];
const contentSuspect = report.suspects.find((s) => s.hasContentEvidence);   // the tool output, if any
const proven = report.suspects.length > 0;

// Make the final answer TAP-ABLE: agentthinkingui's onBacktrack hook fires when a step's
// "Where did this come from?" chip is clicked, and it only renders that chip when the step
// carries a `variables: string[]`. Stamp the answer step with one chip so the affordance
// lands on the final answer. (Real onBacktrack contract: onBacktrack(variable, step).)
const answerStep = trace.steps.find((s) => s.kind === 'answer');
if (answerStep) answerStep.variables = ['answer'];

// 4. Emit a self-contained replay page: inline React 19 (cjs behind a require
//    shim) + the ATUI UMD + its CSS + the embedded trace AND the embedded why-chain.
//    A tiny root component wires onBacktrack -> a controlled BacktrackOverlay.
//    No network, no build.
const pkgRoot = (name) => dirname(require.resolve(name));
const read = (spec) => readFileSync(require.resolve(spec), 'utf8');
const readDeep = (name, rel) => readFileSync(join(pkgRoot(name), rel), 'utf8');
const cjs = (name, code) => `__register(${JSON.stringify(name)}, function (module, exports, require) {\n${code}\n});`;

const TRACE_MARKER = 'var TRACE =';                                 // asserted below as "trace JSON embedded"
const BACKTRACK_MARKER = 'var BACKTRACK =';                         // asserted below as "why-chain JSON embedded"
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Agent replay — why this answer</title>
<style>${read('agentthinkingui/styles.css')}</style></head>
<body><div id="root" style="height:100vh"></div>
<script>
var __mods = {};
function __register(name, factory) { __mods[name] = { factory: factory, exports: null }; }
function __require(name) {
  var m = __mods[name];
  if (!m) throw new Error('missing module ' + name);
  if (!m.exports) { var mod = { exports: {} }; m.exports = mod.exports; m.factory(mod, mod.exports, __require); m.exports = mod.exports; }
  return m.exports;
}
</script>
<script>${cjs('react', readDeep('react', 'cjs/react.production.js'))}</script>
<script>${cjs('scheduler', readDeep('scheduler', 'cjs/scheduler.production.js'))}</script>
<script>${cjs('react-dom', readDeep('react-dom', 'cjs/react-dom.production.js'))}</script>
<script>${cjs('react-dom/client', readDeep('react-dom', 'cjs/react-dom-client.production.js'))}</script>
<script>
window.React = __require('react');
window.ReactDOMClient = __require('react-dom/client');
</script>
<script>${read('agentthinkingui/umd')}</script>
<script>
${TRACE_MARKER} ${JSON.stringify(trace)};
${BACKTRACK_MARKER} ${JSON.stringify(backtrack)};
// Root: the scrubbable player + a "Why this answer" board. Tapping the answer step's
// "Where did this come from?" chip fires onBacktrack, which opens the controlled overlay.
function WhyAnswerReplay() {
  var st = React.useState(null);      // the tapped variable, or null when the board is closed
  var openVar = st[0], setOpenVar = st[1];
  return React.createElement(React.Fragment, null,
    React.createElement(AgentThinkingUI, {
      trace: TRACE,
      onBacktrack: function (variable) { setOpenVar(variable); }
    }),
    React.createElement(BacktrackOverlay, {
      open: openVar !== null,
      trace: BACKTRACK,
      backLabel: 'back',
      onClose: function () { setOpenVar(null); }
    })
  );
}
ReactDOMClient.createRoot(document.getElementById('root'))
  .render(React.createElement(WhyAnswerReplay));
</script>
</body></html>`;

const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'replay.html');
writeFileSync(outFile, html);

// Basic sanity: the page carries the embedded trace JSON, the embedded why-chain, and
// the ATUI bootstrap incl. the onBacktrack wiring + the BacktrackOverlay board.
const hasTraceJSON = html.includes(TRACE_MARKER) && html.includes('"steps"');
const hasBacktrackJSON = html.includes(BACKTRACK_MARKER) && html.includes('"suspects"');
const hasWhyPanel = html.includes('onBacktrack') && html.includes('BacktrackOverlay');
const hasAtuiBootstrap = html.includes('AgentThinkingUI') && html.includes('createRoot');

// The exact byte size embeds wall-clock cost.ms (non-deterministic) — bucket it.
const bytes = statSync(outFile).size;
const sizeBucket = bytes < 262144 ? 'under-256KB' : bytes < 1048576 ? '256KB-1MB' : '1MB-plus';

// ---- STABLE SUMMARY (no timestamps, run-ids, byte counts, or cost.ms) ----
// Scores are deterministic embedding-geometry proxies (mock embedder) — safe to round + assert.
console.log('=== SUMMARY ===');
console.log(`trace beats: ${beats.length}`);
console.log(`beat kinds: ${beats.join(' -> ')}`);
console.log(`tools considered: ${toolsConsidered.length} (${toolsConsidered.join(', ')})`);
console.log(`tool asked: ${toolAsked.join(', ')}`);
console.log('why this answer (computed from the recording by localizeContextBug):');
console.log(`  mode: ${report.mode} · suspects ranked: ${report.suspects.length} · decided at: ${backtrack.decidedAt.id}`);
console.log(`  top influence (path-only upper bound): ${top.kind} ${top.source} via ${top.edgePath[0].key} score ${top.score.toFixed(3)}`);
console.log(contentSuspect
  ? `  tool output that fed it: ${contentSuspect.detail.toolName} "${contentSuspect.detail.text}" score ${contentSuspect.score.toFixed(3)}`
  : `  tool output that fed it: (none — no suspect carried a content signal; ranking is path-only proxy)`);
console.log(`  honesty flags carried into panel: ${report.honestyFlags.length} (${report.honestyFlags.map((f) => f.flag).join(', ')})`);
console.log(`  link proven from the recording: ${proven ? 'yes' : 'no (honest absence — panel says so)'}`);
console.log(`file emitted: 03-user-facing-why/out/replay.html`);
console.log(`size bucket: ${sizeBucket}`);
console.log(`html has embedded trace JSON: ${hasTraceJSON ? 'yes' : 'no'}`);
console.log(`html has embedded why-chain JSON: ${hasBacktrackJSON ? 'yes' : 'no'}`);
console.log(`html has why-answer panel (onBacktrack -> BacktrackOverlay): ${hasWhyPanel ? 'yes' : 'no'}`);
console.log(`html has atui bootstrap: ${hasAtuiBootstrap ? 'yes' : 'no'}`);
console.log('=== END ===');
