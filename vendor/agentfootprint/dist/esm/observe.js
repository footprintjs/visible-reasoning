/**
 * agentfootprint/observe — observability recorders.
 *
 * Pattern: Observer (GoF) — pluggable, fire-and-forget event listeners
 *          for the agent's typed event stream.
 * Role:    Outer ring (Hexagonal). Attach via `runner.attachScopeRecorder()`;
 *          the runner emits events, recorders accumulate state.
 *
 * Three tiers (progressive disclosure):
 *
 *   Tier 1 — context + stream                                (the core)
 *     • ContextRecorder      — every slot composition
 *     • StreamRecorder       — token-level LLM streaming
 *
 *   Tier 2 — composition + agent                       (structural nav)
 *     • CompositionRecorder  — Sequence/Parallel/Conditional/Loop entries
 *     • AgentRecorder        — agent-loop iterations, tool calls
 *     • BoundaryRecorder     — domain-tagged subflow entry/exit
 *     • FlowchartRecorder    — StepGraph projection (Lens-friendly)
 *
 *   Tier 3 — domain dashboards                              (attach on demand)
 *     • CostRecorder         — token/USD spend
 *     • EvalRecorder         — eval scores from `runner.emit('eval.*', ...)`
 *     • MemoryRecorder       — memory injections + writes
 *     • PermissionRecorder   — permission decisions + denials
 *     • SkillRecorder        — skill activations
 *     • LoggingRecorder      — structured log lines per event
 *     • StatusRecorder     — chat-bubble first-person status
 *
 * Domain-flavored consumers (Lens, Grafana, Datadog) compose Tier 1+2
 * directly; Tier 3 dashboards are opt-in.
 */
// Tier 1 — context + stream
export { ContextRecorder } from './recorders/core/ContextRecorder.js';
export { streamRecorder } from './recorders/core/StreamRecorder.js';
// Tier 2 — composition + agent
export { compositionRecorder, } from './recorders/core/CompositionRecorder.js';
export { agentRecorder } from './recorders/core/AgentRecorder.js';
export { boundaryRecorder, BoundaryRecorder, } from './recorders/observability/BoundaryRecorder.js';
export { buildRunSteps, RunStepRecorder, runStepRecorder, } from './recorders/observability/RunStepRecorder.js';
export { attachFlowchart, buildStepGraph, buildStepGraphFromEvents, } from './recorders/observability/FlowchartRecorder.js';
// Offline replay: freeze a live run model into a UI-free, JSON-lossless Trace
// (redaction applied at the serialize boundary). agentfootprint-lens's <Replay>
// rehydrates it. See docs/design/local-observability-and-pii.md.
export { serializeTrace, redactContent, traceToStepGraph, } from './recorders/observability/trace.js';
// localObservability — Tier-3 retain: live <Lens> + offline getTrace()/onComplete.
export { attachLocalObservability, } from './recorders/observability/localObservability.js';
export { liveStateRecorder, LiveStateRecorder, LiveLLMTracker, LiveToolTracker, LiveAgentTurnTracker, } from './recorders/observability/LiveStateRecorder.js';
// Tier 3 — domain dashboards
export { costRecorder } from './recorders/core/CostRecorder.js';
export { toolsRecorder } from './recorders/core/ToolsRecorder.js';
export { contextEvaluatedRecorder, } from './recorders/core/ContextEvaluatedRecorder.js';
export { evalRecorder } from './recorders/core/EvalRecorder.js';
export { memoryRecorder } from './recorders/core/MemoryRecorder.js';
export { permissionRecorder, } from './recorders/core/PermissionRecorder.js';
export { skillRecorder } from './recorders/core/SkillRecorder.js';
export { attachLogging, LoggingDomains, } from './recorders/observability/LoggingRecorder.js';
export { attachStatus, } from './recorders/observability/StatusRecorder.js';
// Tool→tool DATA-FLOW graph, derived by value provenance from the tool emit
// stream (see finding 2: causalChain can't see LLM-mediated tool dependencies).
export { toolLineageRecorder, } from './recorders/observability/ToolLineageRecorder.js';
// AgentThinkingUI Trace (run → the "watch it think" beat list, collected during
// traversal). Lets any agentfootprint run drive AgentThinkingUI / domain views.
export { agentThinkingTrace, } from './recorders/observability/AgentThinkingTraceRecorder.js';
// Emit primitive — used by every Tier-3 source-domain.
export { typedEmit } from './recorders/core/typedEmit.js';
// ── DEPRECATED (moved to agentfootprint/debug) ─────────────────
// The diagnosis tools (influence-core, trace-toolpack, context-bisect,
// tool-lint) moved to `agentfootprint/debug` in the surface cleanup, so the
// import path matches the Debug docs category. They are re-exported here for
// ONE transition version — import them from `agentfootprint/debug` instead.
// They will be removed from `agentfootprint/observe` in the next major.
export * from './debug.js';
// Tool-choice margin recorder (RFC-002 tier 2, C4–C6) — per LLM call,
// ranks the OFFERED catalog against the choice context (user message +
// latest assistant reasoning) via influence-core scoreMargin; embeds
// LAZILY on first read; flags narrow margins + proxy disagreements.
export { buildChoiceContext, toolChoiceRecorder, } from './recorders/observability/ToolChoiceRecorder.js';
export { routeRecorder, formatRouteHop, } from './recorders/observability/RouteRecorder.js';
// context-ledger — which context pieces EARNED their tokens? Post-run
// bookkeeping (offers/uses/outcomes from the commit log) feeding the gating
// seams. See src/lib/context-ledger/README.md.
export { contextLedger, ledgerToolGate, ledgerEntryScorer, ledgerGated, } from './lib/context-ledger/index.js';
//# sourceMappingURL=observe.js.map