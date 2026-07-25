/**
 * BoundaryRecorder — unified domain event log for an agentfootprint run.
 *
 * The single source of truth Lens (and any other consumer) reads to
 * render a run. Every observable moment in a run is captured as one
 * `DomainEvent` in a single ordered stream:
 *
 *   - `run.entry` / `run.exit`              — top-level executor.run()
 *   - `subflow.entry` / `subflow.exit`      — every subflow boundary
 *   - `fork.branch`                         — one per parallel child
 *   - `decision.branch`                     — chosen branch of a Conditional
 *   - `loop.iteration`                      — one per back-edge traversal
 *   - `llm.start` / `llm.end`               — LLM provider call lifecycle
 *   - `tool.start` / `tool.end`             — tool execution lifecycle
 *   - `context.injected`                    — anything injected into a slot
 *
 * All events carry `runtimeStageId` (binds with footprintjs Trace view +
 * with each other), `subflowPath`, `depth`, and `ts` (wall-clock ms).
 * Subflow events are domain-tagged (`slotKind` / `primitiveKind` /
 * `isAgentInternal`) so consumers dispatch on tag without re-parsing.
 *
 * Architecture:
 *
 *   ┌──── footprintjs (domain-agnostic) ────┐
 *   │  FlowRecorder events (run/subflow/    │  ──┐
 *   │  fork/decision/loop)                  │    │
 *   └───────────────────────────────────────┘    │
 *                                                │
 *   ┌──── agentfootprint dispatcher ─────────┐   │  consumed by
 *   │  Typed events (llm/tool/context)       │  ──┤
 *   └────────────────────────────────────────┘   │
 *                                                ▼
 *                                  ┌─── BoundaryRecorder ───┐
 *                                  │  one tagged stream of  │
 *                                  │  DomainEvent           │
 *                                  └────────────────────────┘
 *                                                │
 *                                                ▼  consumed by
 *                                  ┌────── Lens (UI) ──────┐
 *                                  │  Slider / RunFlow /   │
 *                                  │  NodeDetail / etc.    │
 *                                  └───────────────────────┘
 *
 * Why ONE recorder: Lens scrub axis, run-flow graph, slot rows inside
 * the LLM card, right-pane detail panel, commentary panel — every UI
 * surface reads from the SAME stream. Adding a new domain event = one
 * tagged emit + one render shape. No state machines spread across
 * renderers, no merging of multiple sources, no name-based filter lists.
 *
 * Naming: `runtimeStageId` is footprintjs's primitive (path-prefixed +
 * `#executionIndex`). `subflowPath` is rooted under the synthetic
 * `'__root__'`. `slotKind` / `primitiveKind` are agent-domain. The
 * design follows the React Fiber + OpenTelemetry pattern:
 * **producers self-describe; consumers dispatch on type**.
 *
 * @example
 * ```typescript
 * import { boundaryRecorder, EventDispatcher } from 'agentfootprint';
 *
 * const boundary = boundaryRecorder();
 * const dispatcher = new EventDispatcher();
 * executor.attachCombinedRecorder(boundary);   // wires FlowRecorder side
 * boundary.subscribe(dispatcher);              // wires typed-event side
 *
 * await executor.run({ input });
 *
 * for (const e of boundary.getEvents()) {
 *   switch (e.type) {
 *     case 'run.entry':       renderRoot(e); break;
 *     case 'subflow.entry':   if (e.slotKind) renderSlotRow(e);
 *                              else if (e.primitiveKind) renderPrimitive(e);
 *                              break;
 *     case 'llm.start':       renderLLMCall(e); break;
 *     // ...
 *   }
 * }
 * ```
 */
import { ROOT_RUNTIME_STAGE_ID, ROOT_SUBFLOW_ID, SequenceStore, CommitRangeIndex, } from 'footprintjs/trace';
import { SUBFLOW_IDS, STAGE_IDS, slotFromSubflowId } from '../../conventions.js';
import { createRunIdObserver } from './observeRunId.js';
/** Closed set of routing/wrapper subflow IDs that are pure plumbing.
 *  Slot subflows (`sf-system-prompt` / `sf-messages` / `sf-tools`) are
 *  NOT in this set — they're real context-engineering moments.
 *
 *  When you add a new subflow to the Agent's internal flowchart, decide:
 *    - Is it a context-engineering moment the user should see?  → leave OUT
 *    - Is it pure routing / dispatch / cache plumbing?           → add HERE
 *
 *  Forgetting to add it leaks every iteration of that subflow into the
 *  StepGraph as a fake "step" the user has to scrub past. */
