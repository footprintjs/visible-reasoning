// ============================================================================
// Claim 4 — HONEST ABSENCE
// Paper: "Visible Reasoning" (HCII 2026, LNCS 16745) — the RECORDED DECISION
// EVIDENCE paradigm only earns trust if it also admits what it CANNOT prove.
//
// One recorded run, default dials, TWO provenance queries against the same
// commit-log / slice layer:
//   - 'tier'      : written from a TRACKED read (scope.amount) -> the slice
//                   reconstructs a full causal chain back to the origin stage.
//   - 'riskFlag'  : written from an UNTRACKED input (scope.$getEnv()) -> the
//                   commit is stamped `untrackedSources: ['env']` and the slice
//                   node carries `incompleteSources: ['env']`. The query layer
//                   REFUSES to guess the input and says so, instead of inventing
//                   a dependency edge it cannot see.
//
// The stable summary prints the two verdicts side by side: PROVEN vs CANNOT PROVE.
// $0 to run — no providers, no network, no keys. Deterministic (stable ids only).
// ============================================================================

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { sliceForKey, keysReadFromExecutionTree, formatSlice } from 'footprintjs/trace';

// One tiny chart. seed writes `amount`; ClassifyTracked derives `tier` from it
// (a tracked read the engine can SEE); ScoreFromEnv derives `riskFlag` from the
// run env (a read the commit log CANNOT see — honest absence by construction).
const chart = flowChart('Seed', async (s) => { s.amount = 100; }, 'seed')
  .addFunction('ClassifyTracked', async (s) => {
    s.tier = s.amount > 50 ? 'premium' : 'basic';        // tracked read of `amount`
  }, 'classify-tracked')
  .addFunction('ScoreFromEnv', async (s) => {
    const env = s.$getEnv();                              // UNTRACKED source -> stamps untrackedSources
    s.riskFlag = (env.riskThreshold ?? 0) > 50 ? 'high' : 'low';
  }, 'score-from-env')
  .build();

// ONE run. Default dials — read-tracking is ON, so the honesty markers below
// come from a genuinely untracked SOURCE (env), not from a disabled dial.
const executor = new FlowChartExecutor(chart);
await executor.run({ env: { riskThreshold: 80 } });
const snap = executor.getSnapshot();
const reads = keysReadFromExecutionTree(snap.executionTree);

// -- helpers: walk the slice DAG (linear here; stable, single-parent) ----------
const originOf = (root) => { let n = root; while (n.parentEdges?.length) n = n.parentEdges[0].parent; return n.runtimeStageId; };
const chainOf = (root) => {
  const parts = [root.runtimeStageId]; let n = root;
  while (n.parentEdges?.length) { const e = n.parentEdges[0]; parts.push(`<-${e.key}- ${e.parent.runtimeStageId}`); n = e.parent; }
  return parts.join(' ');
};
const untrackedIn = (root) => {
  const out = new Set(), seen = new Set();
  (function walk(n) {
    if (seen.has(n.runtimeStageId)) return; seen.add(n.runtimeStageId);
    (n.incompleteSources ?? []).forEach((x) => out.add(x));
    (n.parentEdges ?? []).forEach((e) => walk(e.parent));
  })(root);
  return [...out];
};

// -- run the two queries against the ONE recording -----------------------------
const query = (key) => {
  const slice = sliceForKey(snap.commitLog, key, reads);
  const untracked = slice.root ? untrackedIn(slice.root) : [];
  const proven = !!slice.root && untracked.length === 0;
  return { key, slice, untracked, proven, chain: slice.root ? chainOf(slice.root) : '(never written)' };
};
const tracked = query('tier');
const absent = query('riskFlag');

// human-readable bodies (NOT asserted) — the safe slice renderer
console.log('--- slice: tier ---\n' + formatSlice(tracked.slice));
console.log('\n--- slice: riskFlag ---\n' + formatSlice(absent.slice));

// -- stable summary: the two verdicts side by side -----------------------------
const block = (label, q) => [
  `${label}  '${q.key}'`,
  `  writer            ${q.slice.root.runtimeStageId}`,
  `  provenance chain  ${q.chain}`,
  `  untracked inputs  ${q.untracked.length ? q.untracked.join(', ') : 'none'}`,
  `  VERDICT           ${q.proven
      ? `PROVEN — full causal chain back to ${originOf(q.slice.root)}; nothing hidden`
      : `CANNOT PROVE — writer read ${q.untracked.join(', ')} (untracked); the trace refuses to guess`}`,
].join('\n');

console.log('\n=== SUMMARY ===');
console.log('Claim 4 — honest absence: two values, one recorded run, default dials.\n');
console.log(block('TRACKED VALUE          ', tracked) + '\n');
console.log(block('ABSENT-PROVENANCE VALUE', absent) + '\n');
console.log('Same run, same query layer: it proves what it can see and flags what it cannot.');
console.log('=== END ===');
