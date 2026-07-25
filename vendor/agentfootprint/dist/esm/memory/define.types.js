/**
 * Memory subsystem — public type surface.
 *
 * THE 2D mental model the library teaches:
 *
 *     MEMORY = TYPE × STRATEGY × STORE
 *
 *     TYPE       — what shape of memory you're keeping
 *                  (Episodic messages / Semantic facts / Narrative beats /
 *                   Causal footprintjs snapshots)
 *     STRATEGY   — how to fit content into the next LLM call
 *                  (Window / Budget / Summarize / TopK / Extract / Decay / Hybrid)
 *     STORE      — where the bytes live
 *                  (InMemoryStore / Redis / Postgres / DynamoDB / Vector ...)
 *
 * Strategy is universal — same Window works for Episodic and for Causal.
 * That's why examples are organized by strategy (the discipline) not by
 * type (the shape).
 *
 * Pattern: Single-Source-of-Truth const objects + discriminated union.
 *          Mirrors `src/conventions.ts` (SUBFLOW_IDS, INJECTION_KEYS).
 *          NEVER enums (TS enums emit runtime objects + opacity).
 *          Const-as-const erases at compile time, accepts string literals,
 *          and gives consumers IDE autocomplete + refactor safety.
 *
 * Role:    Layer-1 contract for the memory subsystem. Step 2's
 *          `defineMemory()` factory consumes these to build pipelines;
 *          Step 4's `Agent.memory()` builder mounts the resulting
 *          definitions; Step 5's Causal machinery extends them.
 *
 * Emits:   Indirectly — every memory pipeline emits the unified
 *          `agentfootprint.context.injected` event with `source: 'memory'`
 *          when its read subflow places content into the messages slot.
 *
 * @see ./define.ts          for the `defineMemory()` factory itself
 * @see ../../docs-next      for guides + the 7 strategy examples
 * @see MEMORY.md            for the load-bearing design memory
 */
// ─── Const-objects (SSOT) ───────────────────────────────────────────
/**
 * What shape of memory you're keeping.
 *
 * - `EPISODIC`  — raw conversation messages, replayed on next turn
 * - `SEMANTIC`  — extracted structured facts, deduped on key
 * - `NARRATIVE` — beats / summaries of prior runs (append-only)
 * - `CAUSAL`    — footprintjs execution snapshots, the differentiator
 *                 (replays stored decisions + tool evidence for "why?"
 *                 follow-ups — harvested automatically per run)
 */
export const MEMORY_TYPES = {
    EPISODIC: 'episodic',
    SEMANTIC: 'semantic',
    NARRATIVE: 'narrative',
    CAUSAL: 'causal',
};
/**
 * How content is selected / compressed for the next LLM call.
 *
 * A `WINDOW` strategy on an Episodic store keeps the last N messages; on
 * Semantic / Narrative it keeps the last N facts / beats. NOT universal: the
 * `CAUSAL` type accepts ONLY `TOP_K` — its snapshots are matched semantically
 * against the new query, never by recency, so `buildCausalPipeline` throws on
 * any other strategy kind. Mix and match the non-Causal types.
 */
export const MEMORY_STRATEGIES = {
    WINDOW: 'window',
    BUDGET: 'budget',
    SUMMARIZE: 'summarize',
    TOP_K: 'topK',
    EXTRACT: 'extract',
    DECAY: 'decay',
    HYBRID: 'hybrid',
};
/**
 * When the memory's READ subflow runs.
 *
 * Default `TURN_START` reads memory once per `agent.run()`. Use
 * `EVERY_ITERATION` only when the strategy is sensitive to in-loop tool
 * results — every-iteration multiplies store-latency by iteration-count.
 */
export const MEMORY_TIMING = {
    EVERY_ITERATION: 'every-iteration',
    TURN_START: 'turn-start',
};
/**
 * For Causal memory only — which slice of a footprintjs snapshot to
 * inject. Snapshots can run 100KB+; projecting prevents context blowup.
 *
 * - `DECISIONS` — `decide()`/`select()` evidence only (the "why" chain)
 * - `COMMITS`   — commitLog only (every state write, ordered)
 * - `NARRATIVE` — narrative entries only (human-readable trace)
 * - `FULL`      — entire snapshot (use sparingly)
 */
export const SNAPSHOT_PROJECTIONS = {
    DECISIONS: 'decisions',
    COMMITS: 'commits',
    NARRATIVE: 'narrative',
    FULL: 'full',
};
// ─── Type guards (consumers + recorders) ────────────────────────────
export function isMemoryType(value) {
    return Object.values(MEMORY_TYPES).includes(value);
}
export function isMemoryStrategyKind(value) {
    return Object.values(MEMORY_STRATEGIES).includes(value);
}
export function isMemoryTiming(value) {
    return Object.values(MEMORY_TIMING).includes(value);
}
export function isSnapshotProjection(value) {
    return Object.values(SNAPSHOT_PROJECTIONS).includes(value);
}
// ─── Per-id scope-key convention (multi-memory layering) ────────────
/**
 * Scope-key prefix used when mounting multiple `.memory()` definitions
 * on the same Agent. Each memory writes to `memoryInjection_${id}` so
 * registrations never collide. Formatter merges all keys with this
 * prefix in registration order.
 */
export const MEMORY_INJECTION_KEY_PREFIX = 'memoryInjection_';
export function memoryInjectionKey(id) {
    return `${MEMORY_INJECTION_KEY_PREFIX}${id}`;
}
export function isMemoryInjectionKey(key) {
    return key.startsWith(MEMORY_INJECTION_KEY_PREFIX);
}
//# sourceMappingURL=define.types.js.map