const AGENT_INTERNAL_LOCAL_IDS = new Set([
    // Subflow ids (`sf-*`)
    SUBFLOW_IDS.INJECTION_ENGINE, // collects activeInjections; pure plumbing
    SUBFLOW_IDS.LLM_CALL, // LLMCall's inner invocation wrapper — the meaningful step is the call-llm stage INSIDE; the wrapper itself is a chart-shape container
    SUBFLOW_IDS.ROUTE,
    SUBFLOW_IDS.TOOL_CALLS,
    SUBFLOW_IDS.FINAL,
    SUBFLOW_IDS.MERGE,
    SUBFLOW_IDS.CACHE, // v2.14 — per-turn cache decision wrapper; pure plumbing
    SUBFLOW_IDS.CACHE_DECISION, // v2.6 — emits cacheMarkers; not a user step
    SUBFLOW_IDS.THINKING, // v2.14 — normalize result lands on parent LLM step
    // Decider stage ids (the same set is used to filter `decision.branch`
    // events whose deciding stage is plumbing rather than user-facing).
    STAGE_IDS.CACHE_GATE, // v2.6 — apply-markers / no-markers routing; plumbing
    // LLMCall outer wrapper stage + post-invocation marker — pure chart
    // shape, not user-meaningful steps.
    STAGE_IDS.CLIENT,
    STAGE_IDS.EXTRACT_FINAL,
]);
// Constructed as a set on a separate line so we can extend with the
// thinking-handler inner-subflow ids below without the literal set
// initializer needing every value at compile time.
const _AGENT_INTERNAL_PREFIXES = ['thinking-'];
/**
 * True when a local stage/subflow id should be hidden from the user-
 * facing StepGraph. Either an exact match against `AGENT_INTERNAL_LOCAL_IDS`
 * OR a prefix match against `_AGENT_INTERNAL_PREFIXES`.
 *
 * The prefix path catches the inner subflow that
 * `buildThinkingSubflow` creates with stageId `thinking-{handlerId}`
 * (e.g. `thinking-anthropic`, `thinking-openai`) — its results are
 * already folded into the wrapping LLMCall step's payload, so the
 * inner subflow is pure plumbing too.
 */
function isAgentInternalId(localId) {
    if (AGENT_INTERNAL_LOCAL_IDS.has(localId))
        return true;
    for (const p of _AGENT_INTERNAL_PREFIXES) {
        if (localId.startsWith(p))
            return true;
    }
    return false;
}
function toBoundaryLabel(e) {
    if (e.type === 'subflow.entry') {
        return {
            type: 'subflow.entry',
            runtimeStageId: e.runtimeStageId,
            subflowPath: e.subflowPath,
            depth: e.depth,
            ts: e.ts,
            subflowId: e.subflowId,
            localSubflowId: e.localSubflowId,
            subflowName: e.subflowName,
            ...(e.description !== undefined ? { description: e.description } : {}),
            ...(e.primitiveKind !== undefined ? { primitiveKind: e.primitiveKind } : {}),
            ...(e.slotKind !== undefined ? { slotKind: e.slotKind } : {}),
            isAgentInternal: e.isAgentInternal,
        };
    }
    return {
        type: 'run.entry',
        runtimeStageId: e.runtimeStageId,
        subflowPath: e.subflowPath,
        depth: e.depth,
        ts: e.ts,
    };
}
/** Build a BoundaryRangeLabel for the open side of a composition pair. */
function toCompositionBoundaryLabel(e) {
    return {
        type: 'composition.start',
        runtimeStageId: e.runtimeStageId,
        subflowPath: e.subflowPath,
        depth: e.depth,
        ts: e.ts,
        compositionKind: e.kind,
        compositionName: e.name,
    };
}
/** Clamp `getCommitCount()` returns to a safe non-negative integer.
 *  Defensive against malformed injections returning NaN/Infinity/negatives
 *  (security panel review YELLOW #2). */
function sanitizeCommitCount(n) {
    if (!Number.isFinite(n))
        return 0;
    if (n < 0)
        return 0;
    return n;
}
let _counter = 0;
/** Factory — matches the `inOutRecorder()` / `topologyRecorder()` style. */
export function boundaryRecorder(options = {}) {
    return new BoundaryRecorder(options);
}
/**
 * Unified domain event recorder. Implements `CombinedRecorder` so it can
 * attach to the executor's FlowRecorder channel; exposes `subscribe()`
 * to wire to the agentfootprint typed-event dispatcher.
 *
 * v5: composes a `SequenceStore<DomainEvent>` (storage) instead of
 * extending the deprecated `SequenceStore<T>` base. Time-travel
 * utilities (`getEntryRanges`, `accumulate`) are accessed through the
 * store via the public read API on this class.
 */
