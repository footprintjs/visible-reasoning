/**
 * LiveStateRecorder — domain trackers built on the footprintjs
 * `BoundaryStateStore<TState>` storage primitive (v4.17.2+).
 *
 * **What this answers:** "Right now, mid-run, what's happening?"
 *
 *   - Is an LLM call in flight? What's the partial answer so far?
 *   - Is a tool executing? Which tool? What args?
 *   - Is the agent in a turn? Which turn index?
 *
 * All reads are O(1) — the trackers maintain incremental state via
 * the framework's bracket-scoped storage primitive. No event-log fold,
 * no walking arrays per render.
 *
 * **Mental model — observers vs. bookkeepers:**
 *
 *   `BoundaryStateStore<TState>` (footprintjs) = STORAGE shelf.
 *   `EventDispatcher.on(...)` (agentfootprint)  = OBSERVER source.
 *
 *   Each domain tracker (`LiveLLMTracker`, `LiveToolTracker`,
 *   `LiveAgentTurnTracker`) extends the storage shelf AND subscribes
 *   to the dispatcher. The composition `LiveStateRecorder` bundles
 *   all three so a consumer only attaches once.
 *
 * **Tier 1 (live) only.** Past states are not stored — when a boundary
 * closes, its transient state clears. For time-travel queries, snapshot
 * to a `SequenceStore<TState>` instead. See the BoundaryStateStore
 * JSDoc for the rationale.
 *
 * @example Use the bundled façade — one attach, three live views:
 *
 * ```typescript
 * import { LiveStateRecorder } from 'agentfootprint';
 *
 * const liveState = new LiveStateRecorder();
 * liveState.subscribe(runner);
 *
 * await runner.run({ input });
 *
 * // Read at any moment during the run (e.g., from another async task):
 * liveState.isLLMInFlight();          // true between llm_start ↔ llm_end
 * liveState.getPartialLLM();          // accumulated tokens so far
 * liveState.isToolExecuting();        // true between tool_start ↔ tool_end
 * liveState.isAgentInTurn();          // true between turn_start ↔ turn_end
 *
 * liveState.unsubscribe();
 * ```
 *
 * @example Use a single tracker directly when you only need one slice:
 *
 * ```typescript
 * import { LiveLLMTracker } from 'agentfootprint';
 *
 * const llm = new LiveLLMTracker();
 * llm.subscribe(runner);
 * await runner.run({ input });
 *
 * llm.isInFlight();                   // O(1)
 * llm.getLatestPartial();             // most recent active call's partial
 * llm.getActive(rid)?.tokens;         // tokens accumulated for one call
 * ```
 */
import { BoundaryStateStore } from 'footprintjs/trace';
import { createRunIdObserver } from './observeRunId.js';
// ─── LiveLLMTracker ─────────────────────────────────────────────────
/**
 * Tracks the in-flight state of LLM calls. Subscribes to:
 *   - `agentfootprint.stream.llm_start`  → opens a boundary
 *   - `agentfootprint.stream.token`      → appends to partial
 *   - `agentfootprint.stream.llm_end`    → closes the boundary
 *
 * Boundary key: `runtimeStageId` of the call-llm stage. Parallel LLM
 * calls (Parallel composition with multiple branches) get distinct
 * keys and are tracked independently.
 */
