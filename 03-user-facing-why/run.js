// Claim 3 — USER-FACING WHY (paper §"Recorded Decision Evidence"; HCII 2026).
// A REAL (mock-provider, $0, no-network) agent runs; the framework RECORDS it as
// a typed trace; we emit a self-contained HTML page that replays that recording
// as a scrubbable agentthinkingui story — a non-technical person can step through
// the run and see the why-this-tool evidence for each beat. The demo data is
// GENERATED, never hand-authored: agentThinkingTrace() captures the trace
// produced BY the run, and that exact object is the only data embedded.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, defineTool } from 'agentfootprint';
import { mock } from 'agentfootprint/llm-providers';
import { agentThinkingTrace } from 'agentfootprint/observe';

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
// user-facing trace — a product of traversal, not narration.
const att = agentThinkingTrace({ agent: 'WeatherBot', model: 'mock-1', asker: 'You' });
const agent = Agent.create({ provider, model: 'mock-1', maxIterations: 3 })
  .system('You answer weather questions using the weather tool.')
  .tool(weather)
  .tool(clock)
  .recorder(att)
  .build();
await agent.run({ message: 'Weather in Paris?' });

// 2. The recording — exactly the agentthinkingui Trace shape. This is the demo data.
const trace = att.getTrace();
const beats = trace.steps.map((s) => s.kind);                       // prompt -> ask -> return -> answer
const toolsConsidered = ['clock', 'weather'];                       // the whole toolbox offered to the model
const toolAsked = trace.steps.filter((s) => s.kind === 'ask').map((s) => s.tool);

// 3. Emit a self-contained replay page: inline React 19 (cjs behind a require
//    shim) + the ATUI UMD + its CSS + the embedded trace. No network, no build.
const pkgRoot = (name) => dirname(require.resolve(name));
const read = (spec) => readFileSync(require.resolve(spec), 'utf8');
const readDeep = (name, rel) => readFileSync(join(pkgRoot(name), rel), 'utf8');
const cjs = (name, code) => `__register(${JSON.stringify(name)}, function (module, exports, require) {\n${code}\n});`;

const TRACE_MARKER = 'var TRACE =';                                 // asserted below as "trace JSON embedded"
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Agent replay — why this tool</title>
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
ReactDOMClient.createRoot(document.getElementById('root'))
  .render(React.createElement(AgentThinkingUI, { trace: TRACE }));
</script>
</body></html>`;

const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'replay.html');
writeFileSync(outFile, html);

// 4. Basic sanity: the page carries the embedded trace JSON and the ATUI bootstrap.
const hasTraceJSON = html.includes(TRACE_MARKER) && html.includes('"steps"');
const hasAtuiBootstrap = html.includes('AgentThinkingUI') && html.includes('createRoot');

// The exact byte size embeds wall-clock cost.ms (non-deterministic) — bucket it.
const bytes = statSync(outFile).size;
const sizeBucket = bytes < 262144 ? 'under-256KB' : bytes < 1048576 ? '256KB-1MB' : '1MB-plus';

// ---- STABLE SUMMARY (no timestamps, run-ids, byte counts, or cost.ms) ----
console.log('=== SUMMARY ===');
console.log(`trace beats: ${beats.length}`);
console.log(`beat kinds: ${beats.join(' -> ')}`);
console.log(`tools considered: ${toolsConsidered.length} (${toolsConsidered.join(', ')})`);
console.log(`tool asked: ${toolAsked.join(', ')}`);
console.log(`file emitted: 03-user-facing-why/out/replay.html`);
console.log(`size bucket: ${sizeBucket}`);
console.log(`html has embedded trace JSON: ${hasTraceJSON ? 'yes' : 'no'}`);
console.log(`html has atui bootstrap: ${hasAtuiBootstrap ? 'yes' : 'no'}`);
console.log('=== END ===');
