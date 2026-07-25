/**
 * `noopLens()` — default LensStrategy.
 *
 * Pattern: Strategy. Wildcard fallback. Same role as `NoOpCacheStrategy`.
 * Role:    Drops every update. Used when no Lens vendor strategy is
 *          configured AND the consumer hasn't supplied a callback.
 *          Keeps `enable.lens()` callable without args without
 *          throwing — important for the zero-arg HelloWorld pattern.
 *
 * Use when:
 *   - You want the agent to run without a Lens UI (production
 *     server-side, headless eval, batch jobs)
 *   - Tier-1 of compose chains where you want the chain to compile
 *     even if the real Lens strategy is conditional
 *
 * Don't use when: you actually want to see the StepGraph. Use
 * `lens-browser`, `lens-cli`, or `lens-jsonExport` from the
 * vendor-strategy subpaths once they ship in v2.12+.
 */
export function noopLens(opts = {}) {
    return {
        name: 'noop-lens',
        capabilities: { interactive: false, serializable: false },
        renderGraph(update) {
            opts.onUpdate?.(update);
        },
    };
}
//# sourceMappingURL=noopLens.js.map