export class LiveLLMTracker {
    id = 'live-llm';
    /** Composition: bracket-scoped storage primitive. */
    store = new BoundaryStateStore();
    /** Wipes the store when a fresh run reuses identical runtimeStageId keys. */
    runIdGuard = createRunIdObserver(() => this.store.clear());
    observeRunId(runId) {
        this.runIdGuard.observe(runId);
    }
    /** Subscribe to a runner's dispatcher. Returns an Unsubscribe. */
    subscribe(runner) {
        const offs = [];
        offs.push(runner.on('agentfootprint.stream.llm_start', (event) => {
            this.observeRunId(event.meta.runId);
            const p = event.payload;
            this.store.start(event.meta.runtimeStageId, {
                partial: '',
                tokens: 0,
                iteration: p.iteration,
                provider: p.provider,
                model: p.model,
                startedAtMs: event.meta.wallClockMs,
            });
        }));
        offs.push(runner.on('agentfootprint.stream.token', (event) => {
            this.observeRunId(event.meta.runId);
            this.store.update(event.meta.runtimeStageId, (s) => ({
                ...s,
                partial: s.partial + event.payload.content,
                tokens: s.tokens + 1,
            }));
        }));
        offs.push(runner.on('agentfootprint.stream.llm_end', (event) => {
            this.observeRunId(event.meta.runId);
            this.store.stop(event.meta.runtimeStageId);
        }));
        // Terminal failure: a thrown LLM call never emits llm_end, so the
        // in-flight boundary would stay open forever ("Chatbot is thinking…"
        // stuck). The ErrorBridge emits error.fatal on a failed run — clear
        // all active boundaries so live consumers stop showing in-flight.
        offs.push(runner.on('agentfootprint.error.fatal', (event) => {
            this.observeRunId(event.meta.runId);
            this.store.clear();
        }));
        return () => offs.forEach((off) => off());
    }
    /** Reset all transient state. Called by `LiveStateRecorder.clear()`. */
    clear() {
        this.store.clear();
        this.runIdGuard.reset();
    }
    /** True if any LLM call is currently in flight. */
    isInFlight() {
        return this.store.hasActive;
    }
    /** Same as `store.hasActive` — exposed for parity with the v4 API. */
    get hasActive() {
        return this.store.hasActive;
    }
    /** Number of currently-active boundaries. */
    get activeCount() {
        return this.store.activeCount;
    }
    /** Currently-active boundary state for one runtimeStageId. */
    getActive(runtimeStageId) {
        return this.store.get(runtimeStageId);
    }
    /** All currently-active boundaries. */
    getAllActive() {
        return this.store.getAll();
    }
    /** Accumulated partial content of the MOST RECENTLY started active
     *  LLM call. Empty string when no call is active. Useful for the
     *  classic "Chatbot is responding: …" live commentary line. */
    getLatestPartial() {
        if (!this.store.hasActive)
            return '';
        let latest;
        let latestStart = -Infinity;
        for (const state of this.store.getAll().values()) {
            if (state.startedAtMs > latestStart) {
                latestStart = state.startedAtMs;
                latest = state;
            }
        }
        return latest?.partial ?? '';
    }
}
// ─── LiveToolTracker ────────────────────────────────────────────────
/**
 * Tracks in-flight tool calls. Subscribes to:
 *   - `agentfootprint.stream.tool_start` → opens a boundary
 *   - `agentfootprint.stream.tool_end`   → closes the boundary
 *
 * Boundary key: `toolCallId` (more granular than `runtimeStageId` —
 * parallel tools share one calling stage but have distinct toolCallIds).
 */
export class LiveToolTracker {
    id = 'live-tool';
    store = new BoundaryStateStore();
    runIdGuard = createRunIdObserver(() => this.store.clear());
    observeRunId(runId) {
        this.runIdGuard.observe(runId);
    }
    subscribe(runner) {
        const offs = [];
        offs.push(runner.on('agentfootprint.stream.tool_start', (event) => {
            this.observeRunId(event.meta.runId);
            const p = event.payload;
            this.store.start(p.toolCallId, {
                toolName: p.toolName,
                args: p.args,
                toolCallId: p.toolCallId,
                startedAtMs: event.meta.wallClockMs,
            });
        }));
        offs.push(runner.on('agentfootprint.stream.tool_end', (event) => {
            this.observeRunId(event.meta.runId);
            this.store.stop(event.payload.toolCallId);
        }));
        return () => offs.forEach((off) => off());
    }
    clear() {
        this.store.clear();
        this.runIdGuard.reset();
    }
    /** True if any tool is currently executing. */
    isExecuting() {
        return this.store.hasActive;
    }
    get hasActive() {
        return this.store.hasActive;
    }
    get activeCount() {
        return this.store.activeCount;
    }
    getActive(toolCallId) {
        return this.store.get(toolCallId);
    }
    getAllActive() {
        return this.store.getAll();
    }
    /** Names of tools currently executing. Empty when none. */
    getExecutingToolNames() {
        return [...this.store.getAll().values()].map((s) => s.toolName);
    }
}
// ─── LiveAgentTurnTracker ───────────────────────────────────────────
/**
 * Tracks in-flight agent turns. Subscribes to:
 *   - `agentfootprint.agent.turn_start` → opens a boundary
 *   - `agentfootprint.agent.turn_end`   → closes the boundary
 *
 * Boundary key: stringified `turnIndex` from the payload — survives
 * across runner instances because turnIndex resets per-session.
 */