export class BoundaryRecorder {
    id;
    /** Composition: storage shelf. */
    store = new SequenceStore();
    /**
     * Phase 5 Layer 2 — interval index over commit indices, populated
     * live as boundary entry/exit pairs fire. Consumers (Lens) read
     * `enclosing(commitIdx)` for breadcrumbs and `overlapping(slice)`
     * for time-range queries. Empty when `getCommitCount` is not
     * injected. See `docs/design/boundary-commit-ranges.md`.
     */
    boundaryIndex = new CommitRangeIndex();
    /** Open-range tokens keyed by `runtimeStageId` so the matching exit
     *  can close the correct range. Pure side-table; cleared on runId
     *  reset. Not exposed externally. */
    openTokens = new Map();
    /** Live commit-count accessor injected by the runner. Sanitized
     *  (NaN/Infinity/negative → 0) before use. */
    getCommitCount;
    /** True when `getCommitCount` was explicitly injected. In LEGACY
     *  MODE (false), `boundaryIndex` is intentionally NOT populated —
     *  zero-width [0,0] ranges would mislead consumers querying the
     *  index. Multi-panel review flagged this footgun. */
    hasCommitTracking;
    /**
     * Tracks whether the most recent `llm.end` had toolCalls. Used to
     * classify the NEXT `llm.start` as `'tool→llm'` (vs `'user→llm'` if
     * there's no pending tool result). Reset on `clear()` and on every
     * `llm.start` event after the classification is applied.
     */
    prevLLMEndHadTools = false;
    /**
     * Run-boundary observer — fires resetForNewRun() when
     * traversalContext.runId changes between events AND no boundary is
     * currently open. The "no open boundary" gate distinguishes:
     *
     *   - **Legitimate new run** — consumer reuses one recorder across
     *     sequential `executor.run()` calls. All prior boundaries closed
     *     before the second run began; openTokens is empty when the new
     *     runId arrives → safe to wipe state so the second run doesn't
     *     alias with the first.
     *   - **Composition sub-run** — primitives like `LLMCall`, `Sequence`,
     *     and `Parallel` internally spawn their own `FlowChartExecutor`
     *     instances. Each sub-executor mints a NEW runId. When that
     *     sub-executor fires events on the SHARED recorder, the recorder
     *     is still inside the parent run — `openTokens` is non-empty.
     *     Resetting here would wipe the parent's boundary index mid-run
     *     (the bug Layer 4 surfaced in agentfootprint-lens fanout).
     *
     * The `openTokens.size === 0` check is the cleanest semantic signal:
     * if nothing is in-flight, a runId change means "the consumer started
     * fresh"; if something is open, the new runId is from a sub-executor
     * nested inside the still-ongoing parent.
     */
    runIdGuard = createRunIdObserver(() => {
        if (this.openTokens.size > 0) {
            // Inside an active run — new runId is from a composition sub-
            // executor (LLMCall / Sequence / Parallel). Do NOT reset.
            return;
        }
        this.store.clear();
        this.boundaryIndex.clear();
        this.openTokens.clear();
        this.prevLLMEndHadTools = false;
    });
    constructor(options = {}) {
        this.id = options.id ?? `boundary-${++_counter}`;
        this.hasCommitTracking = options.getCommitCount !== undefined;
        const raw = options.getCommitCount;
        this.getCommitCount = raw === undefined ? () => 0 : () => sanitizeCommitCount(raw());
    }
    /**
     * Reset all transient state.
     *
     * **Composition-safe gate (Phase 5 Layer 4):** if `openTokens.size > 0`
     * the call is a no-op. Rationale: `FlowChartExecutor.run()` calls
     * `r.clear?.()` on every attached recorder during its pre-run loop.
     * When agentfootprint composition primitives (LLMCall, Sequence,
     * Parallel, etc.) propagate the parent's recorders to nested
     * sub-executors, EACH sub-executor's pre-run clear loop calls
     * `clear()` on the SHARED parent recorder mid-run — wiping live
     * parent state. The `openTokens.size > 0` check distinguishes:
     *
     *   - **Legitimate reset** — consumer or executor calls `clear()`
     *     when no boundary is in-flight (`openTokens` empty). Safe to
     *     wipe; the recorder is idle.
     *   - **Composition wipe** — sub-executor's pre-run clear fires
     *     while the parent has open boundaries (`openTokens` non-empty).
     *     Skip the wipe; the parent's state must be preserved.
     *
     * If a consumer needs to forcibly wipe state even with open tokens
     * (e.g., manual recovery after a crashed run), pair `clear()` with
     * an explicit `forceClear()` (TODO — add when the use case shows up;
     * today the recorder lifecycle pattern is "one recorder per logical
     * run" so leaked tokens shouldn't occur).
     */
    clear() {
        if (this.openTokens.size > 0) {
            // Mid-run wipe attempt — almost certainly a sub-executor's
            // pre-run clear via composition propagation. Skip.
            return;
        }
        this.store.clear();
        this.boundaryIndex.clear();
        this.openTokens.clear();
        this.prevLLMEndHadTools = false;
        this.runIdGuard.reset();
    }
    observeRunId(runId) {
        this.runIdGuard.observe(runId);
    }
    // ── FlowRecorder hooks (footprintjs side) ───────────────────────────
    onRunStart(event) {
        this.observeRunId(event.traversalContext?.runId);
        const commitIdxBefore = this.getCommitCount();
        const e = buildRunEvent('run.entry', event.payload, commitIdxBefore);
        // Open range BEFORE the store push so a failed push doesn't leak
        // an unclosed range (DS+logic panel review). The label is the
        // stripped projection (no payload) — security-panel YELLOW #1.
        if (this.hasCommitTracking) {
            const token = this.boundaryIndex.open(toBoundaryLabel(e), commitIdxBefore);
            this.openTokens.set(e.runtimeStageId, token);
        }
        this.store.push(e);
    }
    onRunEnd(event) {
        this.observeRunId(event.traversalContext?.runId);
        const commitIdxBefore = this.getCommitCount();
        const e = buildRunEvent('run.exit', event.payload, commitIdxBefore);
        // Close the range BEFORE store.push so a failed push doesn't
        // leak a permanently-open range. The range is the canonical
        // truth; the store entry is downstream telemetry.
        if (this.hasCommitTracking) {
            const token = this.openTokens.get(e.runtimeStageId);
            if (token) {
                this.boundaryIndex.close(token, commitIdxBefore);
                this.openTokens.delete(e.runtimeStageId);
            }
        }
        this.store.push(e);
    }
    onRunFailed(event) {
        this.observeRunId(event.traversalContext?.runId);
        const commitIdxBefore = this.getCommitCount();
        // A failed run still TERMINATES — close the root range (mirror
        // onRunEnd) so consumers get a terminal "Run · failed" boundary
        // position instead of a slider that stops mid-call. The error rides
        // as the exit payload so the WHY is reachable at that boundary.
        const e = buildRunEvent('run.exit', { error: event.structuredError.message }, commitIdxBefore);
        if (this.hasCommitTracking) {
            const token = this.openTokens.get(e.runtimeStageId);
            if (token) {
                this.boundaryIndex.close(token, commitIdxBefore);
                this.openTokens.delete(e.runtimeStageId);
            }
        }
        this.store.push(e);
    }
    onSubflowEntry(event) {
        this.observeRunId(event.traversalContext?.runId);
        const commitIdxBefore = this.getCommitCount();
        const e = buildSubflowEvent(event, 'subflow.entry', commitIdxBefore);
        if (!e)
            return;
        if (this.hasCommitTracking) {
            const token = this.boundaryIndex.open(toBoundaryLabel(e), commitIdxBefore);
            this.openTokens.set(e.runtimeStageId, token);
        }
        this.store.push(e);
    }
    onSubflowExit(event) {
        this.observeRunId(event.traversalContext?.runId);
        const commitIdxBefore = this.getCommitCount();
        const e = buildSubflowEvent(event, 'subflow.exit', commitIdxBefore);
        if (!e)
            return;
        if (this.hasCommitTracking) {
            const token = this.openTokens.get(e.runtimeStageId);
            if (token) {
                this.boundaryIndex.close(token, commitIdxBefore);
                this.openTokens.delete(e.runtimeStageId);
            }
        }
        this.store.push(e);
    }
    onFork(event) {
        this.observeRunId(event.traversalContext?.runId);
        const ts = Date.now();
        const ctx = event.traversalContext;
        const runtimeStageId = ctx?.runtimeStageId ?? '';
        const segments = ctx?.subflowPath ? ctx.subflowPath.split('/').filter(Boolean) : [];
        const subflowPath = [ROOT_SUBFLOW_ID, ...segments];
        const commitIdxBefore = this.getCommitCount();
        for (const childName of event.children) {
            this.store.push({
                type: 'fork.branch',
                runtimeStageId,
                subflowPath,
                depth: subflowPath.length - 1,
                ts,
                commitIdxBefore,
                commitIdxAfter: commitIdxBefore,
                parentSubflowId: event.parent,
                childName,
            });
        }
    }
    onDecision(event) {
        this.observeRunId(event.traversalContext?.runId);
        const ctx = event.traversalContext;
        // Agent-internal decisions (Route picking tool-calls / final) are
        // identified by the deciding stage's stableId matching one of the
        // known Agent-internal subflow ids. The actor arrows that follow
        // (`llm→tool` / `llm→user`) already encode the routing observably,
        // so the timeline filters these out — but we still capture them in
        // the event log so the right-pane / commentary can read the
        // rationale when present.
        const stageId = ctx?.stageId ?? '';
        const localStageId = stageId.includes('/')
            ? stageId.slice(stageId.lastIndexOf('/') + 1)
            : stageId;
        const isAgentInternal = isAgentInternalId(localStageId);
        const commitIdxBefore = this.getCommitCount();
        this.store.push({
            type: 'decision.branch',
            runtimeStageId: ctx?.runtimeStageId ?? '',
            subflowPath: pathFromCtx(ctx?.subflowPath),
            depth: ctxDepth(ctx?.subflowPath),
            ts: Date.now(),
            commitIdxBefore,
            commitIdxAfter: commitIdxBefore,
            decider: event.decider,
            chosen: event.chosen,
            ...(event.rationale ? { rationale: event.rationale } : {}),
            isAgentInternal,
        });
    }
    onLoop(event) {
        this.observeRunId(event.traversalContext?.runId);
        const ctx = event.traversalContext;
        const commitIdxBefore = this.getCommitCount();
        this.store.push({
            type: 'loop.iteration',
            runtimeStageId: ctx?.runtimeStageId ?? '',
            subflowPath: pathFromCtx(ctx?.subflowPath),
            depth: ctxDepth(ctx?.subflowPath),
            ts: Date.now(),
            commitIdxBefore,
            commitIdxAfter: commitIdxBefore,
            target: event.target,
            iteration: event.iteration,
        });
    }
    // ── Typed-event subscription (agentfootprint dispatcher side) ───────
    /**
     * Subscribe to the runner's typed-event dispatcher and emit a domain
     * event for each `llm.*` / `tool.*` / `context.injected` event.
     *
     * Returns an unsubscribe function; safe to call multiple times (each
     * call adds a new subscription). Most consumers call this once at
     * recorder construction and dispose with the returned function.
     */
    subscribe(dispatcher) {
        return dispatcher.on('*', (event) => this.ingestTypedEvent(event));
    }
    ingestTypedEvent(event) {
        // NOTE: deliberately does NOT call observeRunId(event.meta.runId).
        // The agentfootprint dispatcher's runId is generated by a DIFFERENT
        // generator than footprintjs's traversalContext.runId. Mixing them
        // would toggle lastRunId on every event and trigger a false reset.
        // Run-boundary detection happens reliably via the FlowRecorder hooks
        // (onRunStart fires FIRST in any new run, before any typed event).
        const meta = event.meta;
        const runtimeStageId = meta.runtimeStageId ?? '';
        const subflowPath = [ROOT_SUBFLOW_ID, ...(meta.subflowPath ?? [])];
        const depth = subflowPath.length - 1;
        const ts = meta.wallClockMs;
        // Phase 5 Layer 2: stamp commit index on every typed event for
        // consumers that want to join domain events with the commit log
        // (e.g., "which LLM call happened during this commit slice?").
        // Typed events don't write to scope themselves, so before === after.
        const commitIdxBefore = this.getCommitCount();
        switch (event.type) {
            case 'agentfootprint.stream.llm_start': {
                const p = event.payload;
                // Classify the actor arrow at capture time. State is local to
                // THIS recorder and consumed-then-reset on each llm.start. No
                // state machine spread across renderers; consumers just read
                // `event.actorArrow`.
                const actorArrow = this.prevLLMEndHadTools
                    ? 'tool→llm'
                    : 'user→llm';
                this.prevLLMEndHadTools = false;
                this.store.push({
                    type: 'llm.start',
                    runtimeStageId,
                    subflowPath,
                    depth,
                    ts,
                    commitIdxBefore,
                    commitIdxAfter: commitIdxBefore,
                    model: p.model,
                    provider: p.provider,
                    ...(p.systemPromptChars !== undefined ? { systemPromptChars: p.systemPromptChars } : {}),
                    ...(p.messagesCount !== undefined ? { messagesCount: p.messagesCount } : {}),
                    ...(p.toolsCount !== undefined ? { toolsCount: p.toolsCount } : {}),
                    actorArrow,
                });
                break;
            }
            case 'agentfootprint.stream.llm_end': {
                const p = event.payload;
                const actorArrow = p.toolCallCount > 0 ? 'llm→tool' : 'llm→user';
                // Set the pending flag for the NEXT llm.start (if any). A
                // terminal call (toolCallCount === 0) leaves the flag false so
                // a hypothetical follow-up call would correctly be 'user→llm'.
                this.prevLLMEndHadTools = p.toolCallCount > 0;
                this.store.push({
                    type: 'llm.end',
                    runtimeStageId,
                    subflowPath,
                    depth,
                    ts,
                    commitIdxBefore,
                    commitIdxAfter: commitIdxBefore,
                    content: p.content,
                    toolCallCount: p.toolCallCount,
                    usage: { input: p.usage.input, output: p.usage.output },
                    ...(p.stopReason ? { stopReason: p.stopReason } : {}),
                    actorArrow,
                });
                break;
            }
            case 'agentfootprint.stream.tool_start': {
                const p = event.payload;
                this.store.push({
                    type: 'tool.start',
                    runtimeStageId,
                    subflowPath,
                    depth,
                    ts,
                    commitIdxBefore,
                    commitIdxAfter: commitIdxBefore,
                    toolName: p.toolName,
                    toolCallId: p.toolCallId,
                    ...(p.args !== undefined ? { args: p.args } : {}),
                });
                break;
            }
            case 'agentfootprint.stream.tool_end': {
                const p = event.payload;
                this.store.push({
                    type: 'tool.end',
                    runtimeStageId,
                    subflowPath,
                    depth,
                    ts,
                    commitIdxBefore,
                    commitIdxAfter: commitIdxBefore,
                    toolCallId: p.toolCallId,
                    ...(p.result !== undefined ? { result: p.result } : {}),
                    ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
                    ...(p.error !== undefined ? { error: p.error } : {}),
                });
                break;
            }
            case 'agentfootprint.context.injected': {
                const p = event.payload;
                this.store.push({
                    type: 'context.injected',
                    runtimeStageId,
                    subflowPath,
                    depth,
                    ts,
                    commitIdxBefore,
                    commitIdxAfter: commitIdxBefore,
                    slot: p.slot,
                    source: p.source ?? 'unknown',
                    ...(p.sourceId ? { sourceId: p.sourceId } : {}),
                    ...(p.asRole ? { asRole: p.asRole } : {}),
                    ...(p.contentSummary ? { contentSummary: p.contentSummary } : {}),
                    ...(p.reason ? { reason: p.reason } : {}),
                    ...(p.sectionTag ? { sectionTag: p.sectionTag } : {}),
                    ...(p.upstreamRef ? { upstreamRef: p.upstreamRef } : {}),
                    ...(p.retrievalScore !== undefined ? { retrievalScore: p.retrievalScore } : {}),
                    ...(p.rankPosition !== undefined ? { rankPosition: p.rankPosition } : {}),
                    ...(p.budgetSpent?.tokens !== undefined ? { budgetTokens: p.budgetSpent.tokens } : {}),
                    ...(p.budgetSpent?.fractionOfCap !== undefined
                        ? { budgetFraction: p.budgetSpent.fractionOfCap }
                        : {}),
                });
                break;
            }
            case 'agentfootprint.composition.enter': {
                // Open a boundary range for the composition. The MATCHING KEY
                // for open/close is `payload.id` (the composition's stable id),
                // NOT `meta.runtimeStageId`. Reason: the composition's enter
                // event fires from a different stage (entry hook) than its
                // exit event (merge / exit hook) — different `meta.runtimeStageId`s.
                // The composition's `id` is the only field that's the same on
                // both. The boundary range's runtimeStageId (used as the Lens
                // group identity) is the ENTER event's `meta.runtimeStageId`
                // (the entry stage's id) — that's the "fork moment."
                const p = event.payload;
                const e = {
                    type: 'composition.start',
                    runtimeStageId,
                    subflowPath,
                    depth,
                    ts,
                    commitIdxBefore,
                    commitIdxAfter: commitIdxBefore,
                    kind: p.kind,
                    compositionId: p.id,
                    name: p.name,
                };
                if (this.hasCommitTracking) {
                    const token = this.boundaryIndex.open(toCompositionBoundaryLabel(e), commitIdxBefore);
                    this.openTokens.set(`composition:${p.id}`, token);
                }
                this.store.push(e);
                break;
            }
            case 'agentfootprint.composition.exit': {
                // Close the matching composition range. Keyed by `payload.id`
                // — see the enter handler for why this differs from
                // meta.runtimeStageId.
                const p = event.payload;
                const e = {
                    type: 'composition.end',
                    runtimeStageId,
                    subflowPath,
                    depth,
                    ts,
                    commitIdxBefore,
                    commitIdxAfter: commitIdxBefore,
                    kind: p.kind,
                    compositionId: p.id,
                    name: p.name ?? '',
                    status: p.status,
                    durationMs: p.durationMs,
                };
                if (this.hasCommitTracking) {
                    const key = `composition:${p.id}`;
                    const token = this.openTokens.get(key);
                    if (token) {
                        this.boundaryIndex.close(token, commitIdxBefore);
                        this.openTokens.delete(key);
                    }
                }
                this.store.push(e);
                break;
            }
            default:
                // Other typed events (agent.*, eval.*, etc.) are not mapped to
                // DomainEvent for now — they're higher-level summaries that
                // downstream selectors derive on demand.
                break;
        }
    }
    // ── Read API ────────────────────────────────────────────────────────
    /** All events in capture order (the canonical projection). */
    getEvents() {
        return this.store.getAll();
    }
    /** Type-narrowed lookup: all events of one kind. */
    getEventsByType(type) {
        const out = [];
        for (const e of this.store.getAll()) {
            if (e.type === type)
                out.push(e);
        }
        return out;
    }
    // ── Back-compat / convenience query helpers ─────────────────────────
    /** All boundary events (run + subflow, entry + exit interleaved). */
    getBoundaries() {
        const out = [];
        for (const e of this.store.getAll()) {
            if (e.type === 'run.entry' ||
                e.type === 'run.exit' ||
                e.type === 'subflow.entry' ||
                e.type === 'subflow.exit') {
                out.push(e);
            }
        }
        return out;
    }
    /** Just the entry-phase boundary events — the "step list" timeline. */
    getSteps() {
        return this.getBoundaries().filter((b) => b.type === 'run.entry' || b.type === 'subflow.entry');
    }
    /** Subset of `getSteps()` excluding agent-internal routing subflows. */
    getVisibleSteps() {
        return this.getSteps().filter((s) => s.type !== 'subflow.entry' || !s.isAgentInternal);
    }
    /** Entry/exit pair for one chart execution by `runtimeStageId`. */
    getBoundary(runtimeStageId) {
        const matches = this.store.getByKey(runtimeStageId);
        let entry;
        let exit;
        for (const e of matches) {
            if (e.type === 'run.entry' || e.type === 'subflow.entry')
                entry = e;
            else if (e.type === 'run.exit' || e.type === 'subflow.exit')
                exit = e;
        }
        return {
            ...(entry ? { entry } : {}),
            ...(exit ? { exit } : {}),
        };
    }
    /** Convenience for the outermost `__root__` pair. */
    getRootBoundary() {
        const pair = this.getBoundary(ROOT_RUNTIME_STAGE_ID);
        return {
            ...(pair.entry?.type === 'run.entry' ? { entry: pair.entry } : {}),
            ...(pair.exit?.type === 'run.exit' ? { exit: pair.exit } : {}),
        };
    }
    /** Subflow events grouped by the 3 input slots — for slot-row rendering. */
    getSlotBoundaries() {
        const systemPrompt = [];
        const messages = [];
        const tools = [];
        for (const e of this.store.getAll()) {
            if (e.type !== 'subflow.entry' && e.type !== 'subflow.exit')
                continue;
            if (e.slotKind === 'system-prompt')
                systemPrompt.push(e);
            else if (e.slotKind === 'messages')
                messages.push(e);
            else if (e.slotKind === 'tools')
                tools.push(e);
        }
        return { systemPrompt, messages, tools };
    }
    /**
     * Roll up the event stream for ONE primitive boundary (Agent /
     * LLMCall / Sequence / Parallel / Conditional / Loop) into per-
     * boundary totals — tokens, llm calls, tool calls, iterations,
     * cache hits, duration.
     *
     * Pure projection over `getEvents()`. Events are attributed to a
     * boundary when their `subflowPath` is a **prefix-match** of the
     * boundary's path — so a nested `LLMCall` inside an `Agent` rolls
     * up into BOTH (LLMCall total + Agent total).
     *
     * Works mid-run (the boundary's `subflow.exit` may not have fired
     * yet — `endedAtMs` / `durationMs` are undefined in that case).
     * Works post-run.
     *
     * Multi-consumer story: this is the single source of rollup truth
     * for Lens, CLI live monitors, Sentry breadcrumbs, OTel exporters,
     * dashboards. Domain math (what counts as an "iteration"? does
     * cache hit count separately from llmCalls?) lives HERE — every
     * consumer hooks up; nobody re-implements.
     *
     * @param runtimeStageId The boundary's runtimeStageId (the same id
     *   carried by `StepNode.runtimeStageId` for primitive subflows).
     * @returns The rollup, or `undefined` if no `subflow.entry` event
     *   matches `runtimeStageId`.
     */
    aggregateForBoundary(runtimeStageId) {
        const events = this.store.getAll();
        let entry;
        let exit;
        for (const e of events) {
            if (e.type === 'subflow.entry' && e.runtimeStageId === runtimeStageId)
                entry = e;
            if (e.type === 'subflow.exit' && e.runtimeStageId === runtimeStageId)
                exit = e;
        }
        if (!entry)
            return undefined;
        return foldRollup(events, entry, exit);
    }
    /**
     * Roll up every primitive boundary in the run into one rollup each,
     * in the order their `subflow.entry` events fired. Top-level multi-
     * agent UIs call this once per render to populate per-agent chips.
     *
     * Filters to `primitiveKind`-tagged subflows ONLY (Agent / LLMCall /
     * Sequence / Parallel / Conditional / Loop). Slot subflows
     * (`sf-system-prompt` / `sf-messages` / `sf-tools`) are NOT
     * boundaries in this sense — they're context-engineering machinery,
     * not user-facing rollup units.
     */
    aggregateAllBoundaries() {
        const events = this.store.getAll();
        const out = [];
        // Index exits by runtimeStageId for O(1) pair-up.
        const exitByRid = new Map();
        for (const e of events) {
            if (e.type === 'subflow.exit' && e.primitiveKind) {
                exitByRid.set(e.runtimeStageId, e);
            }
        }
        for (const e of events) {
            if (e.type !== 'subflow.entry' || !e.primitiveKind)
                continue;
            const exit = exitByRid.get(e.runtimeStageId);
            out.push(foldRollup(events, e, exit));
        }
        return out;
    }
    /** Snapshot bundle — included in `executor.getSnapshot()` if the
     *  executor implements the snapshot extension protocol. */
    toSnapshot() {
        return {
            name: 'BoundaryEvents',
            description: 'Unified domain event log — run/subflow boundaries + LLM/tool/context events',
            preferredOperation: 'translate',
            data: this.getEvents(),
        };
    }
}
// ── Internal helpers ─────────────────────────────────────────────────
function buildRunEvent(type, payload, commitIdxBefore) {
    return {
        type,
        runtimeStageId: ROOT_RUNTIME_STAGE_ID,
        subflowPath: [ROOT_SUBFLOW_ID],
        depth: 0,
        ts: Date.now(),
        commitIdxBefore,
        commitIdxAfter: commitIdxBefore,
        payload,
        isRoot: true,
    };
}
function buildSubflowEvent(event, type, commitIdxBefore) {
    const subflowId = event.subflowId;
    if (!subflowId)
        return undefined;
    const ctx = event.traversalContext;
    const runtimeStageId = ctx?.runtimeStageId ?? '';
    const segments = subflowId.split('/').filter(Boolean);
    const subflowPath = [ROOT_SUBFLOW_ID, ...segments];
    const depth = subflowPath.length - 1;
    const localSubflowId = segments[segments.length - 1] ?? subflowId;
    const description = event.description;
    const primitiveKind = description ? parsePrimitiveKindFromDescription(description) : undefined;
    const slotKind = slotFromSubflowId(subflowId);
    const isAgentInternal = isAgentInternalId(localSubflowId);
    const payload = type === 'subflow.entry' ? event.mappedInput : event.outputState;
    return {
        type,
        runtimeStageId,
        subflowPath,
        depth,
        ts: Date.now(),
        commitIdxBefore,
        commitIdxAfter: commitIdxBefore,
        subflowId,
        localSubflowId,
        subflowName: event.name,
        ...(description ? { description } : {}),
        ...(primitiveKind ? { primitiveKind } : {}),
        ...(slotKind ? { slotKind } : {}),
        isAgentInternal,
        ...(payload !== undefined ? { payload } : {}),
    };
}
function pathFromCtx(subflowPath) {
    if (!subflowPath)
        return [ROOT_SUBFLOW_ID];
    return [ROOT_SUBFLOW_ID, ...subflowPath.split('/').filter(Boolean)];
}
function ctxDepth(subflowPath) {
    return pathFromCtx(subflowPath).length - 1;
}
function parsePrimitiveKindFromDescription(description) {
    const colonIdx = description.indexOf(':');
    if (colonIdx <= 0)
        return undefined;
    const kind = description.slice(0, colonIdx).trim();
    return kind || undefined;
}
// ─── Rollup helpers (used by aggregateForBoundary) ──────────────────
/** Returns true when `path` starts with every segment of `prefix`. */
function isSubflowPathPrefix(prefix, path) {
    if (path.length < prefix.length)
        return false;
    for (let i = 0; i < prefix.length; i++) {
        if (path[i] !== prefix[i])
            return false;
    }
    return true;
}
/**
 * Single-pass fold producing a `BoundaryAggregate` from the flat
 * event stream. Pure projection — no recorder state mutation.
 */
