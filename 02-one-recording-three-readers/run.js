// Claim 2 — ONE RECORDING, THREE READERS ("Visible Reasoning", HCII 2026,
// LNCS 16745, §Recorded Decision Evidence). The FRAMEWORK owns the trace: ONE
// mock agent run, then its single typed recording is consumed three ways with
// ZERO re-runs — (1) a human-readable narrative, (2) a CHEAP mock model answering
// "why?" from the recording alone, (3) a training-data export. $0, mock provider.

import crypto from 'node:crypto';
import { Agent, defineTool } from 'agentfootprint';
import { mock } from 'agentfootprint/llm-providers';
import { assembleTrajectory, traceDebugAgent } from 'agentfootprint/observe';

// --- A tiny tool + a scripted mock model: call the weather tool, then answer. ---
const weather = defineTool({
  name: 'weather',
  description: 'Get current weather for a city.',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  execute: async ({ city }) => `${city}: 72F, sunny`,
});
const provider = mock({
  replies: [
    { toolCalls: [{ id: 't1', name: 'weather', args: { city: 'Paris' } }] }, // call 1: use the tool
    { content: 'It is 72F and sunny in Paris.' },                             // call 2: final answer
  ],
});

const agent = Agent.create({ provider, model: 'mock-1', maxIterations: 3 })
  .system('You answer weather questions using the weather tool.')
  .tool(weather)
  .build();

// --- THE ONE RUN. Everything below reads its recording; nothing re-runs. ---
const events = [];
agent.on('*', (e) => events.push(e)); // typed events — the substrate emits them, no model narrates
await agent.run({ message: 'Weather in Paris?' });

const snapshot = agent.getLastSnapshot(); // the recording: typed commit log + execution tree

// A runId-stripped fingerprint of the recording (runId is fresh per run — never asserted).
const projection = snapshot.commitLog
  .map((c) => `${c.stage}|${c.runtimeStageId}|${(c.trace || []).map((t) => `${t.verb}:${t.path}`).join(',')}`)
  .join('\n');
const fingerprint = crypto.createHash('sha256').update(projection).digest('hex').slice(0, 12);
const distinctStages = new Set(snapshot.commitLog.map((c) => c.stage)).size;
const llmIds = snapshot.commitLog.filter((c) => c.stage === 'CallLLM').map((c) => c.runtimeStageId);

// --- READER 1: human-readable explanation, straight from the recording. ---
const narrative = agent.getLastNarrativeEntries();

// --- READER 2: cheap mock model, handed ONLY the recording via the trace toolpack;
// it calls who_wrote and names the tool from the trace text it got back. ---
const cheap = mock({
  respond: (req) => {
    const toolMsg = [...req.messages].reverse().find((m) => m.role === 'tool');
    if (!toolMsg) return { toolCalls: [{ id: 'q1', name: 'who_wrote', args: { key: 'lastToolResult' } }] };
    const body = typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content);
    const found = /"toolName":"([^"]+)"/.exec(body);
    const name = found ? found[1] : 'unknown';
    return `The agent chose the "${name}" tool. Trace evidence: ToolCalls wrote lastToolResult with toolName "${name}".`;
  },
});
const triage = traceDebugAgent({ artifacts: { snapshot }, provider: cheap, model: 'mock-cheap' });
const whyOut = await triage.run({ message: 'Why did the agent choose that tool?' });
const whyAnswer = typeof whyOut === 'object' && whyOut && 'content' in whyOut ? whyOut.content : whyOut;
const toolNamed = /"([^"]+)" tool/.exec(String(whyAnswer))?.[1] ?? 'unknown';

// --- READER 3: training-data export — trajectory rows for a fine-tuning pipeline. ---
const trajectory = assembleTrajectory({ snapshot, events });
const row0Keys = Object.keys(trajectory.frames[0]).join(', ');

// --- Stable summary: proves all three read the same runId-stripped recording. ---
console.log('=== SUMMARY ===');
console.log('ONE RECORDING (runId present but stripped from all assertions)');
console.log(`  commit-log entries: ${snapshot.commitLog.length}`);
console.log(`  distinct stages: ${distinctStages}`);
console.log(`  llm-call steps: ${llmIds.join(', ')}`);
console.log(`  fingerprint (sha256, runId-free): ${fingerprint}`);
console.log('READER 1 — human-readable explanation (run narrative)');
console.log(`  narrative entries: ${narrative.length}`);
console.log(`  opening line: ${narrative[0].text}`);
console.log('READER 2 — cheap mock model, given ONLY the recording');
console.log('  question: Why did the agent choose that tool?');
console.log('  trace tool the model called: who_wrote(lastToolResult)');
console.log(`  tool named IN the trace: ${toolNamed}`);
console.log(`  answer: ${whyAnswer}`);
console.log('READER 3 — training-data export (assembleTrajectory)');
console.log(`  trajectory rows (frames): ${trajectory.frames.length}`);
console.log(`  row[0] shape: ${row0Keys}`);
console.log(`  row[0].llmCallId: ${trajectory.frames[0].llmCallId}`);
console.log(`ALL THREE consumed fingerprint ${fingerprint} — one agent.run(), zero re-runs`);
console.log('=== END ===');
