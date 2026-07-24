// ---------------------------------------------------------------------------
// LIVE MODE — an optional SIXTH act (not part of `npm run all`).
// Paper: Anbalagan et al. (2026), "Visible Reasoning", AI in HCI (HCII 2026),
//        LNCS 16745, pp. 3-21.  Paradigm: RECORDED DECISION EVIDENCE.
//
// Examples 01-05 tell the "recorded decision evidence" story against MOCK
// providers, so their output is byte-stable and free. This act tells the SAME
// story against the REAL Anthropic API: a minimal agentfootprint agent, two
// tools, one short task that forces a tool choice. We record the run, then print
// evidence derived FROM THE RECORDING — which tool was chosen, the engine's
// recorded why-evidence (a deterministic embedding-margin proxy over the tool
// menu), a couple of typed-event counts, and the live model's own answer.
//
// Because a real model's wording (and token counts) vary run to run, this act is
// EXEMPT from byte-exact verification: it is not in verify.js and not in
// `npm run all`. Run it with:  npm run live   (loads .env via --env-file).
// Cost: about two small Haiku calls per run.
//
// Model: claude-haiku-4-5-20251001 (cheapest current Claude — any Claude model
// id works; e.g. claude-sonnet-4-5-20250929 for a stronger, pricier run).
// The ANTHROPIC_API_KEY is read from the environment by the anthropic() provider
// (npm run live supplies it via `node --env-file=.env`); it is never printed.
// ---------------------------------------------------------------------------

import { Agent, defineTool } from 'agentfootprint';
import { anthropic } from 'agentfootprint/llm-providers';
import { toolChoiceRecorder, embeddingCache } from 'agentfootprint/observe';
import { mockEmbedder } from 'agentfootprint/memory';

const MODEL = 'claude-haiku-4-5-20251001';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    'ANTHROPIC_API_KEY is not set.\n' +
      '  1. cp .env.example .env\n' +
      '  2. paste your Anthropic key into .env\n' +
      '  3. npm run live   (it loads .env for you)\n' +
      'The mock examples need no key:  npm run all',
  );
  process.exit(1);
}

// --- Two tools the model must choose between, and one task that forces the pick.
const getWeather = defineTool({
  name: 'get_weather',
  description: 'Get the current weather for a city (temperature, rain, sky conditions).',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  // A stub result — the point is the recorded CHOICE, not a real weather feed.
  execute: async ({ city }) => `${city}: 18C, light rain, wind 12 km/h`,
});
const calculator = defineTool({
  name: 'calculator',
  description: 'Evaluate an arithmetic expression. Use for math and numeric computation.',
  inputSchema: { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'] },
  execute: async ({ expr }) => `${expr} = (computed)`,
});

// --- The recorder that captures the "why this tool" evidence. It records the
// menu the model saw and what it invoked, then (lazily, on read) ranks the
// offered tools against the task with a DETERMINISTIC mock embedder — an honest
// proxy for the model's selection, computed by the substrate, not narrated by
// the model. No extra API cost (the embedder is local).
const choice = toolChoiceRecorder({ embedder: embeddingCache(mockEmbedder()) });

// --- The agent: real provider, real model, both tools, the recorder attached
// BEFORE build (agentfootprint builder convention).
const provider = anthropic(); // reads ANTHROPIC_API_KEY from process.env
const agent = Agent.create({ provider, model: MODEL, maxIterations: 4 })
  .system('You answer the user using the available tools when they are useful. Keep answers to one sentence.')
  .tool(getWeather)
  .tool(calculator)
  .recorder(choice)
  .build();

// --- THE LIVE RUN. Capture every typed event the substrate emits.
const TASK = 'What is the weather in Tokyo right now?';
const events = [];
agent.on('*', (e) => events.push(e));

let out;
try {
  out = await agent.run({ message: TASK });
} catch (err) {
  console.error('Live call failed:', err && err.message ? err.message : err);
  process.exit(1);
}

const answer = out && typeof out === 'object' && 'content' in out ? out.content : String(out);

// --- Evidence derived FROM THE RECORDING (not from the raw API response). ---
const snapshot = agent.getLastSnapshot();
const llmCallIds = snapshot.commitLog.filter((c) => c.stage === 'CallLLM').map((c) => c.runtimeStageId);

// Typed-event counts — a couple of structural facts about the run.
const countOf = (suffix) => events.filter((e) => e.type.endsWith(suffix)).length;
const llmCalls = countOf('.stream.llm_start');
const toolInvocations = countOf('.stream.tool_start');

// The recorded tool-choice evidence for the call that actually picked a tool.
const calls = await choice.getCalls();
const summary = await choice.getSummary();
const picked = calls.find((c) => c.chosen.length > 0);

console.log(`Task: ${TASK}`);
console.log(`Model: ${MODEL} (live Anthropic API)`);
console.log(`Typed events captured: ${events.length}`);
console.log(`LLM calls: ${llmCalls} (${llmCallIds.join(', ')}) · tool invocations: ${toolInvocations}`);
if (picked && picked.margin) {
  console.log('\nRecorded why-this-tool evidence (embedding-margin proxy over the offered menu):');
  for (const s of picked.margin.scores) {
    const mark = picked.chosen.includes(s.name) ? 'CHOSEN ' : '       ';
    console.log(`  ${mark}${s.name.padEnd(14)} score ${s.score.toFixed(4)}`);
  }
  console.log(`  margin (best chosen - best non-chosen): ${picked.margin.margin.toFixed(4)}` +
    ` — ${picked.margin.flags.narrow ? 'NARROW (close call)' : 'clear'}`);
}

// --- Stable-STRUCTURE summary. Markers match the mock examples, but this act is
// exempt from byte verification (real model wording + token counts vary). ---
console.log('\n=== SUMMARY ===');
console.log('LIVE MODE — recorded decision evidence against the real Anthropic API');
console.log(`  model: ${MODEL}`);
console.log(`  task: ${TASK}`);
const offeredNames = picked ? picked.offered.map((o) => o.name).join(', ') : 'get_weather, calculator';
console.log(`  tools offered: ${offeredNames}`);
if (picked) {
  console.log(`  tool chosen (from the recording): ${picked.chosen.join(', ')}`);
  if (picked.margin) {
    const best = picked.margin.scores.find((s) => s.name === picked.margin.topScored);
    console.log(`  why-evidence: '${picked.chosen[0]}' scored ${best ? best.score.toFixed(4) : 'n/a'}` +
      `, margin ${picked.margin.margin.toFixed(4)} over the alternative (deterministic proxy)`);
  }
} else {
  console.log('  tool chosen (from the recording): none — the model answered directly');
}
console.log(`  typed events: ${events.length} · llm calls: ${llmCalls} · tool invocations: ${toolInvocations}`);
console.log(`  tool-choice summary: ${JSON.stringify(summary)}`);
console.log(`  provenance: engine-recorded (typed events + tool-choice margin), not model-narrated`);
console.log(`  live model answer: ${answer}`);
console.log('=== END ===');