function foldRollup(events, entry, exit) {
    const path = entry.subflowPath;
    let llmCalls = 0;
    let toolCalls = 0;
    let iterations = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    for (const e of events) {
        if (!isSubflowPathPrefix(path, e.subflowPath))
            continue;
        switch (e.type) {
            case 'llm.start':
                llmCalls++;
                break;
            case 'tool.start':
                toolCalls++;
                break;
            case 'llm.end':
                inputTokens += e.usage.input;
                outputTokens += e.usage.output;
                break;
            // Iteration counting: every loop.iteration scoped to this
            // boundary OR equivalent. The composition.iteration / agent.
            // iteration_start typed events fire on the dispatcher channel
            // but BoundaryRecorder doesn't capture them as DomainEvents
            // today — instead we count `loop.iteration` events that fire
            // on the FlowRecorder side (already mapped). For Agent runs
            // the agent's outer loop contributes one per ReAct cycle.
            case 'loop.iteration':
                iterations++;
                break;
        }
    }
    const startedAtMs = entry.ts;
    const endedAtMs = exit?.ts;
    return {
        runtimeStageId: entry.runtimeStageId,
        subflowId: entry.subflowId,
        subflowPath: entry.subflowPath,
        ...(entry.primitiveKind ? { primitiveKind: entry.primitiveKind } : {}),
        label: entry.subflowName,
        tokens: { input: inputTokens, output: outputTokens },
        llmCalls,
        toolCalls,
        iterations,
        startedAtMs,
        ...(endedAtMs !== undefined ? { endedAtMs, durationMs: endedAtMs - startedAtMs } : {}),
    };
}
//# sourceMappingURL=BoundaryRecorder.js.map