export class LiveAgentTurnTracker {
    id = 'live-agent-turn';
    store = new BoundaryStateStore();
    runIdGuard = createRunIdObserver(() => this.store.clear());
    observeRunId(runId) {
        this.runIdGuard.observe(runId);
    }
    subscribe(runner) {
        const offs = [];
        offs.push(runner.on('agentfootprint.agent.turn_start', (event) => {
            this.observeRunId(event.meta.runId);
            const p = event.payload;
            this.store.start(String(p.turnIndex), {
                turnIndex: p.turnIndex,
                userPrompt: p.userPrompt,
                startedAtMs: event.meta.wallClockMs,
            });
        }));
        offs.push(runner.on('agentfootprint.agent.turn_end', (event) => {
            this.observeRunId(event.meta.runId);
            this.store.stop(String(event.payload.turnIndex));
        }));
        return () => offs.forEach((off) => off());
    }
    clear() {
        this.store.clear();
        this.runIdGuard.reset();
    }
    /** True if the agent is currently inside a turn. */
    isInTurn() {
        return this.store.hasActive;
    }
    get hasActive() {
        return this.store.hasActive;
    }
    get activeCount() {
        return this.store.activeCount;
    }
    getActive(turnIndex) {
        return this.store.get(turnIndex);
    }
    getAllActive() {
        return this.store.getAll();
    }
    /** Index of the most-recently started active turn (-1 if none). */
    getCurrentTurnIndex() {
        if (!this.store.hasActive)
            return -1;
        let latest = -1;
        let latestStart = -Infinity;
        for (const state of this.store.getAll().values()) {
            if (state.startedAtMs > latestStart) {
                latestStart = state.startedAtMs;
                latest = state.turnIndex;
            }
        }
        return latest;
    }
}
// ─── LiveStateRecorder — façade composing the three trackers ────────
/**
 * One-stop façade bundling `LiveLLMTracker` + `LiveToolTracker` +
 * `LiveAgentTurnTracker`. Consumers attach this once and get O(1)
 * reads across all three live-state slices.
 *
 * Use the bundled façade unless you ONLY need one slice — using a
 * single tracker directly avoids subscribing to events you don't read.
 *
 * **Lifecycle**: call `subscribe(runner)` to wire all three trackers,
 * then `unsubscribe()` to detach. `clear()` resets all transient state
 * across the three (called automatically by consumers like Lens between
 * runs).
 *
 * **What this is NOT for:**
 *   - Time-travel queries (Tier 1 only — live state)
 *   - Aggregations (use SequenceStore.aggregate)
 *   - Stage-level observation (use Recorder.onStageStart/End)
 *
 * **Composition over inheritance:** the façade does NOT extend
 * `BoundaryStateStore` itself — different boundary kinds need
 * separate active maps to avoid key collisions between LLM and tool
 * boundaries. Each sub-tracker keeps its own state.
 */
export class LiveStateRecorder {
    id = 'live-state';
    /** LLM call live state. */
    llm;
    /** Tool execution live state. */
    tool;
    /** Agent turn live state. */
    turn;
    /** Active subscription disposer, if `subscribe()` is called. */
    active;
    constructor() {
        this.llm = new LiveLLMTracker();
        this.tool = new LiveToolTracker();
        this.turn = new LiveAgentTurnTracker();
    }
    /** Subscribe all three trackers to one runner. Idempotent — calling
     *  twice on the same recorder unsubscribes the prior subscription
     *  first to avoid double-counting.
     *
     *  Adds a wildcard `*` listener that observes runId on EVERY event
     *  (regardless of which tracker subscribes to it) and calls
     *  `clear()` on all three trackers when the runId changes. This
     *  closes the gap where a tracker that never saw events in run 1
     *  would fail to reset in run 2. */
    subscribe(runner) {
        this.unsubscribe();
        // Each tracker observes runId in its own per-event handler. A
        // facade-level wildcard would fire AFTER the per-event handler
        // (dispatcher order: byType → domainWildcards → allWildcards),
        // wiping state the tracker just stored. Per-tracker observation is
        // sufficient: a tracker that stores data necessarily ran its
        // handler, which set lastRunId. A tracker that holds no data
        // doesn't need a reset.
        const offs = [
            this.llm.subscribe(runner),
            this.tool.subscribe(runner),
            this.turn.subscribe(runner),
        ];
        this.active = () => offs.forEach((off) => off());
        return this.active;
    }
    /** Detach all three trackers from the current runner. Idempotent. */
    unsubscribe() {
        if (this.active) {
            this.active();
            this.active = undefined;
        }
    }
    /** Reset transient state across all three trackers. Called by the
     *  executor / consumer between runs. */
    clear() {
        this.llm.clear();
        this.tool.clear();
        this.turn.clear();
    }
    // ── Convenience reads (O(1)) ──────────────────────────────────────
    /** True if any LLM call is currently in flight. */
    isLLMInFlight() {
        return this.llm.isInFlight();
    }
    /** Accumulated partial content of the most-recently started LLM call. */
    getPartialLLM() {
        return this.llm.getLatestPartial();
    }
    /** True if any tool is currently executing. */
    isToolExecuting() {
        return this.tool.isExecuting();
    }
    /** Names of tools currently executing. */
    getExecutingToolNames() {
        return this.tool.getExecutingToolNames();
    }
    /** True if the agent is currently inside a turn. */
    isAgentInTurn() {
        return this.turn.isInTurn();
    }
    /** Current turn index (-1 if not in a turn). */
    getCurrentTurnIndex() {
        return this.turn.getCurrentTurnIndex();
    }
}
/** Convenience factory — same shape as `boundaryRecorder()` /
 *  `topologyRecorder()` / `inOutRecorder()` in footprintjs. */
export function liveStateRecorder() {
    return new LiveStateRecorder();
}
//# sourceMappingURL=LiveStateRecorder.js.map