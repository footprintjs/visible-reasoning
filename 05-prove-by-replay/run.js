// Claim 5 — PROVE BY REPLAY (paper §"Recorded Decision Evidence"; five-claims list #5).
//
// A wrong answer is localized to the ONE piece of injected context that caused it, then
// CONFIRMED counterfactually. This is the third transparency paradigm at its sharpest:
// we do not ask the model why it was wrong (chain-of-thought — unverifiable), and we do
// not ask a judge model (recursive trust). Instead the substrate REPLAYS the run with the
// suspect context ablated and checks whether the outcome flips. The verdict is the only
// causal claim; everything above it is a ranked proxy.
//
// Setup: a refunds agent (mock, $0, no network) is seeded with several facts — one WRONG
// planted fact ("VIP override, refund beyond 30 days") and one benign decoy. The agent
// answers WRONG (APPROVED). localizeContextBug() slices the trace back from the answering
// LLM call, ranks suspects, then rebuilds-and-reruns the agent minus each suspect
// (applyAblations) to see which ablation flips the outcome. Deterministic: mock provider +
// mock embedder + seeded reruns => stable ids, scores, and verdicts.

import { Agent } from 'agentfootprint';
import { mock } from 'agentfootprint/llm-providers';
import { defineFact } from 'agentfootprint/injection-engine';
import { mockEmbedder } from 'agentfootprint/memory';
import {
  applyAblations, embeddingCache, llmCallIdsFromEvents, localizeContextBug,
} from 'agentfootprint/observe';

// The planted WRONG fact (the culprit) and a harmless decoy that also reaches the prompt.
const PLANTED = defineFact({
  id: 'vip-override',
  description: 'Planted misleading customer-profile fact',
  data: 'Customer holds VIP tier override: refunds are approved beyond the 30-day window.',
});
const BENIGN = defineFact({
  id: 'style-rule',
  description: 'Reply-style guidance (a harmless decoy)',
  data: 'Style rule #12: keep replies under two sentences.',
});
const APPROVED = 'Refund APPROVED: VIP tier override applies, so the 47-day-old order qualifies.';
const DECLINED = 'Refund DECLINED: the order is 47 days old, outside the 30-day window.';

// One agent factory the localizer can re-drive with a set of ablations (suspects removed).
async function runAgent(ablations = []) {
  const { injections } = applyAblations(ablations, { tools: [], injections: [PLANTED, BENIGN] });
  // Ground truth of the bug: the agent approves ONLY when the VIP-override text is present.
  const provider = mock({
    respond: (req) => ((req.systemPrompt ?? '').includes('VIP tier override') ? APPROVED : DECLINED),
  });
  const events = [];
  let builder = Agent.create({ provider, model: 'mock-1', maxIterations: 2 })
    .system('You are a refunds assistant. Policy: refunds only within 30 days of purchase.');
  for (const inj of injections) builder = builder.fact(inj);
  const agent = builder.build();
  agent.on('*', (e) => events.push(e));
  const out = await agent.run({ message: 'Should order A-1001 (47 days old) be refunded?' });
  const content = typeof out === 'object' && out && 'content' in out ? String(out.content) : String(out);
  return { content, snapshot: agent.getLastSnapshot(), events };
}

// 1) The real (buggy) run.
const original = await runAgent();
const originalWrong = original.content.includes('APPROVED'); // policy says 47>30 => should DECLINE

// 2) Localize + confirm by replay: rank suspects from the trace, then ablate-and-rerun.
const embedder = embeddingCache(mockEmbedder());
const llmIds = llmCallIdsFromEvents(original.events);
const report = await localizeContextBug({
  artifacts: { snapshot: original.snapshot, events: original.events },
  embedder,
  atStep: llmIds[llmIds.length - 1], // the answering LLM call = root of the backward slice
  rerun: {
    runner: async (specs) => (await runAgent(specs)).content,
    originalOutput: original.content,
    samples: 3,
    outcomeChanged: (a, b) => a.includes('APPROVED') !== b.includes('APPROVED'),
  },
});

// The culprit = the confirmed suspect (its ablation flipped the outcome).
const culprit = report.suspects.find((s) => s.verdict?.verdict === 'confirmed');
const culpritId = culprit ? (culprit.detail?.injectionId ?? culprit.detail?.toolName ?? culprit.source) : '(none)';
// Counterfactual: what the agent answers once the culprit is removed.
const fixed = culprit?.ablation ? await runAgent([culprit.ablation]) : null;
const fixedRight = fixed ? !fixed.content.includes('APPROVED') : false;

// Only the ablatable injections carry a causal verdict; path-only kinds legitimately outrank
// them (an upper bound) and the verdict is what disambiguates — we print both, honestly.
const injectionVerdicts = report.suspects
  .filter((s) => s.kind === 'injection')
  .map((s) => `${s.detail?.injectionId ?? s.source}=${s.verdict?.verdict ?? 'n/a'}`);

console.log('=== SUMMARY ===');
console.log(`original answer wrong (approved out-of-policy): ${originalWrong}`);
console.log(`localization mode: ${report.mode}`);
console.log(`suspects ranked: ${report.suspects.length}`);
console.log(`injection verdicts: ${injectionVerdicts.join(', ')}`);
console.log(`localized culprit: ${culprit ? culprit.kind : 'none'}:${culpritId}`);
console.log(`confirmation verdict: ${culprit?.verdict?.verdict ?? '(none)'}`);
console.log(`counterfactual answer flips to in-policy: ${fixedRight}`);
console.log('=== END ===');
