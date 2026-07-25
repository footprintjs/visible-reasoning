/**
 * `inMemorySinkCost()` — default CostStrategy.
 *
 * Pattern: Strategy. In-process accumulator. Same role as InMemoryStore
 *          for memory-providers.
 * Role:    Tier-1 fallback — accumulate cost ticks in a process-local
 *          array. Consumer reads via `getTicks()` or hooks `onRecord`
 *          for streaming. Vendor-free.
 *
 * Use when:
 *   - Tests / CI ("what cost did this run accrue?")
 *   - Local dev before billing integration
 *   - Tier-1 of compose chains (`compose([inMemorySink(), stripeBilling()])`
 *     so test assertions can read ticks while production also ships)
 *
 * Don't use when: process is long-running with high cost-tick volume —
 * the buffer grows unbounded. Add a `maxTicks` cap (drops oldest) or
 * pair with a streaming strategy (`stripeBilling`, `webhook`).
 */
export function inMemorySinkCost(opts = {}) {
    const buffer = [];
    const cap = opts.maxTicks ?? Infinity;
    return {
        name: 'in-memory-sink',
        capabilities: { streaming: true, enforcement: false },
        recordCost(tick) {
            buffer.push(tick);
            // FIFO eviction when over cap.
            while (buffer.length > cap)
                buffer.shift();
            opts.onRecord?.(tick);
        },
        getTicks() {
            return buffer.slice();
        },
        getTicksCount() {
            return buffer.length;
        },
        getTicksSince(idx) {
            // Clamp negative / out-of-range. `slice` handles bounds.
            return buffer.slice(Math.max(0, idx));
        },
        clear() {
            buffer.length = 0;
        },
    };
}
//# sourceMappingURL=inMemorySinkCost.js.map