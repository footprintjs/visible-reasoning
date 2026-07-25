/**
 * BoundaryStateStore<TState> — concrete, composable per-boundary
 * transient state storage.
 *
 * Pattern: COMPOSITION primitive. Concrete class — instantiate with
 *          `new BoundaryStateStore<TState>()` and own it as a field
 *          on your recorder. Replaces the abstract
 *          `BoundaryStateTracker<TState>` base class for the v5
 *          "one purpose per recorder" rule.
 * Role:    "What's the LIVE transient state of every currently-active
 *          boundary?" A boundary is a matched event pair `[start, stop]`
 *          bracketing an interval (e.g., `(llm_start, llm_end)`).
 *          Between the brackets, intermediate events evolve the
 *          boundary's state. On `stop`, the state clears.
 *
 * Algorithmically this is the **DFS bracket-sequence pattern** — the
 * `active` map is the open-brackets stack at any moment.
 *
 * **Lifecycle contract — STRICT:** every `start(key, ...)` call MUST
 * be paired with a `stop(key)` call. Failure to wire stop produces a
 * memory leak: the active map grows without bound.
 *
 * **Concurrency / nesting:** concurrent boundaries (parallel branches
 * with two LLM calls active at once) work correctly — each is keyed
 * independently. Nested boundaries of DIFFERENT KINDS require
 * SEPARATE store instances — one per kind.
 *
 * @example
 * ```typescript
 * import { BoundaryStateStore } from 'footprintjs/trace';
 * import type { CombinedRecorder, EmitEvent } from 'footprintjs';
 *
 * interface LLMLiveState { partial: string; tokens: number; }
 *
 * class LiveLLMTracker implements CombinedRecorder {
 *   readonly id = 'live-llm';
 *   private readonly store = new BoundaryStateStore<LLMLiveState>();
 *
 *   onEmit(event: EmitEvent): void {
 *     if (event.name === 'agentfootprint.stream.llm_start') {
 *       this.store.start(event.runtimeStageId, { partial: '', tokens: 0 });
 *     } else if (event.name === 'agentfootprint.stream.llm_end') {
 *       this.store.stop(event.runtimeStageId);
 *     } else if (event.name === 'agentfootprint.stream.token') {
 *       this.store.update(event.runtimeStageId, (s) => ({
 *         partial: s.partial + (event.payload as { content: string }).content,
 *         tokens: s.tokens + 1,
 *       }));
 *     }
 *   }
 *
 *   isInFlight(): boolean { return this.store.hasActive; }
 *   getPartial(rid: string): string {
 *     return this.store.get(rid)?.partial ?? '';
 *   }
 *
 *   clear() { this.store.clear(); }
 * }
 * ```
 */
