/**
 * agentfootprint — public barrel.
 *
 * Pattern: Facade (GoF) over the typed sublayers.
 * Role:    Single entry point consumers import from.
 * Emits:   N/A.
 */
// Side-effect imports — auto-register v2.6+ cache strategies in the
// strategy registry. Without these, only the wildcard NoOp is
// registered and `Agent.create({ provider: browserAnthropic({...}) })`
// would silently fall back to NoOp instead of using the Anthropic
// cache_control translator. Importing the strategy modules runs their
// `registerCacheStrategy(...)` blocks at module load.
import './cache/strategies/AnthropicCacheStrategy.js';
import './cache/strategies/OpenAICacheStrategy.js';
import './cache/strategies/BedrockCacheStrategy.js';
// Adapter interfaces (ports)
export * from './adapters/types.js';
// Injection keys + recorder authoring helpers — needed by anyone writing
// a custom recorder that switches on injection events.
export { INJECTION_KEYS, injectionKeyForSlot, isInjectionKey, 
// Renderer-facing: classifies a stage's importance (hero vs plumbing) so
// visualisers (the lens, custom shells) can style the chart. Unlike the
// slot/id helpers below, this IS consumer API — it exists to be consumed
// by renderers.
stageRole, 
// Renderer-facing: declares which stages are time-travel MILESTONES (scrub
// stops) so the lens can build a stage-by-stage slider (iteration → llm-turn
// → tool-call → decision) instead of stopping only on structural boundaries.
// Consumer API — owned by the domain, consumed by renderers.
milestoneFor, } from './conventions.js';
// `STAGE_IDS`, `SUBFLOW_IDS`, `isSlotSubflow`, `slotFromSubflowId`,
// `isKnownStage`, `isKnownSubflow` are intentionally NOT exported — they
// are the internal builder↔recorder coordination protocol, not consumer
// API. Library code reaches them via the relative `./conventions.js`
// import; downstream code should never need them.
export { COMPOSITION_KEYS, } from './recorders/core/types.js';
// Context-engineering + emit primitives.
//
// The observability recorder FACTORIES (ContextRecorder, streamRecorder,
// agentRecorder, compositionRecorder, costRecorder, evalRecorder,
// memoryRecorder, permissionRecorder, skillRecorder, toolsRecorder,
// contextEvaluatedRecorder, boundaryRecorder, liveStateRecorder, the
// RunStep* family, attachFlowchart/attachLogging/attachStatus, …) now live
// ONLY under `agentfootprint/observe` — the dedicated observability subpath —
// so the main barrel stays focused on the core agent API.
export { contextEngineering, isEngineeredSource, isBaselineSource, ENGINEERED_SOURCES, BASELINE_SOURCES, } from './recorders/core/contextEngineering.js';
export { RunnerBase, makeRunId } from './core/RunnerBase.js';
// Pause/Resume primitives — consumer API for human-in-the-loop tools.
// `PauseRequest` (the throwable signal class) stays internal; consumers
// detect pauses via `isPauseRequest(err)` / `isPaused(outcome)`.
// `askHuman` is the HITL-named alias for `pauseHere` — same behavior,
// reads more naturally inside a tool that's asking a person to decide.
export { pauseHere, askHuman, isPauseRequest, isPaused, isCheckInPause, } from './core/pause.js';
// Check in with the receipts — evidence-carrying human consent. A tool
// declares `checkIn` (see `defineTool`); when it trips the run pauses with a
// `CheckInRequest` (the ask + evidence pack); a human answers with
// `checkInApproved` / `checkInDeclined`; the `CheckInDecision` lands as a
// typed record (`checkin.request` / `checkin.decision` events + `CheckInRecorder`).
export { checkInApproved, checkInDeclined, isCheckInDecision, lexicalDriverScorer, standardEvidenceAssembler, minimalEvidenceAssembler, } from './core/checkin.js';
// The built-in check-in audit store — `agent.attach(new CheckInRecorder())`.
export { CheckInRecorder, } from './recorders/core/CheckInRecorder.js';
// Commentary — bundled prose templates + engine for narrating a run.
// Consumers ship their own JSON locale / brand voice via the same
// shape; viewers (Lens, CLI tail, log file) consume this surface.
export { defaultCommentaryTemplates, 
// Commentary engine helpers — advanced surface consumed by viewer
// libraries (agentfootprint-lens) to render run narration. Not the
// everyday API, but de-facto public: keep exported.
extractAgentName, extractCommentaryVars, renderCommentary, selectCommentaryKey, } from './recorders/observability/commentary/commentaryTemplates.js';
// Status — chat-bubble surface (separate audience: the end user
// chatting; renamed from "thinking" in 5.0.0 to disambiguate from the
// MODEL's extended-thinking reasoning). State machine:
// idle / streaming / tool / paused. Same contract shape as commentary
// (`Record<string, string>` with `{{vars}}`, partial overrides
// supported, missing keys ignored) but a different vocabulary —
// first-person status, mid-call only. Per-tool keys (`tool.<toolName>`)
// win over the generic `tool` key.
// Primitives (core/)
export { LLMCall, LLMCallBuilder, } from './core/LLMCall.js';
// Agent (ReAct) form of the merge-tree — Context root selector → two-stage
// convergence: [sf-message-api (system-prompt+messages → messageAPI), sf-tools]
// → Call-LLM → route → [tool-exec → loop] / final. tools + the loop are the
// only additions over buildMessageApiChart. See buildAgentMessageApiChart.
export { buildAgentMessageApiChart, } from './core/agent/buildAgentMessageApiChart.js';
export { Agent, AgentBuilder, } from './core/Agent.js';
export { OutputSchemaError, applyOutputSchema, } from './core/outputSchema.js';
export { RunCheckpointError } from './core/runCheckpoint.js';
export { flowchartAsTool, } from './core/flowchartAsTool.js';
export { defineTool, assertValidToolName, warnIfInvalidToolName } from './core/tools.js';
export { toolContractCheckup, formatToolContractCheckup, } from './core/toolContract.js';
// Slot subflow builders are intentionally NOT exported. They are
// internal helpers used only by `Agent.buildChart()` and
// `LLMCall.buildChart()` to construct each primitive's three-slot
// context-engineering subflow tree. Consumers compose at the
// primitive / composition level (Agent / LLMCall / Sequence / …) — they
// never construct slot subflows directly. Power-users authoring a
// custom Agent-like primitive should copy the pattern from
// `src/core/Agent.ts` rather than depend on a private helper surface.
// Compositions (core-flow/)
export { Sequence, SequenceBuilder, } from './core-flow/Sequence.js';
export { Parallel, ParallelBuilder, } from './core-flow/Parallel.js';
export { Conditional, ConditionalBuilder, } from './core-flow/Conditional.js';
export { Loop, LoopBuilder, } from './core-flow/Loop.js';
// Adapters — LLM providers
// `mock(...)` is the lowercase factory equivalent to `new MockProvider(...)`.
// `anthropic(...)` is the real Claude provider via `@anthropic-ai/sdk`.
// Zero-peer-dep providers — safe to re-export from the main barrel
// because bundlers walking these never touch optional peer-dep code.
//
// Vendor-SDK-backed providers (AnthropicProvider, OpenAIProvider,
// BedrockProvider) live ONLY at `agentfootprint/llm-providers`. That
// subpath segregation means bundlers walking from `agentfootprint` main
// never see the lazy peer-dep requires for `@anthropic-ai/sdk`,
// `openai`, `@aws-sdk/client-bedrock-runtime`, etc. — automatic
// tree-shaking, no bundler-side workarounds.
//
//   import { AnthropicProvider } from 'agentfootprint';                  // ❌ not exported
//   import { AnthropicProvider } from 'agentfootprint/llm-providers';    // ✓ canonical
export { providerFromEnv, } from './adapters/llm/createProvider.js';
// Streaming helpers — agent events → SSE for browser delivery.
// Injection Engine — the unifying primitive of context engineering.
// One Injection type, four sugar factories, one engine subflow.
// Patterns — factory functions composing primitives + core-flow into
// well-known agent patterns from the research literature.
export * from './patterns/index.js';
// Memory subsystem — narrative beats, fact extraction, embedding-based
// retrieval, and pipelines that compose them. Top-level barrel exports
// the most-used factories; the full subsystem (including types that
// would collide with adapter types like MemoryStore) is reachable via
// the `agentfootprint/memory` subpath import.
// RAG — retrieval-augmented generation as a context-engineering flavor.
// Thin sugar over `defineMemory({ type: SEMANTIC, strategy: TOP_K })`
// plus the `indexDocuments` helper for seeding the corpus at startup.
export { defineRAG, indexDocuments, } from './lib/rag/index.js';
// MCP — Model Context Protocol client. Connect to MCP servers and
// expose their tools as agentfootprint Tool[] for `agent.tools(...)`.
// `@modelcontextprotocol/sdk` is a lazy-required peer-dep (no runtime
// cost when MCP isn't used).
// Tool dispatch primitives (v2.5+). New `agentfootprint/tool-providers`
// subpath bundles tool sources (mcpClient / mockMcpClient) with tool
// dispatch primitives (staticTools / gatedTools) so consumers find
// "everything tool-related" in one place. Top-level barrel re-exports
// the dispatch primitives too — `mcpClient` already re-exports above.
// Cross-cutting authorization (v2.5+). `agentfootprint/security` is the
// dedicated subpath; the root barrel also re-exports `PermissionPolicy`
// so existing v2.4 consumers find it at the top level.
// Message Catalog Pattern (v2.5+). `agentfootprint/locales` is the
// dedicated subpath; the root barrel also re-exports the helpers so
// existing v2.4 consumers find them at the top level.
//# sourceMappingURL=index.js.map