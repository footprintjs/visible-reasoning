// ---------------------------------------------------------------------------
// Claim 1 — THE SUBSTRATE OWNS THE TRACE
// Paper: Anbalagan et al. (2026), "Visible Reasoning", AI in HCI (HCII 2026),
//        LNCS 16745, pp. 3-21.  Paradigm: RECORDED DECISION EVIDENCE.
//
// Chain-of-thought asks the model to narrate itself (unverifiable). LLM-as-judge
// asks another model (recursive trust). This third paradigm records nothing the
// model says: the EXECUTION SUBSTRATE produces the trace. Every stage that runs
// leaves a typed commit event; every decide() call leaves typed evidence. Here we
// run a tiny flowchart ONCE, then reconstruct the entire "why" FROM THE SNAPSHOT
// ALONE (the engine's commit log + recorded decision evidence) — no model is asked
// anything, because no model produced the record.
//
// Shape: seed -> decider (decide() evidence) -> branch -> finish.
// ---------------------------------------------------------------------------

import { flowChart, decide, FlowChartExecutor } from 'footprintjs';

// A support ticket: intake seeds one fact, a decider routes on it, a branch acts,
// a finish closes out. Ordinary stage functions — none of them "explains" itself.
const chart = flowChart('Intake', (scope) => {
    scope.severity = 8;                       // the one fact the decision will hinge on
  }, 'intake')
  .addDeciderFunction('Route', (scope) => decide(scope, [
      // decide() is the typed decision: the rule, its threshold, and whether it
      // matched are RECORDED by the engine — not summarized afterwards by a model.
      { when: { severity: { gt: 5 } }, then: 'urgent', label: 'Severity above 5' },
    ], 'normal'), 'route', 'Route by severity')
    .addFunctionBranch('urgent', 'Escalate', (scope) => { scope.lane = 'Human escalation'; })
    .addFunctionBranch('normal', 'AutoResolve', (scope) => { scope.lane = 'Auto-resolved'; })
    .setDefault('normal')
    .end()
  .addFunction('Finish', (scope) => { scope.closed = true; }, 'finish')
  .build();

// Run ONCE through the executor. The engine emits typed flow events as it goes;
// we capture them exactly as recorded (we do not author or paraphrase them).
const executor = new FlowChartExecutor(chart);
const flowEvents = [];
let decision;
executor.attachCombinedRecorder({
  id: 'substrate-probe',
  onDecision(e) { decision = e; flowEvents.push(['decision', e.decider, e.chosen]); },
  onStageExecuted(e) { flowEvents.push(['stageExecuted', e.stageName, e.stageType]); },
});
await executor.run();

// --- Reconstruct the "why" FROM THE SNAPSHOT ALONE -------------------------
const snap = executor.getSnapshot();          // RuntimeSnapshot: the engine's record

console.log('Ordered typed events (from the commit log the engine owns):');
for (const b of snap.commitLog) {
  const verbs = b.trace.map((t) => `${t.verb}:${t.path}`).join(', ') || '(no writes)';
  console.log(`  [${b.idx}] ${b.runtimeStageId.padEnd(9)} ${b.stage.padEnd(9)} ${verbs}`);
}

console.log('\nThe decision the engine took, with its recorded evidence:');
console.log(`  ${decision.decider} chose ${decision.chosen} (branch '${decision.evidence.chosen}')`);
for (const r of decision.evidence.rules) {
  const c = r.conditions[0];                  // one condition per rule in this chart
  console.log(`    rule[${r.ruleIndex}] "${r.label}": ${c.key} ${c.op} ${c.threshold} ` +
              `-> matched=${r.matched} (actual ${c.actualSummary})`);
}
console.log(`    default branch if nothing matched: ${decision.evidence.default}`);

// --- Stable summary block (deterministic; no timestamps / run-ids) ---------
const lines = [];
lines.push('=== SUMMARY ===');
lines.push(`commit events: ${snap.commitLog.length}`);
for (const b of snap.commitLog) {
  const verbs = b.trace.map((t) => `${t.verb}:${t.path}`).join(',') || '-';
  lines.push(`  ${b.idx} ${b.runtimeStageId} ${b.stage} ${verbs}`);
}
lines.push(`flow events: ${flowEvents.length}`);
for (const [kind, a, b] of flowEvents) lines.push(`  ${kind} ${a} ${b}`);
const r0 = decision.evidence.rules[0];
const c0 = r0.conditions[0];
lines.push(`decision: ${decision.decider} -> ${decision.chosen} (branch '${decision.evidence.chosen}')`);
lines.push(`  rule[${r0.ruleIndex}] "${r0.label}": ${c0.key} ${c0.op} ${c0.threshold} matched=${r0.matched} actual=${c0.actualSummary}`);
lines.push(`  default: ${decision.evidence.default}`);
lines.push('provenance: engine-recorded (commit log + decision evidence), not model-narrated');
lines.push('=== END ===');

console.log('\n' + lines.join('\n'));