import { isDevMode } from '../scope/detectCircular.js';
export class BoundaryStateStore {
    /** Open-brackets stack: key → current transient state. */
    active = new Map();
    /** Per-key count of `update` calls that landed without a matching
     *  active boundary. Drives rate-limited dev-mode warnings so a
     *  stuck loop doesn't spam the console. */
    missedUpdates = new Map();
    /** Optional id for diagnostics — passed to dev-mode warnings so the
     *  source of the leak is easy to find when multiple stores coexist. */
    diagnosticId;
    constructor(diagnosticId = 'boundary-state-store') {
        this.diagnosticId = diagnosticId;
    }
    // ── Mutators ─────────────────────────────────────────────────────────
    /**
     * Open a new boundary with initial transient state. If a boundary
     * with the same `key` is already active, the prior state is
     * overwritten (last-writer-wins). Dev mode warns — usually
     * indicates a missed `stop` upstream.
     */
    start(key, initial) {
        if (this.active.has(key) && isDevMode()) {
            console.warn(`[${this.diagnosticId}] start('${key}') called while an active boundary ` +
                'already exists. Overwriting prior state — likely a missed stop upstream.');
        }
        this.active.set(key, initial);
    }
    /**
     * Evolve the transient state of an active boundary using a pure
     * updater function. Silent no-op if no boundary is active for `key`
     * (defensive against out-of-order events). Dev mode logs a rate-
     * limited warning.
     */
    update(key, updater) {
        const cur = this.active.get(key);
        if (cur === undefined) {
            if (isDevMode()) {
                const n = (this.missedUpdates.get(key) ?? 0) + 1;
                this.missedUpdates.set(key, n);
                if (n === 1) {
                    console.warn(`[${this.diagnosticId}] update('${key}') — no active boundary. Update dropped.`);
                }
                else if (n === 10 || n === 100) {
                    console.warn(`[${this.diagnosticId}] update('${key}') — ${n} dropped updates. Wiring bug?`);
                }
            }
            return;
        }
        this.active.set(key, updater(cur));
    }
    /**
     * Close the boundary identified by `key` and return its FINAL
     * transient state (so the consumer can do any cleanup — e.g., emit
     * a snapshot to a SequenceStore for durable storage).
     */
    stop(key) {
        const final = this.active.get(key);
        this.active.delete(key);
        return final;
    }
    // ── Read (O(1)) ──────────────────────────────────────────────────────
    /** Current transient state of ONE active boundary. `undefined` if no
     *  boundary is active for `key`. */
    get(key) {
        return this.active.get(key);
    }
    /** All currently-active boundaries.
     *
     *  **Type-only readonly:** TypeScript prevents mutation through
     *  `ReadonlyMap`, but a runtime cast or non-TS consumer can mutate
     *  the underlying Map and corrupt state. Don't. */
    getAll() {
        return this.active;
    }
    /** True if any boundary is currently active. O(1). */
    get hasActive() {
        return this.active.size > 0;
    }
    /** Number of currently-active boundaries. O(1). */
    get activeCount() {
        return this.active.size;
    }
    // ── Lifecycle ────────────────────────────────────────────────────────
    /**
     * Reset all transient state. Called by recorder composers from
     * their own `clear()` method, which the executor invokes before
     * each run.
     *
     * Dev mode warns if any boundaries are still active when called —
     * likely indicates a missed `stop` upstream. Leaked keys are listed
     * (truncated to 10) so the wiring bug is findable.
     */
    clear() {
        if (this.active.size > 0 && isDevMode()) {
            const keys = [...this.active.keys()];
            const head = keys.slice(0, 10).join(', ');
            const more = keys.length > 10 ? ` ...(+${keys.length - 10} more)` : '';
            console.warn(`[${this.diagnosticId}] clear() called with ${this.active.size} ` +
                'still-active boundaries. Missed stop? ' +
                `Leaked keys: ${head}${more}`);
        }
        this.active.clear();
        this.missedUpdates.clear();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQm91bmRhcnlTdGF0ZVN0b3JlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9yZWNvcmRlci9Cb3VuZGFyeVN0YXRlU3RvcmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBMkRHO0FBRUgsT0FBTyxFQUFFLFNBQVMsRUFBRSxNQUFNLDRCQUE0QixDQUFDO0FBRXZELE1BQU0sT0FBTyxrQkFBa0I7SUFDN0IsMERBQTBEO0lBQ3pDLE1BQU0sR0FBRyxJQUFJLEdBQUcsRUFBa0IsQ0FBQztJQUVwRDs7K0NBRTJDO0lBQzFCLGFBQWEsR0FBRyxJQUFJLEdBQUcsRUFBa0IsQ0FBQztJQUUzRDsyRUFDdUU7SUFDdEQsWUFBWSxDQUFTO0lBRXRDLFlBQVksWUFBWSxHQUFHLHNCQUFzQjtRQUMvQyxJQUFJLENBQUMsWUFBWSxHQUFHLFlBQVksQ0FBQztJQUNuQyxDQUFDO0lBRUQsd0VBQXdFO0lBRXhFOzs7OztPQUtHO0lBQ0gsS0FBSyxDQUFDLEdBQVcsRUFBRSxPQUFlO1FBQ2hDLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLElBQUksU0FBUyxFQUFFLEVBQUUsQ0FBQztZQUN4QyxPQUFPLENBQUMsSUFBSSxDQUNWLElBQUksSUFBSSxDQUFDLFlBQVksWUFBWSxHQUFHLHFDQUFxQztnQkFDdkUsMEVBQTBFLENBQzdFLENBQUM7UUFDSixDQUFDO1FBQ0QsSUFBSSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsR0FBRyxFQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQ2hDLENBQUM7SUFFRDs7Ozs7T0FLRztJQUNILE1BQU0sQ0FBQyxHQUFXLEVBQUUsT0FBaUM7UUFDbkQsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7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dCI6WyIvKipcbiAqIEJvdW5kYXJ5U3RhdGVTdG9yZTxUU3RhdGU+IOKAlCBjb25jcmV0ZSwgY29tcG9zYWJsZSBwZXItYm91bmRhcnlcbiAqIHRyYW5zaWVudCBzdGF0ZSBzdG9yYWdlLlxuICpcbiAqIFBhdHRlcm46IENPTVBPU0lUSU9OIHByaW1pdGl2ZS4gQ29uY3JldGUgY2xhc3Mg4oCUIGluc3RhbnRpYXRlIHdpdGhcbiAqICAgICAgICAgIGBuZXcgQm91bmRhcnlTdGF0ZVN0b3JlPFRTdGF0ZT4oKWAgYW5kIG93biBpdCBhcyBhIGZpZWxkXG4gKiAgICAgICAgICBvbiB5b3VyIHJlY29yZGVyLiBSZXBsYWNlcyB0aGUgYWJzdHJhY3RcbiAqICAgICAgICAgIGBCb3VuZGFyeVN0YXRlVHJhY2tlcjxUU3RhdGU+YCBiYXNlIGNsYXNzIGZvciB0aGUgdjVcbiAqICAgICAgICAgIFwib25lIHB1cnBvc2UgcGVyIHJlY29yZGVyXCIgcnVsZS5cbiAqIFJvbGU6ICAgIFwiV2hhdCdzIHRoZSBMSVZFIHRyYW5zaWVudCBzdGF0ZSBvZiBldmVyeSBjdXJyZW50bHktYWN0aXZlXG4gKiAgICAgICAgICBib3VuZGFyeT9cIiBBIGJvdW5kYXJ5IGlzIGEgbWF0Y2hlZCBldmVudCBwYWlyIGBbc3RhcnQsIHN0b3BdYFxuICogICAgICAgICAgYnJhY2tldGluZyBhbiBpbnRlcnZhbCAoZS5nLiwgYChsbG1fc3RhcnQsIGxsbV9lbmQpYCkuXG4gKiAgICAgICAgICBCZXR3ZWVuIHRoZSBicmFja2V0cywgaW50ZXJtZWRpYXRlIGV2ZW50cyBldm9sdmUgdGhlXG4gKiAgICAgICAgICBib3VuZGFyeSdzIHN0YXRlLiBPbiBgc3RvcGAsIHRoZSBzdGF0ZSBjbGVhcnMuXG4gKlxuICogQWxnb3JpdGhtaWNhbGx5IHRoaXMgaXMgdGhlICoqREZTIGJyYWNrZXQtc2VxdWVuY2UgcGF0dGVybioqIOKAlCB0aGVcbiAqIGBhY3RpdmVgIG1hcCBpcyB0aGUgb3Blbi1icmFja2V0cyBzdGFjayBhdCBhbnkgbW9tZW50LlxuICpcbiAqICoqTGlmZWN5Y2xlIGNvbnRyYWN0IOKAlCBTVFJJQ1Q6KiogZXZlcnkgYHN0YXJ0KGtleSwgLi4uKWAgY2FsbCBNVVNUXG4gKiBiZSBwYWlyZWQgd2l0aCBhIGBzdG9wKGtleSlgIGNhbGwuIEZhaWx1cmUgdG8gd2lyZSBzdG9wIHByb2R1Y2VzIGFcbiAqIG1lbW9yeSBsZWFrOiB0aGUgYWN0aXZlIG1hcCBncm93cyB3aXRob3V0IGJvdW5kLlxuICpcbiAqICoqQ29uY3VycmVuY3kgLyBuZXN0aW5nOioqIGNvbmN1cnJlbnQgYm91bmRhcmllcyAocGFyYWxsZWwgYnJhbmNoZXNcbiAqIHdpdGggdHdvIExMTSBjYWxscyBhY3RpdmUgYXQgb25jZSkgd29yayBjb3JyZWN0bHkg4oCUIGVhY2ggaXMga2V5ZWRcbiAqIGluZGVwZW5kZW50bHkuIE5lc3RlZCBib3VuZGFyaWVzIG9mIERJRkZFUkVOVCBLSU5EUyByZXF1aXJlXG4gKiBTRVBBUkFURSBzdG9yZSBpbnN0YW5jZXMg4oCUIG9uZSBwZXIga2luZC5cbiAqXG4gKiBAZXhhbXBsZVxuICogYGBgdHlwZXNjcmlwdFxuICogaW1wb3J0IHsgQm91bmRhcnlTdGF0ZVN0b3JlIH0gZnJvbSAnZm9vdHByaW50anMvdHJhY2UnO1xuICogaW1wb3J0IHR5cGUgeyBDb21iaW5lZFJlY29yZGVyLCBFbWl0RXZlbnQgfSBmcm9tICdmb290cHJpbnRqcyc7XG4gKlxuICogaW50ZXJmYWNlIExMTUxpdmVTdGF0ZSB7IHBhcnRpYWw6IHN0cmluZzsgdG9rZW5zOiBudW1iZXI7IH1cbiAqXG4gKiBjbGFzcyBMaXZlTExNVHJhY2tlciBpbXBsZW1lbnRzIENvbWJpbmVkUmVjb3JkZXIge1xuICogICByZWFkb25seSBpZCA9ICdsaXZlLWxsbSc7XG4gKiAgIHByaXZhdGUgcmVhZG9ubHkgc3RvcmUgPSBuZXcgQm91bmRhcnlTdGF0ZVN0b3JlPExMTUxpdmVTdGF0ZT4oKTtcbiAqXG4gKiAgIG9uRW1pdChldmVudDogRW1pdEV2ZW50KTogdm9pZCB7XG4gKiAgICAgaWYgKGV2ZW50Lm5hbWUgPT09ICdhZ2VudGZvb3RwcmludC5zdHJlYW0ubGxtX3N0YXJ0Jykge1xuICogICAgICAgdGhpcy5zdG9yZS5zdGFydChldmVudC5ydW50aW1lU3RhZ2VJZCwgeyBwYXJ0aWFsOiAnJywgdG9rZW5zOiAwIH0pO1xuICogICAgIH0gZWxzZSBpZiAoZXZlbnQubmFtZSA9PT0gJ2FnZW50Zm9vdHByaW50LnN0cmVhbS5sbG1fZW5kJykge1xuICogICAgICAgdGhpcy5zdG9yZS5zdG9wKGV2ZW50LnJ1bnRpbWVTdGFnZUlkKTtcbiAqICAgICB9IGVsc2UgaWYgKGV2ZW50Lm5hbWUgPT09ICdhZ2VudGZvb3RwcmludC5zdHJlYW0udG9rZW4nKSB7XG4gKiAgICAgICB0aGlzLnN0b3JlLnVwZGF0ZShldmVudC5ydW50aW1lU3RhZ2VJZCwgKHMpID0+ICh7XG4gKiAgICAgICAgIHBhcnRpYWw6IHMucGFydGlhbCArIChldmVudC5wYXlsb2FkIGFzIHsgY29udGVudDogc3RyaW5nIH0pLmNvbnRlbnQsXG4gKiAgICAgICAgIHRva2Vuczogcy50b2tlbnMgKyAxLFxuICogICAgICAgfSkpO1xuICogICAgIH1cbiAqICAgfVxuICpcbiAqICAgaXNJbkZsaWdodCgpOiBib29sZWFuIHsgcmV0dXJuIHRoaXMuc3RvcmUuaGFzQWN0aXZlOyB9XG4gKiAgIGdldFBhcnRpYWwocmlkOiBzdHJpbmcpOiBzdHJpbmcge1xuICogICAgIHJldHVybiB0aGlzLnN0b3JlLmdldChyaWQpPy5wYXJ0aWFsID8/ICcnO1xuICogICB9XG4gKlxuICogICBjbGVhcigpIHsgdGhpcy5zdG9yZS5jbGVhcigpOyB9XG4gKiB9XG4gKiBgYGBcbiAqL1xuXG5pbXBvcnQgeyBpc0Rldk1vZGUgfSBmcm9tICcuLi9zY29wZS9kZXRlY3RDaXJjdWxhci5qcyc7XG5cbmV4cG9ydCBjbGFzcyBCb3VuZGFyeVN0YXRlU3RvcmU8VFN0YXRlPiB7XG4gIC8qKiBPcGVuLWJyYWNrZXRzIHN0YWNrOiBrZXkg4oaSIGN1cnJlbnQgdHJhbnNpZW50IHN0YXRlLiAqL1xuICBwcml2YXRlIHJlYWRvbmx5IGFjdGl2ZSA9IG5ldyBNYXA8c3RyaW5nLCBUU3RhdGU+KCk7XG5cbiAgLyoqIFBlci1rZXkgY291bnQgb2YgYHVwZGF0ZWAgY2FsbHMgdGhhdCBsYW5kZWQgd2l0aG91dCBhIG1hdGNoaW5nXG4gICAqICBhY3RpdmUgYm91bmRhcnkuIERyaXZlcyByYXRlLWxpbWl0ZWQgZGV2LW1vZGUgd2FybmluZ3Mgc28gYVxuICAgKiAgc3R1Y2sgbG9vcCBkb2Vzbid0IHNwYW0gdGhlIGNvbnNvbGUuICovXG4gIHByaXZhdGUgcmVhZG9ubHkgbWlzc2VkVXBkYXRlcyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG5cbiAgLyoqIE9wdGlvbmFsIGlkIGZvciBkaWFnbm9zdGljcyDigJQgcGFzc2VkIHRvIGRldi1tb2RlIHdhcm5pbmdzIHNvIHRoZVxuICAgKiAgc291cmNlIG9mIHRoZSBsZWFrIGlzIGVhc3kgdG8gZmluZCB3aGVuIG11bHRpcGxlIHN0b3JlcyBjb2V4aXN0LiAqL1xuICBwcml2YXRlIHJlYWRvbmx5IGRpYWdub3N0aWNJZDogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKGRpYWdub3N0aWNJZCA9ICdib3VuZGFyeS1zdGF0ZS1zdG9yZScpIHtcbiAgICB0aGlzLmRpYWdub3N0aWNJZCA9IGRpYWdub3N0aWNJZDtcbiAgfVxuXG4gIC8vIOKUgOKUgCBNdXRhdG9ycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogT3BlbiBhIG5ldyBib3VuZGFyeSB3aXRoIGluaXRpYWwgdHJhbnNpZW50IHN0YXRlLiBJZiBhIGJvdW5kYXJ5XG4gICAqIHdpdGggdGhlIHNhbWUgYGtleWAgaXMgYWxyZWFkeSBhY3RpdmUsIHRoZSBwcmlvciBzdGF0ZSBpc1xuICAgKiBvdmVyd3JpdHRlbiAobGFzdC13cml0ZXItd2lucykuIERldiBtb2RlIHdhcm5zIOKAlCB1c3VhbGx5XG4gICAqIGluZGljYXRlcyBhIG1pc3NlZCBgc3RvcGAgdXBzdHJlYW0uXG4gICAqL1xuICBzdGFydChrZXk6IHN0cmluZywgaW5pdGlhbDogVFN0YXRlKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuYWN0aXZlLmhhcyhrZXkpICYmIGlzRGV2TW9kZSgpKSB7XG4gICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgIGBbJHt0aGlzLmRpYWdub3N0aWNJZH1dIHN0YXJ0KCcke2tleX0nKSBjYWxsZWQgd2hpbGUgYW4gYWN0aXZlIGJvdW5kYXJ5IGAgK1xuICAgICAgICAgICdhbHJlYWR5IGV4aXN0cy4gT3ZlcndyaXRpbmcgcHJpb3Igc3RhdGUg4oCUIGxpa2VseSBhIG1pc3NlZCBzdG9wIHVwc3RyZWFtLicsXG4gICAgICApO1xuICAgIH1cbiAgICB0aGlzLmFjdGl2ZS5zZXQoa2V5LCBpbml0aWFsKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBFdm9sdmUgdGhlIHRyYW5zaWVudCBzdGF0ZSBvZiBhbiBhY3RpdmUgYm91bmRhcnkgdXNpbmcgYSBwdXJlXG4gICAqIHVwZGF0ZXIgZnVuY3Rpb24uIFNpbGVudCBuby1vcCBpZiBubyBib3VuZGFyeSBpcyBhY3RpdmUgZm9yIGBrZXlgXG4gICAqIChkZWZlbnNpdmUgYWdhaW5zdCBvdXQtb2Ytb3JkZXIgZXZlbnRzKS4gRGV2IG1vZGUgbG9ncyBhIHJhdGUtXG4gICAqIGxpbWl0ZWQgd2FybmluZy5cbiAgICovXG4gIHVwZGF0ZShrZXk6IHN0cmluZywgdXBkYXRlcjogKHByZXY6IFRTdGF0ZSkgPT4gVFN0YXRlKTogdm9pZCB7XG4gICAgY29uc3QgY3VyID0gdGhpcy5hY3RpdmUuZ2V0KGtleSk7XG4gICAgaWYgKGN1ciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAoaXNEZXZNb2RlKCkpIHtcbiAgICAgICAgY29uc3QgbiA9ICh0aGlzLm1pc3NlZFVwZGF0ZXMuZ2V0KGtleSkgPz8gMCkgKyAxO1xuICAgICAgICB0aGlzLm1pc3NlZFVwZGF0ZXMuc2V0KGtleSwgbik7XG4gICAgICAgIGlmIChuID09PSAxKSB7XG4gICAgICAgICAgY29uc29sZS53YXJuKGBbJHt0aGlzLmRpYWdub3N0aWNJZH1dIHVwZGF0ZSgnJHtrZXl9Jykg4oCUIG5vIGFjdGl2ZSBib3VuZGFyeS4gVXBkYXRlIGRyb3BwZWQuYCk7XG4gICAgICAgIH0gZWxzZSBpZiAobiA9PT0gMTAgfHwgbiA9PT0gMTAwKSB7XG4gICAgICAgICAgY29uc29sZS53YXJuKGBbJHt0aGlzLmRpYWdub3N0aWNJZH1dIHVwZGF0ZSgnJHtrZXl9Jykg4oCUICR7bn0gZHJvcHBlZCB1cGRhdGVzLiBXaXJpbmcgYnVnP2ApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuYWN0aXZlLnNldChrZXksIHVwZGF0ZXIoY3VyKSk7XG4gIH1cblxuICAvKipcbiAgICogQ2xvc2UgdGhlIGJvdW5kYXJ5IGlkZW50aWZpZWQgYnkgYGtleWAgYW5kIHJldHVybiBpdHMgRklOQUxcbiAgICogdHJhbnNpZW50IHN0YXRlIChzbyB0aGUgY29uc3VtZXIgY2FuIGRvIGFueSBjbGVhbnVwIOKAlCBlLmcuLCBlbWl0XG4gICAqIGEgc25hcHNob3QgdG8gYSBTZXF1ZW5jZVN0b3JlIGZvciBkdXJhYmxlIHN0b3JhZ2UpLlxuICAgKi9cbiAgc3RvcChrZXk6IHN0cmluZyk6IFRTdGF0ZSB8IHVuZGVmaW5lZCB7XG4gICAgY29uc3QgZmluYWwgPSB0aGlzLmFjdGl2ZS5nZXQoa2V5KTtcbiAgICB0aGlzLmFjdGl2ZS5kZWxldGUoa2V5KTtcbiAgICByZXR1cm4gZmluYWw7XG4gIH1cblxuICAvLyDilIDilIAgUmVhZCAoTygxKSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqIEN1cnJlbnQgdHJhbnNpZW50IHN0YXRlIG9mIE9ORSBhY3RpdmUgYm91bmRhcnkuIGB1bmRlZmluZWRgIGlmIG5vXG4gICAqICBib3VuZGFyeSBpcyBhY3RpdmUgZm9yIGBrZXlgLiAqL1xuICBnZXQoa2V5OiBzdHJpbmcpOiBUU3RhdGUgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0aGlzLmFjdGl2ZS5nZXQoa2V5KTtcbiAgfVxuXG4gIC8qKiBBbGwgY3VycmVudGx5LWFjdGl2ZSBib3VuZGFyaWVzLlxuICAgKlxuICAgKiAgKipUeXBlLW9ubHkgcmVhZG9ubHk6KiogVHlwZVNjcmlwdCBwcmV2ZW50cyBtdXRhdGlvbiB0aHJvdWdoXG4gICAqICBgUmVhZG9ubHlNYXBgLCBidXQgYSBydW50aW1lIGNhc3Qgb3Igbm9uLVRTIGNvbnN1bWVyIGNhbiBtdXRhdGVcbiAgICogIHRoZSB1bmRlcmx5aW5nIE1hcCBhbmQgY29ycnVwdCBzdGF0ZS4gRG9uJ3QuICovXG4gIGdldEFsbCgpOiBSZWFkb25seU1hcDxzdHJpbmcsIFRTdGF0ZT4ge1xuICAgIHJldHVybiB0aGlzLmFjdGl2ZTtcbiAgfVxuXG4gIC8qKiBUcnVlIGlmIGFueSBib3VuZGFyeSBpcyBjdXJyZW50bHkgYWN0aXZlLiBPKDEpLiAqL1xuICBnZXQgaGFzQWN0aXZlKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmFjdGl2ZS5zaXplID4gMDtcbiAgfVxuXG4gIC8qKiBOdW1iZXIgb2YgY3VycmVudGx5LWFjdGl2ZSBib3VuZGFyaWVzLiBPKDEpLiAqL1xuICBnZXQgYWN0aXZlQ291bnQoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5hY3RpdmUuc2l6ZTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBMaWZlY3ljbGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIFJlc2V0IGFsbCB0cmFuc2llbnQgc3RhdGUuIENhbGxlZCBieSByZWNvcmRlciBjb21wb3NlcnMgZnJvbVxuICAgKiB0aGVpciBvd24gYGNsZWFyKClgIG1ldGhvZCwgd2hpY2ggdGhlIGV4ZWN1dG9yIGludm9rZXMgYmVmb3JlXG4gICAqIGVhY2ggcnVuLlxuICAgKlxuICAgKiBEZXYgbW9kZSB3YXJucyBpZiBhbnkgYm91bmRhcmllcyBhcmUgc3RpbGwgYWN0aXZlIHdoZW4gY2FsbGVkIOKAlFxuICAgKiBsaWtlbHkgaW5kaWNhdGVzIGEgbWlzc2VkIGBzdG9wYCB1cHN0cmVhbS4gTGVha2VkIGtleXMgYXJlIGxpc3RlZFxuICAgKiAodHJ1bmNhdGVkIHRvIDEwKSBzbyB0aGUgd2lyaW5nIGJ1ZyBpcyBmaW5kYWJsZS5cbiAgICovXG4gIGNsZWFyKCk6IHZvaWQge1xuICAgIGlmICh0aGlzLmFjdGl2ZS5zaXplID4gMCAmJiBpc0Rldk1vZGUoKSkge1xuICAgICAgY29uc3Qga2V5cyA9IFsuLi50aGlzLmFjdGl2ZS5rZXlzKCldO1xuICAgICAgY29uc3QgaGVhZCA9IGtleXMuc2xpY2UoMCwgMTApLmpvaW4oJywgJyk7XG4gICAgICBjb25zdCBtb3JlID0ga2V5cy5sZW5ndGggPiAxMCA/IGAgLi4uKCske2tleXMubGVuZ3RoIC0gMTB9IG1vcmUpYCA6ICcnO1xuICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICBgWyR7dGhpcy5kaWFnbm9zdGljSWR9XSBjbGVhcigpIGNhbGxlZCB3aXRoICR7dGhpcy5hY3RpdmUuc2l6ZX0gYCArXG4gICAgICAgICAgJ3N0aWxsLWFjdGl2ZSBib3VuZGFyaWVzLiBNaXNzZWQgc3RvcD8gJyArXG4gICAgICAgICAgYExlYWtlZCBrZXlzOiAke2hlYWR9JHttb3JlfWAsXG4gICAgICApO1xuICAgIH1cbiAgICB0aGlzLmFjdGl2ZS5jbGVhcigpO1xuICAgIHRoaXMubWlzc2VkVXBkYXRlcy5jbGVhcigpO1xuICB9XG59XG4iXX0=