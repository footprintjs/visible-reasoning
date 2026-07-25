/**
 * context-bisect — RFC-003 Part B: the contextual-bug LOCALIZER,
 * "git bisect for context".
 *
 * Assembly over shipped pieces: footprintjs 9.8.0's complete causal DAG
 * (control edges, honesty markers, `EdgeWeigher` hook) × influence-core
 * scoring (D6) × consumer-run counterfactual ablation.
 *
 *   D7 — `llmEdgeWeigher`     influence-weighted LLM-call slice edges
 *   D8 — `localizeContextBug` trigger → slice → ranked suspects → ablation
 *   D9 — `bisectCulprits`     seeded multi-culprit bisection + variance
 *
 * §B2 claim tiers (spelled out on every type): weights/scores are
 * embedding-geometry PROXIES; ablation verdicts are the ONLY causal
 * claims; slice completeness is bounded by tracking — and says so.
 *
 * @beta Beta feature (RFC-003 Part B). The API works and is tested, but
 * may change before GA.
 */
export { llmEdgeWeigher, stepOutputText, } from './llmEdgeWeigher.js';
// Interface #3 — missing-context finder (available − sent; confirm by restoration).
export { findDroppedContext, } from './missingContext.js';
export { runRestorationProbe, } from './restoration.js';
export { defaultSuspectClassifier, formatContextBugReport, llmCallIdsFromEvents, localizeContextBug, suspectLabel, } from './localize.js';
export { toBacktrackTrace, } from './toBacktrackTrace.js';
// sliceToBacktrackTrace — the STRUCTURAL sibling: a footprintjs variable
// slice (sliceToJSON) on the same atui board, honestly weaker chips.
export { sliceToBacktrackTrace, } from './sliceToBacktrackTrace.js';
export { ablationForSuspect, applyAblations, costStatsFrom, defaultOutcomeComparator, median, probeFlipped, runAblationProbe, verdictFor, } from './ablation.js';
// Two-score localization (proposal 004): the COST score + the 2×2 classifier.
export { assignCostVerdicts, classifySuspect, MIN_LOOPS_SAVED } from './cost.js';
// The counterfactual re-run as one call — the product loop over the ablation
// machinery (wraps applyAblations/runAblationProbe; no new machinery).
export { removableSources, rerunWithoutSources, } from './rerun.js';
// Per-loop recall shortlist (proposal 006, L3): rescue early culprits → narrow before ablation.
export { shortlistEarlyCulprits, DEFAULT_RECENCY_DECAY, } from './loop-recall.js';
// Root-cause backtracking debugger (proposal 007, L4): walk symptom → root (narrow → hop → convict).
export { walkToRoot, walkTrajectory, buildWriterFrameIndex, } from './walk-to-root.js';
// Per-loop trajectory assembler (proposal 005): segmentation core (phase 1)
// + the agent-flavored projection (phase 2).
export { assembleTrajectory, bucketByAnchors, findLoopHeads, } from './trajectory.js';
export { bisectCulprits, } from './bisect.js';
export { CONTEXT_BISECT_DEFAULTS, } from './types.js';
//# sourceMappingURL=index.js.map